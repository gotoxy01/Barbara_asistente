import { config, isPanelMode } from '../config.js';
import * as db from '../db.js';
import { info, verbose, error as logError } from '../log.js';
import { getChannel, getSelfPhone, outboundRecord, sendMenu, sendMessage } from '../messenger.js';
import { auditBarbaraReply, buildSystemPrompt, generateBarbaraReply, greetingForNow } from './aiService.js';
import { decideEscalation, forcedHandoffReason, replyForEscalation } from './escalationPolicy.js';
import { STOCK_CHECK_REPLY, historyForModel, isGeneralCatalogAsk, isLightTurn, isOnlyGreetingOrControl, replyIfInventedSku, substantiveLines } from './customerText.js';
import { shouldOpenPaymentTicket } from './paymentIntent.js';
import { getBcvRate } from './bcvService.js';
import { catalogCustomerReply, catalogOverviewText, searchProducts } from './catalogService.js';
import { isOperationalTurn } from './orderLifecycle.js';
import { loadProfileSummary } from './orderBook.js';
import { tryOperationalTurn } from './operationalTurn.js';
import { openMainMenu, rememberMenu, takeMenuTurn } from './menuFlow.js';
import { assessFlood, collapseBurst } from './floodControl.js';
import { recordUsage } from './usage.js';
import { renderMenuText } from '../menus.js';
import { abrirTicketPago, physicalTicketKind, solicitarAprobacionRapida } from './operatorConsoleService.js';
import {
  ADDRESS_QUESTION,
  BOLETA_MARKER,
  expandCustomerReply,
  CANCEL_MARKER,
  createOrderTools,
  HOUSE_NUMBER_REMINDER,
  isSoldByWeight,
  shouldOpenScaleTicket,
  moneyAmountMentioned,
  MORE_ITEMS_QUESTION,
  mentionsWeight,
  pendingWeighItems,
  renderDeliveryFees,
  renderOrderContext,
  isShortFollowUp,
  scopeHistoryForTurn,
  renderWeighWaitMessage,
  weightMentionedFor,
} from './orderService.js';
import { closeTicketsForPhone } from './ticketStore.js';

/** Cuántos mensajes del hilo se usan para seguimiento de producto (usuario + Bárbara). */
const THREAD_FOLLOW_MSGS = 4;

const WAITING_WEIGHT_REPLY =
  '¡Claro! Déjeme pesarlo aquí en un momentico para darle el monto exacto y ya le aviso. ⚖️';

const INTRO = 'Le saluda *Bárbara*, asistente virtual de *Abasto Los Cuchos*.';

const FALLBACK_REPLY =
  'Disculpe, en este momento presentamos un inconveniente técnico. 🙏\n\nUno de nuestros asesores de *Abasto Los Cuchos* le atenderá en breve.';

const RETRY_LATER_REPLY =
  'Disculpe, en este momento presentamos un inconveniente técnico y no pude procesar su mensaje. 🙏\n\nPor favor, intente nuevamente en unos minutos. *Abasto Los Cuchos* agradece su paciencia.';

const FAILURE_REPLY_RE = /inconveniente técnico/i;
const SILENT_MARK = '[sin respuesta]';
const RESUME_NOTE = 'Disculpe la demora. Ya retomo su solicitud.';
const phoneTail = new Map();

/** Una sola respuesta a la vez por cliente, también cuando el retome coincide con un mensaje nuevo. */
function lockPhone(phone, task) {
  const prev = phoneTail.get(phone) ?? Promise.resolve();
  const run = prev.then(task, task);
  phoneTail.set(phone, run.then(() => {}, () => {}));
  return run;
}

const TECH_ALERT_INTERVAL_MS = 30 * 60 * 1000;
const BILLING_ALERT_INTERVAL_MS = 10 * 60 * 1000;
const techAlerts = new Map();

/** Un mismo fallo de facturación no vuelve a avisar al asesor hasta que pasen 10 minutos. */
export function shouldNotifyTech(kind, now = Date.now()) {
  const wait = kind === 'billing' ? BILLING_ALERT_INTERVAL_MS : TECH_ALERT_INTERVAL_MS;
  const previous = techAlerts.get(kind) || 0;
  if (now - previous < wait) return false;
  techAlerts.set(kind, now);
  return true;
}

const EMPTY_ESCALATION_REPLY =
  'Gracias por su mensaje. En breve uno de nuestros asesores de *Abasto Los Cuchos* le atenderá personalmente. 🙌';

/**
 * Avisos al equipo. Por defecto van al CRM (buzón). WhatsApp ("Mensajes para mí") solo si
 * options.whatsapp === true — para no saturar el chat consigo mismo cuando hay muchas solicitudes.
 *
 * @param {string} text
 * @param {{ kind?: string, phone?: string, title?: string, whatsapp?: boolean, skipCrm?: boolean }} [options]
 */
export async function notifyAdvisor(text, options = {}) {
  const kind = options.kind || 'info';
  const phone = options.phone || null;
  const title = options.title || kindLabel(kind);
  if (!options.skipCrm) {
    try {
      await db.addAdvisorAlert({ kind, phone, title, body: text });
    } catch (err) {
      logError('No se pudo guardar la alerta del CRM:', err.message);
    }
  }

  if (!options.whatsapp || isPanelMode()) return;
  const target = config.advisorPhone || getSelfPhone();
  if (!target) return;
  try {
    await sendMessage(target, text);
  } catch (err) {
    logError('No se pudo avisar por WhatsApp al asesor:', err.message);
  }
}

function kindLabel(kind) {
  return ({
    weigh: 'Atención en caja',
    escalate: 'Chat escalado',
    payment: 'Comprobante de pago',
    paused: 'Chat pausado',
    tech: 'Falla técnica',
    order: 'Nuevo pedido',
    logistica: 'Entrega',
    info: 'Aviso',
  })[kind] || 'Aviso';
}

function isPauseExpired(chat) {
  if (!chat) return false;
  if (chat.status === 'SPECIALIST') {
    const hours = config.specialistAutoResumeHours;
    if (!(hours > 0) || !chat.paused_at) return false;
    return Date.now() - chat.paused_at >= hours * 3600 * 1000;
  }
  if (!chat.paused) return false;
  if (chat.paused_until) return Date.now() >= chat.paused_until;
  return false;
}

const GROUP_PREFIX_RE = /^\[Mensaje escrito en el grupo [^\]]*\]\s*/;

function cleanMsgContent(content) {
  return String(content || '')
    .replace(GROUP_PREFIX_RE, '')
    .replace(/\[PEDIDO_CANCELADO\]/g, '')
    .replace(/\[sin respuesta\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lo que escribió el cliente desde la última respuesta de Bárbara (sin marcas del sistema). */
function pendingCustomerText(history) {
  const lastReply = history.map((m) => m.role).lastIndexOf('model');
  return history.slice(lastReply + 1)
    .filter((m) => m.role === 'user')
    .map((m) => cleanMsgContent(m.content))
    .filter(Boolean)
    .join('\n');
}

/** Últimos N mensajes del hilo (user + model) para seguimiento de tema. */
function recentThread(history, n = THREAD_FOLLOW_MSGS) {
  if (!Array.isArray(history) || !history.length) return [];
  return history
    .slice(-Math.max(n, 1))
    .map((m) => ({ role: m.role, content: cleanMsgContent(m.content) }))
    .filter((m) => m.content);
}

/**
 * Texto del cliente enriquecido con el hilo reciente cuando es un seguimiento
 * ("¿hay de la pequeña?" → sigue hablando del chocolate / producto anterior).
 */
function customerTextWithThread(history, fallback = '') {
  const pending = pendingCustomerText(history) || fallback;
  const thread = recentThread(history, THREAD_FOLLOW_MSGS);
  if (!pending) return fallback;
  if (!isShortFollowUp(pending) && pending.length > 40) return pending;
  if (thread.length < 2) return pending;
  const resumen = thread
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bárbara'}: ${m.content}`)
    .join('\n');
  return `${pending}\n\n[Hilo reciente — continúa este tema, no cambie de producto:\n${resumen}]`;
}

const WEIGH_CLAIM_RE = /pes(e|ar|ado|aje)|balanza|momentico.*peso|pesarlo aqu[ií]/i;
/** Pedido / cantidad (no solo “¿hay tomates?”). */
const ORDER_INTENT_RE =
  /(quiero|quer[ií]a|dame|d[eé]me|pasa(?:me)?|m[aá]nd(?:ame|e)|necesito|anot[ae]|agreg[aue]|pedi[rdó]?|pedir|unos?|unas?|trozo|pedazo|bandeja|pieza|\d)/i;

/**
 * Abre pesaje en balanza si el cliente pidió productos por kilo sin kilos ni monto fijo,
 * aunque Gemini solo haya cotizado el precio y no haya llamado la herramienta.
 */
async function ensureHandOff(aiText, customerText, tools) {
  const { state } = tools;
  if (state.weighed.length || state.consulted.length || state.waitingWeight || state.boleta) return;
  const text = String(customerText || '').trim();
  if (!text) return;

  const found = await searchProducts(text, {});
  const products = found.products || [];
  const weighables = products.filter((p) => shouldOpenScaleTicket(text, p, products));
  if (weighables.length !== 1) return;

  const primary = weighables[0];
  if (!primary?.nombre || !isSoldByWeight(primary)) return;

  if (WEIGH_CLAIM_RE.test(aiText)) {
    // Solo el nombre de catálogo — nunca la frase completa del cliente.
    await tools.execute('solicitar_pesaje', { producto: primary.nombre, cantidad: 'al gusto / por pesar' });
    verbose(`Bárbara habló de pesaje sin herramienta: balanza para ${primary.nombre}.`);
    return;
  }

  // Cotización suelta ("¿hay tomates?", "precio del tomate") → no ticket.
  if (moneyAmountMentioned(text)) return;
  if (/^(hay|tienen|tiene|cuesta|precio|cu[aá]nto|me\s+cobra)\b/i.test(text)) return;

  // "tomates", "dame tomates", "2 tomates" → balanza. "1 kilo de tomate" → no.
  const shortProductAsk = text.length <= 48;
  if (!ORDER_INTENT_RE.test(text) && !shortProductAsk) return;
  if (mentionsWeight(text) && !/\b(unidad|unidades|pieza|trozo|pedazo|bandeja|unos|unas)\b/i.test(text)) {
    return;
  }

  const qtyMatch = text.match(/\b(\d+)\b/);
  const cantidad = qtyMatch ? `${qtyMatch[1]} ${Number(qtyMatch[1]) === 1 ? 'unidad' : 'unidades'}` : 'al gusto / por pesar';
  await tools.execute('solicitar_pesaje', { producto: primary.nombre, cantidad });
  verbose(`Pedido de ${primary.nombre} sin peso fijo: se abrió ticket de balanza.`);
}

const GREETING_RE = /^(hola+|ola|buen[oa]s?|buen d[ií]a|saludos|hey|epa|qu[eé] tal|bendici[oó]n|good|hi)\b/i;

/** Un saludo siempre se responde, aunque la IA lo haya tomado por un mensaje ajeno a la bodega. */
function isGreeting(text) {
  const clean = text.replace(GROUP_PREFIX_RE, '').replace(/^[^\p{L}]+/u, '').trim();
  return clean.length <= 60 && GREETING_RE.test(clean);
}

function greetingName(name) {
  const full = String(name || '').trim();
  if (!full || /^cliente\b/i.test(full)) return '';
  const first = full.split(/\s+/)[0];
  if (/^(cliente|prueba|test|usuario)$/i.test(first)) return '';
  return first;
}

function greetingReply(text, isNewConversation, name) {
  const group = text.match(/^\[Mensaje escrito en el grupo «?"?([^»"\];]+)/)?.[1];
  const viaGroup = group ? ` Le escribo por privado por su mensaje en el grupo *${group.trim()}*.` : '';
  const who = greetingName(name);
  const hello = greetingForNow();
  const lead = who ? `${hello.replace(/!$/, '')}, ${who}!` : hello;
  return isNewConversation || group
    ? `${lead} ${INTRO}${viaGroup}\n\n¿En qué le puedo ayudar hoy? 😊`
    : `¡Hola${who ? `, ${who}` : ''}! ¿En qué le puedo ayudar? 😊`;
}

/**
 * Busca productos con seguimiento del hilo (mín. últimos 4 mensajes).
 * Evita que "¿hay de la pequeña?" se interprete como otro producto (ej. bolsa de hielo)
 * cuando el cliente venía hablando de samba/chocolate u otra cosa.
 */
async function buildProductContext(history, bcv, currentText = '') {
  if (isOnlyGreetingOrControl(currentText)) {
    return {
      type: 'none',
      terms: [],
      products: [],
      retrievalScore: null,
      general: false,
      text: 'CONSULTA GENERAL (saludo o comando): no mencione productos ni diga que no hay.',
    };
  }
  if (isOperationalTurn(currentText)) {
    return {
      type: 'none',
      terms: [],
      products: [],
      retrievalScore: null,
      operational: true,
      text: 'TURNO DE PEDIDO (dirección, pago, ubicación o cierre). No busque productos ni escale por el catálogo.',
    };
  }
  if (isGeneralCatalogAsk(currentText)) {
    return {
      type: 'none',
      terms: [],
      products: [],
      retrievalScore: null,
      general: true,
      text: catalogOverviewText(),
    };
  }
  const current = substantiveLines(currentText);
  const earlier = substantiveLines(
    (history || [])
      .filter((message) => message.role === 'user')
      .map((message) => cleanMsgContent(message.content))
      .join('\n'),
  );
  const followUp = current.length === 1 && isShortFollowUp(current[0]);
  const query = (followUp ? [...earlier.slice(-4), ...current] : current).join('\n')
    || earlier.slice(-3).join('\n');
  if (!query.trim()) {
    return {
      type: 'none',
      terms: [],
      products: [],
      retrievalScore: null,
      text: 'CONSULTA GENERAL (sin un producto específico): no mencione productos.',
    };
  }
  const started = Date.now();
  const result = await searchProducts(query, { bcv });
  verbose(`Búsqueda de catálogo en ${Date.now() - started} ms (${result.type}, ${result.products?.length || 0} productos).`);
  return result;
}

function summarizeTurns(history) {
  return (history || [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Bárbara'}: ${cleanMsgContent(m.content)}`)
    .filter((line) => !line.endsWith(':'))
    .join('\n')
    .slice(0, 1200);
}

/**
 * Procesa un mensaje entrante de un cliente de principio a fin.
 * @param {{ phone: string, name?: string, text: string }} message
 * @param {{ notify?: (text: string) => Promise<void> }} [options]  permite reemplazar el aviso al asesor (p. ej. en pruebas)
 * @returns {Promise<{ reply: string|null, escalated: boolean, paused: boolean, productContext?: string, error?: Error }>}
 *   reply = null cuando el chat está en manos de un asesor y el bot no debe responder.
 */
export function handleCustomerMessage(message, options) {
  return lockPhone(message.phone, () => handleCustomerMessageNow(message, options));
}

async function judgeFlood(phone, text) {
  const now = Date.now();
  const block = await db.getChatBlock(phone);
  const [countMinute, countDay, recent] = await Promise.all([
    db.countUserMessagesSince(phone, now - 60_000),
    db.countUserMessagesSince(phone, now - 86_400_000),
    db.recentUserMessages(phone, 2),
  ]);
  const previous = recent[1];
  return assessFlood({
    now,
    countMinute,
    countDay,
    limitPerMinute: config.flood.perMinute,
    limitPerDay: config.flood.perDay,
    blockMs: config.flood.blockMinutes * 60_000,
    blockedUntil: block?.blockedUntil || null,
    manual: block?.reason === 'manual',
    warnedAt: block?.warnedAt || null,
    notifiedAt: block?.notifiedAt || null,
    text,
    previousText: previous?.content || '',
    previousAt: previous?.created_at || 0,
  });
}

async function handleCustomerMessageNow({ phone, name, text, wamid = null }, { notify = notifyAdvisor, onWait = null, test = false } = {}) {
  text = collapseBurst(text);
  if (!text) return { reply: null, escalated: false, paused: false, ignored: true };
  let chat = await db.upsertChat(phone, name);
  await db.touchCustomerWindow(phone);
  chat = await db.getChat(phone);
  if (isPauseExpired(chat)) {
    await db.resumeChat(phone);
    chat = await db.getChat(phone);
  }

  const lastReplyAt = await db.getLastModelMessageAt(phone);
  const isNewConversation = !lastReplyAt || Date.now() - lastReplyAt > config.newConversationHours * 3600 * 1000;
  const alreadyStored = wamid && await db.hasInbound(wamid);
  if (alreadyStored) {
    const latest = await db.getLatestMessage(phone);
    if (latest?.role === 'model') return { reply: null, escalated: false, paused: false, duplicate: true };
  } else {
    const durantePausa = chat.status === 'SPECIALIST' || chat.paused === 1 || chat.paused === true;
    const raw = {
      ...(durantePausa ? { durante_pausa: 'si' } : {}),
      ...(test ? { prueba: 'si' } : {}),
    };
    await db.addMessage(phone, 'user', text, wamid, Object.keys(raw).length ? { raw } : {});
    if (!test) await recordUsage({ phone, kind: 'inbound' });
  }
  const displayName = chat.name || name;

  const flood = test ? { action: 'allow' } : await judgeFlood(phone, text);
  if (flood.action !== 'allow') {
    if (flood.persist) {
      await db.saveChatBlock(phone, {
        blockedUntil: flood.blockedUntil ?? null,
        warnedAt: flood.warnedAt ?? null,
        notifiedAt: flood.notify ? Date.now() : null,
        reason: flood.reason || 'flood',
      });
    }
    if (flood.notify) {
      await notify(
        `+${phone} mandó muchos mensajes seguidos. Quedó bloqueado ${config.flood.blockMinutes} min. Para soltarlo: #desbloquear ${phone}`,
        { kind: 'flood', phone, title: 'Posible spam', whatsapp: true },
      );
    }
    return { reply: flood.reply, escalated: false, paused: flood.action !== 'ignore', flood: true };
  }

  if (chat.status === 'LOGISTICA') {
    await notify(
      `${displayName || '+' + phone} (+${phone}) escribió mientras se coordina la entrega:\n"${text}"`,
      { kind: 'logistica', phone, title: 'Mensaje en logística', whatsapp: true },
    );
    return { reply: null, escalated: false, paused: true };
  }

  if (chat.status === 'SPECIALIST' || chat.paused) {
    const modo = chat.status === 'SPECIALIST' ? 'en modo especialista' : 'pausado';
    await notify(
      `${displayName || '+' + phone} (+${phone}) escribió con el chat ${modo}:\n"${text}"\n\nResponda desde el CRM. En especialista, use #reanudar para que Bárbara vuelva.`,
      { kind: 'paused', phone, title: chat.status === 'SPECIALIST' ? 'Mensaje para el especialista' : 'Mensaje en chat pausado', whatsapp: false },
    );
    return { reply: null, escalated: false, paused: true };
  }

  const payOrder = await db.getActiveOrder(phone);
  if (shouldOpenPaymentTicket({ text, history: await db.getHistory(phone), order: payOrder })) {
    const note = payOrder
      ? `Pedido #${payOrder.id} (${payOrder.status})${payOrder.total_bs ? ` · Bs. ${payOrder.total_bs.toFixed(2)}` : ''}`
      : text.slice(0, 80);
    await abrirTicketPago({ phone, name: displayName, note });
  }

  // Conversación nueva (hueco largo) o tras cancelaciones: no arrastrar carrito/notas viejas.
  if (isNewConversation) {
    await resetCustomerOrderSession(phone, { quiet: true });
  }

  const history = historyForModel(await db.getHistory(phone, config.historyLimit, config.newConversationHours));
  const outcome = await produceReply({ phone, displayName, text, history, isNewConversation, notify, onWait, test });
  return finishReply({ phone, displayName, text, notify, outcome });
}

/** Limpia carrito abierto + notas de caja de este chat (pedidos recibidos en cocina no se tocan). */
async function resetCustomerOrderSession(phone, { quiet = false } = {}) {
  const current = await db.getActiveOrder(phone);
  if (current?.items?.length || db.orderIsProtected(current)) return;
  const cleared = await db.clearActiveCarts(phone);
  closeTicketsForPhone(phone);
  await db.startFreshActiveOrder(phone);
  if (!quiet && cleared.length) {
    verbose(`[${phone}] Sesión de pedido reiniciada (${cleared.length} carrito(s) viejo(s) descartados).`);
  }
}

/**
 * Genera la respuesta a partir del historial ya guardado. `resume` no vuelve a guardar el mensaje del cliente.
 */
async function produceReply({ phone, displayName, text, history, isNewConversation, notify, onWait = null, resume = false, test = false }) {
  history = historyForModel(history);
  const turnStarted = Date.now();
  const timings = [];
  const closeTimings = () => {
    if (!timings.some((item) => item.step === 'total')) timings.push({ step: 'total', ms: Date.now() - turnStarted });
    return timings;
  };
  const lap = (step, startedAt) => {
    const ms = Date.now() - startedAt;
    timings.push({ step, ms });
    verbose(`${step}: ${ms} ms`);
    return Date.now();
  };
  let mark = turnStarted;
  const scopedHistory = scopeHistoryForTurn(history, isNewConversation);
  const menuTurn = await takeMenuTurn(phone, text, null, onWait);
  if (menuTurn?.stockCheck?.length) {
    await notify(
      [
        `Verificar stock: *${menuTurn.stockCheck.join(', ')}*`,
        `Cliente: ${displayName || 'Sin nombre'} (+${phone})`,
        `Si lo hay: #hay ${phone} <producto> <precio USD>`,
        `Si no lo hay: #nohay ${phone} <producto>`,
      ].join('\n'),
      { kind: 'weigh', phone, title: `Verificar stock: ${menuTurn.stockCheck[0]}`, whatsapp: true },
    );
  }
  if (menuTurn?.reply) {
    timings.push({ step: 'menú', ms: Date.now() - turnStarted });
    timings.push({ step: 'Gemini', ms: 0, skipped: true });
    return {
      reply: menuTurn.reply,
      menu: menuTurn.menu || null,
      escalated: Boolean(menuTurn.escalated),
      paused: false,
      productContext: 'Menú, sin modelo.',
      timings: closeTimings(),
      summary: summarizeTurns(scopedHistory),
      motivo: menuTurn.escalated ? 'El cliente pidió un asesor' : null,
    };
  }
  if (isOnlyGreetingOrControl(text) || isGreeting(text)) {
    const opened = openMainMenu();
    const greet = greetingReply(text, isNewConversation, displayName);
    opened.menu = { ...opened.menu, body: `${greet}\n\n${opened.menu.body}` };
    rememberMenu(phone, opened);
    timings.push({ step: 'Gemini', ms: 0, skipped: true });
    timings.push({ step: 'auditor', ms: 0, skipped: true });
    return {
      reply: renderMenuText(opened.menu),
      menu: opened.menu,
      escalated: false,
      paused: false,
      productContext: 'Saludo, sin modelo.',
      timings: closeTimings(),
      summary: summarizeTurns(scopedHistory),
    };
  }
  if (isGeneralCatalogAsk(text)) {
    timings.push({ step: 'Gemini', ms: 0, skipped: true });
    timings.push({ step: 'auditor', ms: 0, skipped: true });
    return {
      reply: catalogCustomerReply(),
      escalated: false,
      paused: false,
      productContext: 'Catálogo general, sin búsqueda ni modelo.',
      timings: closeTimings(),
      summary: summarizeTurns(scopedHistory),
    };
  }

  const bcv = await getBcvRate();
  mark = lap('tasa', mark);
  const lightTurn = isLightTurn(text);
  const customerProfile = await loadProfileSummary(phone, displayName).catch((err) => {
    verbose(`No se pudo leer la memoria del cliente: ${err.message}`);
    return '';
  });

  const fast = await tryOperationalTurn({ phone, name: displayName, text, bcv, notify });
  if (fast?.reply) {
    lap('operación', mark);
    timings.push({ step: 'Gemini', ms: 0, skipped: true });
    timings.push({ step: 'auditor', ms: 0, skipped: true });
    return {
      reply: enforceBusinessName(fast.reply),
      escalated: false,
      paused: false,
      productContext: 'Turno de pedido, sin búsqueda de catálogo.',
      toolCalls: fast.toolCalls || [],
      model: null,
      tools: null,
      timings: closeTimings(),
      summary: summarizeTurns(scopedHistory),
    };
  }

  const products = await buildProductContext(scopedHistory, bcv, text);
  mark = lap('catálogo', mark);
  const productContext = lightTurn ? products.text : `${products.text}\n${renderDeliveryFees(bcv)}`;
  const customerText = customerTextWithThread(scopedHistory, text);
  const tools = createOrderTools({ phone, name: displayName, bcv, notify, customerText });
  const systemPrompt = buildSystemPrompt({
    name: displayName, phone, productContext, orderContext: await renderOrderContext(phone, bcv), isNewConversation, customerProfile,
  });

  let reply;
  let escalated;
  let toolCalls;
  let model;
  let salesMeta = null;
  const pendingBefore = pendingWeighItems((await db.getActiveOrder(phone))?.items ?? []).length;
  try {
    verbose(`Contexto listo en ${Date.now() - turnStarted} ms. Llamando a Gemini${lightTurn ? ' (sin herramientas ni auditor)' : ''}.`);
    if (onWait) await onWait('modelo');
    const result = await generateBarbaraReply(systemPrompt, scopedHistory, lightTurn ? undefined : tools);
    if (!test && result.usage?.calls) {
      await recordUsage({
        phone, kind: 'gemini', calls: result.usage.calls,
        inputTokens: result.usage.input, outputTokens: result.usage.output,
      });
    }
    mark = lap('Gemini', mark);
    const cartCommitted = Boolean(tools.state.boleta || tools.state.addressSaved);
    const decision = decideEscalation({
      confianza: result.confianza ?? 0,
      requiereEspecialista: result.escalate,
      motivoEscalado: result.motivo,
      customerText: text,
      catalogType: products.type,
      catalogTerms: products.terms,
      retrievalScore: products.retrievalScore,
      generalCatalog: products.general === true,
      threshold: config.confidenceThreshold,
      cartCommitted,
    });
    if ((result.ignore || decision.ignore) && !tools.state.cartChanged && !isGreeting(text)) {
      verbose(`[${phone}] Mensaje ajeno a la bodega: Bárbara no responde.`);
      if (resume) await db.addMessage(phone, 'model', SILENT_MARK);
      return { reply: null, escalated: false, paused: false, ignored: true, productContext, model: result.model, tools, timings: closeTimings(), summary: summarizeTurns(scopedHistory) };
    }
    if (!decision.escalate && !result.ignore && !decision.ignore && !forcedHandoffReason(text) && pendingBefore === 0) {
      await ensureHandOff(result.text, customerText, tools);
    }
    if (decision.escalate) {
      reply = enforceBusinessName(replyForEscalation(result.text));
      escalated = true;
    } else {
      reply = result.ignore && !tools.state.cartChanged
        ? greetingReply(text, isNewConversation)
        : enforceBusinessName(stripPrematurePaymentPitch(applyOrderFlow(result.text, tools.state), tools.state)) || EMPTY_ESCALATION_REPLY;
      if (isNewConversation && !/b[aá]rbara/i.test(reply)) reply = `${INTRO}\n\n${reply}`;
      escalated = false;
    }
    toolCalls = result.toolCalls;
    if ((toolCalls || []).some((call) => call.result?.verificacion)) {
      decision.escalate = false;
      decision.reason = null;
      if (!String(reply || '').includes('verificando')) {
        reply = [STOCK_CHECK_REPLY, reply].filter(Boolean).join('\n\n');
      }
    }
    const checked = replyIfInventedSku(reply, toolCalls);
    if (checked) {
      reply = checked;
      escalated = false;
      decision.reason = null;
    }
    model = result.model;
    salesMeta = {
      producto: result.producto || null,
      sku: result.sku || null,
      motivo: decision.reason,
      confianza: decision.confianza,
    };
  } catch (error) {
    if (!isGreeting(text)) {
      const failed = await handleAiFailure({ phone, name: displayName, text, error, notify, productContext, resume });
      return { ...failed, tools, timings: closeTimings(), summary: summarizeTurns(scopedHistory) };
    }
    logError(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}); se respondió el saludo sin IA.`);
    reply = greetingReply(text, isNewConversation);
  }

  if (resume && reply && !FAILURE_REPLY_RE.test(reply) && !/demora/i.test(reply)) {
    reply = `${RESUME_NOTE}\n\n${reply}`;
  }

  if (lightTurn) {
    timings.push({ step: 'auditor', ms: 0, skipped: true });
  } else if (reply && !escalated && shouldAuditReply(reply, tools?.state, productContext)) {
    const orderContext = await renderOrderContext(phone, bcv);
    const audited = await runAuditor({
      phone,
      mensaje_cliente: customerText,
      datos_bd: `${productContext}\n\nPedido actual (ÚNICO válido):\n${orderContext}\n\nRegla: no mencione ni confirme productos que no estén en el mensaje del cliente ni en este pedido actual.`,
      borrador_barbara: reply,
      isNewConversation,
      resume,
    });
    const currentOrder = await db.getActiveOrder(phone);
    if (audited && auditorInventedScale(reply, audited, currentOrder?.items || [])) {
      verbose(`[${phone}] Auditor descartado: inventó un pesaje que no está en el pedido.`);
    } else if (audited) reply = audited;
    lap('auditor', mark);
  } else if (!lightTurn) {
    timings.push({ step: 'auditor', ms: 0, skipped: true });
  }

  return {
    reply,
    escalated,
    paused: false,
    productContext,
    toolCalls,
    model,
    tools,
    producto: salesMeta?.producto ?? null,
    sku: salesMeta?.sku ?? null,
    motivo: salesMeta?.motivo ?? null,
    confianza: salesMeta?.confianza ?? null,
    timings: closeTimings(),
    summary: summarizeTurns(scopedHistory),
  };
}

/** El auditor no puede inventar un pesaje si el pedido no tiene ese pendiente. */
export function auditorInventedScale(draft, corrected, items = []) {
  const scale = /pes(ar|ando|aje)|balanza|momentico/i;
  const pendingScale = (items || []).some((item) => item && item.precio == null && (item.pesable || item.verificacion));
  return scale.test(String(corrected || '')) && !pendingScale && !scale.test(String(draft || ''));
}

/** No auditar plantillas del sistema (boleta, dirección, fallas) ni mensajes vacíos. */
function shouldAuditReply(reply, state = {}, productContext = '') {
  if (!config.auditor.enabled) return false;
  if (!reply || FAILURE_REPLY_RE.test(reply)) return false;
  if (state.boleta || state.addressSaved) return false;
  const amounts = String(reply).match(/\d+[.,]\d{2}/g) || [];
  if (!amounts.length) return false;
  // Si el monto ya salió de la base, no hace falta una segunda llamada al modelo.
  return amounts.some((amount) => !productContext.includes(amount) && !productContext.includes(amount.replace(',', '.')));
}

/**
 * Pasa el borrador por el auditor. Si Gemini falla o el JSON es inválido, se conserva el original.
 * Tras una corrección se reaplican intro / nota de demora / nombre del negocio.
 */
async function runAuditor({ phone, mensaje_cliente, datos_bd, borrador_barbara, isNewConversation, resume }) {
  const hadIntro = /b[aá]rbara/i.test(borrador_barbara);
  const hadResume = /demora/i.test(borrador_barbara);
  try {
    const result = await auditBarbaraReply({ mensaje_cliente, datos_bd, borrador_barbara });
    if (result.usage?.calls) {
      await recordUsage({
        phone, kind: 'gemini', calls: result.usage.calls,
        inputTokens: result.usage.input, outputTokens: result.usage.output,
      });
    }
    let final = enforceBusinessName(result.mensaje_final);
    if (!final) return null;

    if (result.aprobado) {
      verbose(`[${phone}] Auditor: aprobado`);
      return final;
    }

    verbose(`[${phone}] Auditor: corregido — ${result.motivo_fallo || 'sin detalle'}`);
    if (isNewConversation && hadIntro && !/b[aá]rbara/i.test(final)) {
      final = `${INTRO}\n\n${final}`;
    }
    if (resume && hadResume && !/demora/i.test(final)) {
      final = `${RESUME_NOTE}\n\n${final}`;
    }
    return enforceBusinessName(final);
  } catch (err) {
    verbose(`[${phone}] Auditor omitido (${err.kind || 'error'}): ${err.message}`);
    return null;
  }
}

async function finishReply({ phone, displayName, text, notify, outcome }) {
  let { reply, escalated, tools } = outcome;
  const order = await db.getActiveOrder(phone);
  const kind = physicalTicketKind({ reply, tools });

  // Solo excepciones físicas → ficha telegráfica + botones 1-tap. El cliente ya recibió tono de mostrador.
  if (!escalated && kind === 'pesaje') {
    const allPending = order ? pendingWeighItems(order.items) : [];
    // Solo lo pedido/pesado en ESTE turno (no pendientes viejos de otro pedido).
    const weighed = tools?.state?.weighed || [];
    let pending = allPending;
    if (weighed.length) {
      const filtered = allPending.filter((p) => weighed.some((w) => {
        const hay = String(p.nombre || p.detalle || '').toLowerCase();
        const needle = String(w).toLowerCase();
        return hay.includes(needle) || needle.includes(hay.split('(')[0].trim());
      }));
      if (filtered.length) pending = filtered;
    }
    if (pending.length) {
      await solicitarAprobacionRapida({
        phone,
        name: displayName,
        borradorRespuesta: reply || '',
        items: pending,
        montoTotalUSD: order?.total_usd ?? null,
        montoTotalBs: order?.total_bs ?? null,
        motivo: 'pesaje',
      });
    }
  } else if (!escalated && kind === 'flete') {
    const { holdReply } = await solicitarAprobacionRapida({
      phone,
      name: displayName,
      borradorRespuesta: reply || '',
      items: [{ nombre: 'Flete', detalle: text?.slice(0, 80) || 'zona a confirmar' }],
      motivo: 'flete',
    });
    if (holdReply && (!reply || !/env[ií]o|flete|delivery/i.test(reply))) reply = holdReply;
  }

  // Historial: guardar marca de cancelación; WhatsApp: sin la marca.
  // El guardado ocurre después de que WhatsApp confirme el envío (completeCustomerTurn).
  if (reply && tools?.state?.canceled && !reply.includes(CANCEL_MARKER)) {
    reply = `${reply.trim()}\n${CANCEL_MARKER}`;
  }
  const historyText = reply;
  const forCustomer = reply
    ? reply.split(CANCEL_MARKER).join('').replace(/\n{3,}/g, '\n\n').trim()
    : null;

  const handoff = escalated ? {
    name: displayName || null,
    producto: outcome.producto || null,
    sku: outcome.sku || null,
    motivo: outcome.motivo || 'Escalado a especialista',
    confianza: outcome.confianza,
    summary: outcome.summary || '',
  } : null;

  return {
    reply: forCustomer,
    historyText,
    escalated,
    handoff,
    paused: outcome.paused || escalated,
    productContext: outcome.productContext,
    toolCalls: outcome.toolCalls,
    model: outcome.model,
    confianza: outcome.confianza ?? null,
    timings: outcome.timings || [],
    menu: outcome.menu || null,
  };
}

/**
 * Envía la respuesta y, solo si WhatsApp la acepta, la guarda y aplica el pase a especialista.
 */
export async function completeCustomerTurn(phone, result) {
  if (result?.menu && getChannel() === 'cloud') {
    await sendMenu(phone, result.menu);
  }
  if (result?.reply) {
    const sent = result?.menu && getChannel() === 'cloud'
      ? { mode: 'text' }
      : await sendMessage(phone, result.reply);
    let stored = outboundRecord(sent, result.historyText || result.reply);
    if (result.historyText?.includes(CANCEL_MARKER) && !stored.includes(CANCEL_MARKER)) {
      stored = `${stored}\n${CANCEL_MARKER}`;
    }
    await db.addMessage(phone, 'model', stored, null, {
      confidence: result.confianza,
      raw: result.handoff ? { producto: result.handoff.producto, motivo: result.handoff.motivo } : null,
    });
    await recordUsage({ phone, kind: sent?.mode === 'template' ? 'template' : 'outbound_bot' });
  }
  if (result?.escalated && result.handoff) {
    await finalizeHandoff({ phone, name: result.handoff.name, handoff: result.handoff });
  }
  return result;
}

/** Deja el chat en SPECIALIST y avisa al asesor con el resumen del caso. */
export async function finalizeHandoff({ phone, name, handoff, notify = notifyAdvisor }) {
  await db.setSpecialist(phone);
  const body = [
    `Cliente: ${name || 'Sin nombre'} (+${phone})`,
    `Producto tentativo: ${handoff?.producto || 'no identificado'}${handoff?.sku ? ` · SKU ${handoff.sku}` : ''}`,
    `Motivo: ${handoff?.motivo || 'sin detalle'}`,
    handoff?.confianza != null ? `Confianza: ${handoff.confianza}%` : null,
    `Resumen:\n${handoff?.summary || '(sin resumen)'}`,
    'Bárbara quedó en modo especialista y no responderá hasta #reanudar.',
  ].filter(Boolean).join('\n');
  await notify(body, { kind: 'escalate', phone, title: 'Chat con especialista', whatsapp: false });
  if (notify === notifyAdvisor) {
    await notifyAdvisor(
      `Escalado · +${phone}${name ? ` · ${name}` : ''}\n${handoff?.motivo || ''}\nReanude en el CRM o con #reanudar`,
      { kind: 'escalate', phone, whatsapp: true, skipCrm: true },
    );
  }
}

/**
 * Ajustes finales de formato para WhatsApp:
 * - el negocio se llama "Abasto Los Cuchos" (el historial antiguo puede contener el nombre anterior);
 * - WhatsApp usa *un* asterisco para negrita; "**texto**" se vería con los asteriscos.
 */
function enforceBusinessName(text) {
  return text
    .replace(/Comercializadora\s+Los\s+Cuchos/gi, 'Abasto Los Cuchos')
    .replace(/Comercializadora/gi, 'Abasto')
    .replace(/\*\*(.+?)\*\*/g, '*$1*');
}

/** Quita el recordatorio de medios de pago si Gemini lo metió antes de cerrar el pedido. */
function stripPrematurePaymentPitch(text, state = {}) {
  if (state.boleta || state.addressSaved) return text;
  return text
    .replace(/\n*(?:aceptamos|recibimos|medios?\s+de\s+pago)[^\n]*(?:pago\s*m[oó]vil|transferencia|efectivo)[^\n]*/gi, '')
    .replace(/\n*📲\s*\*?Datos para Pago M[oó]vil:?\*?(?:\n•[^\n]*)*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Garantiza el flujo de pedido aunque la IA se desvíe:
 * - la boleta siempre es la calculada por el sistema (nunca montos escritos por la IA);
 * - tras la boleta siempre se pide la dirección;
 * - tras agregar/quitar productos siempre se pregunta si desea algo más.
 */
function applyOrderFlow(text, state) {
  let reply = expandCustomerReply(text, state);

  if (state.boleta) return reply;

  reply = reply.split(BOLETA_MARKER).join('').trim()
    .replace(/¿[^¿?]*(?:sería|seria) todo(?: por hoy)?\?\s*(?:🛒)?/gi, MORE_ITEMS_QUESTION);

  if (state.missingHouseNumber && !state.addressSaved) {
    if (!/n[uú]mero de casa/i.test(reply)) reply = `${reply}\n\n${HOUSE_NUMBER_REMINDER}`.trim();
    return reply;
  }

  // Mientras se pesa en balanza, el cliente espera: tono de mostrador, sin "¿algo más?".
  if (state.weighed.length || state.consulted.length) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    const explained = /momentico|pes(ar|e|arlo)|balanza|mostrador|verificar rapidito/i.test(reply);
    if (!explained) reply = `${reply}\n\n${renderWeighWaitMessage(state.weighed, state.catalogAdded, state.consulted)}`.trim();
    return reply;
  }
  if (state.waitingWeight) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    if (!/momentico|pes(ar|e|arlo)|balanza/i.test(reply)) reply = `${reply}\n\n${WAITING_WEIGHT_REPLY}`.trim();
    return reply;
  }

  if (state.cartChanged && !state.addressSaved && !/desea agregar algo m[aá]s/i.test(reply)) {
    reply = `${reply}\n\n${MORE_ITEMS_QUESTION}`;
  }
  return expandCustomerReply(reply, state);
}

/**
 * Falla técnica de Gemini (sin créditos, clave inválida, caída de Google...).
 * Por defecto NO pausa el chat: el cliente recibe un aviso para reintentar y el asesor
 * recibe como máximo una alerta técnica cada 30 minutos.
 */
async function handleAiFailure({ phone, name, text, error, notify, productContext, resume = false }) {
  logError(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}): ${error.hint ?? error.message}`);
  if (!resume && error.retryable) setTimeout(() => resumeOne(phone).catch((err) => logError(`[${phone}]`, err.message)), 45_000);

  if (config.pauseOnError) {
    await db.setSpecialist(phone);
    await notify(`Cliente: ${name || 'Sin nombre'} (+${phone})\nÚltimo mensaje: "${text}"\n\n⚠️ Motivo: error técnico de la IA. ${error.hint ?? ''}`, {
      kind: 'tech', phone, title: 'Falla técnica', whatsapp: false,
    });
    return { reply: FALLBACK_REPLY, escalated: false, paused: true, productContext, error };
  }

  const alertKind = error.kind === 'billing' ? 'billing' : 'tech';
  if (shouldNotifyTech(alertKind)) {
    await notify(
      `${error.hint ?? error.message}\nÚltimo cliente: ${name || 'Sin nombre'} (+${phone}): "${text}"`,
      { kind: 'tech', phone, title: alertKind === 'billing' ? 'Gemini sin créditos' : 'Bárbara no pudo responder', whatsapp: false },
    );
  }
  if (resume && FAILURE_REPLY_RE.test((await db.getLatestMessage(phone))?.content ?? '')) {
    return { reply: null, escalated: false, paused: false, productContext, error };
  }
  return { reply: RETRY_LATER_REPLY, escalated: false, paused: false, productContext, error };
}

const catchupMs = () => config.catchupHours * 3600 * 1000;
let resumeRunning = false;
let resumeTimer = null;

function needsResume(message) {
  if (!message || message.content === SILENT_MARK) return false;
  return message.role === 'user' || FAILURE_REPLY_RE.test(message.content);
}

/** Vuelve a generar la respuesta de un chat que se quedó en el aviso de falla o sin contestar. No reenvía el aviso. */
function resumeOne(phone) {
  return lockPhone(phone, () => resumeOneNow(phone));
}

async function resumeOneNow(phone) {
  const latest = await db.getLatestMessage(phone);
  if (!needsResume(latest) || Date.now() - latest.created_at > catchupMs()) return;

  let chat = await db.getChat(phone);
  if (chat?.paused) {
    if (!isPauseExpired(chat)) return;
    await db.resumeChat(phone);
    chat = await db.getChat(phone);
  }

  const history = (await db.getHistory(phone, config.historyLimit, config.newConversationHours)).filter((m) => !FAILURE_REPLY_RE.test(m.content));
  const text = pendingCustomerText(history);
  if (!text.trim()) return;
  const lastReplyAt = await db.getLastModelMessageAt(phone);
  const isNewConversation = !lastReplyAt || Date.now() - lastReplyAt > config.newConversationHours * 3600 * 1000;
  if (isNewConversation) await resetCustomerOrderSession(phone, { quiet: true });
  const outcome = await produceReply({
    phone, displayName: chat?.name, text, history, isNewConversation, notify: notifyAdvisor, resume: true,
  });
  const finished = await finishReply({ phone, displayName: chat?.name, text, notify: notifyAdvisor, outcome });
  if (!finished.reply && !finished.escalated) return;
  await completeCustomerTurn(phone, finished);
  if (finished.reply) info(`[${phone}] Conversación retomada${finished.model ? ` (${finished.model})` : ''}.`);
}

/** Responde lo pendiente de la última hora: avisos de inconveniente y mensajes que llegaron con Bárbara apagada. */
export async function resumePendingConversations() {
  if (resumeRunning) return;
  resumeRunning = true;
  try {
    const pending = (await db.listLatestMessagesSince(Date.now() - catchupMs())).filter(needsResume);
    if (pending.length) info(`Retomando ${pending.length} conversación(es) pendiente(s) de la última hora.`);
    for (const row of pending) await resumeOne(row.phone);
  } finally {
    resumeRunning = false;
  }
}

/** Al conectar, y cada 3 minutos, retoma lo que quedó sin respuesta real. */
export function startResumeLoop() {
  if (resumeTimer) return;
  setTimeout(() => resumePendingConversations().catch((err) => logError('No se pudieron retomar las conversaciones:', err.message)), 15_000);
  resumeTimer = setInterval(() => {
    resumePendingConversations().catch((err) => logError('No se pudieron retomar las conversaciones:', err.message));
  }, 3 * 60 * 1000);
}

/** Registra en el historial un mensaje que un asesor envió manualmente al cliente. */
export async function recordAdvisorMessage(phone, text) {
  await db.upsertChat(phone, null);
  await db.addMessage(phone, 'model', text);
}
