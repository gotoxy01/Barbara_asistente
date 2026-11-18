import { config } from '../config.js';
import * as db from '../db.js';
import { info, verbose, error as logError } from '../log.js';
import { getSelfPhone, sendMessage } from '../messenger.js';
import { auditBarbaraReply, buildSystemPrompt, generateBarbaraReply, greetingForNow } from './aiService.js';
import { getBcvRate } from './bcvService.js';
import { searchProducts } from './catalogService.js';
import { abrirTicketPago, physicalTicketKind, solicitarAprobacionRapida } from './operatorConsoleService.js';
import {
  ADDRESS_QUESTION,
  BOLETA_MARKER,
  createOrderTools,
  HOUSE_NUMBER_REMINDER,
  isSoldByWeight,
  moneyAmountMentioned,
  MORE_ITEMS_QUESTION,
  mentionsWeight,
  pendingWeighItems,
  renderDeliveryFees,
  renderOrderContext,
  renderWeighWaitMessage,
  weightMentionedFor,
} from './orderService.js';

const WAITING_WEIGHT_REPLY =
  '¡Claro! Déjeme pesarlo aquí en un momentico para darle el monto exacto y ya le aviso. ⚖️';

const ATTACHMENT_RE = /^\[El cliente adjuntó (una imagen|un documento)/;

const INTRO = 'Le saluda *Bárbara*, asistente virtual de *Abasto Los Cuchos*. 🙏';

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
let lastTechAlertAt = 0;

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
      db.addAdvisorAlert({ kind, phone, title, body: text });
    } catch (err) {
      logError('No se pudo guardar la alerta del CRM:', err.message);
    }
  }

  if (!options.whatsapp) return;
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
    info: 'Aviso',
  })[kind] || 'Aviso';
}

function isPauseExpired(chat) {
  if (!chat.paused) return false;
  if (chat.paused_until) return Date.now() >= chat.paused_until;
  if (!chat.paused_at || config.pauseHours <= 0) return false;
  return Date.now() - chat.paused_at > config.pauseHours * 3600 * 1000;
}

const GROUP_PREFIX_RE = /^\[Mensaje escrito en el grupo [^\]]*\]\s*/;

/** Lo que escribió el cliente desde la última respuesta de Bárbara (sin marcas del sistema). */
function pendingCustomerText(history) {
  const lastReply = history.map((m) => m.role).lastIndexOf('model');
  return history.slice(lastReply + 1)
    .filter((m) => m.role === 'user')
    .map((m) => m.content.replace(GROUP_PREFIX_RE, ''))
    .join('\n');
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

  if (WEIGH_CLAIM_RE.test(aiText)) {
    await tools.execute('solicitar_pesaje', { producto: text.slice(0, 120), cantidad: '' });
    verbose('Bárbara habló de pesaje sin herramienta: se abrió solicitud de balanza.');
    return;
  }

  // Cotización suelta ("¿hay tomates?", "precio del tomate") → no ticket.
  if (moneyAmountMentioned(text)) return;
  if (/^(hay|tienen|tiene|cuesta|precio|cu[aá]nto|me\s+cobra)\b/i.test(text)) return;

  const found = searchProducts(text, {});
  const weighables = (found.products || []).filter((p) => isSoldByWeight(p));
  if (!weighables.length) return;

  // "tomates", "dame tomates", "2 tomates" → balanza. "1 kilo de tomate" → no.
  const shortProductAsk = text.length <= 48;
  if (!ORDER_INTENT_RE.test(text) && !shortProductAsk) return;
  if (mentionsWeight(text) && !/\b(unidad|unidades|pieza|trozo|pedazo|bandeja|unos|unas)\b/i.test(text)) {
    return;
  }

  const needsScale = weighables.filter((p) => !weightMentionedFor(p.nombre, text));
  const targets = needsScale.length ? needsScale : weighables;
  const primary = targets.find((p) => /^(tomate|pl[aá]tano|cebolla|aguacate|lim[oó]n|papa|yuca|piment[oó]n|ajo|cilantro|lechuga)$/i.test(p.nombre))
    || targets[0];
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

function greetingReply(text, isNewConversation) {
  const group = text.match(/^\[Mensaje escrito en el grupo «?"?([^»"\];]+)/)?.[1];
  const viaGroup = group ? ` Le escribo por privado por su mensaje en el grupo *${group.trim()}*.` : '';
  return isNewConversation || group
    ? `${greetingForNow()} ${INTRO}${viaGroup}\n\n¿En qué le puedo ayudar hoy? 😊`
    : '¡Hola! ¿En qué le puedo ayudar? 😊';
}

/**
 * Busca productos para todos los mensajes del cliente que Bárbara aún no ha respondido
 * (p. ej. preguntas enviadas mientras el chat estaba pausado o varias seguidas).
 * Si ninguno nombra un producto (ej. "¿y el de 1 kilo?"), se combina con el último mensaje respondido.
 */
function buildProductContext(history, bcv) {
  const lastReply = history.map((m) => m.role).lastIndexOf('model');
  // Los adjuntos llegan como descripciones del sistema ("[El cliente adjuntó...]"), no como consultas.
  const pending = history
    .slice(lastReply + 1)
    .filter((m) => m.role === 'user' && !m.content.startsWith('[El cliente'))
    .map((m) => m.content.replace(GROUP_PREFIX_RE, ''))
    .slice(-5);

  let result = searchProducts(pending, { bcv });

  if (result.type === 'none' && result.terms.length === 0 && pending.length) {
    const previous = history.slice(0, lastReply + 1).reverse().find((m) => m.role === 'user');
    if (previous) {
      const retry = searchProducts(`${previous.content.replace(GROUP_PREFIX_RE, '')} ${pending.join(' ')}`, { bcv });
      if (retry.type === 'matches') result = retry;
    }
  }
  return result;
}

function escalationNotice({ name, phone, text }) {
  return (
    `Cliente: ${name || 'Sin nombre'} (+${phone})\n` +
    `Último mensaje: "${text}"\n` +
    'Bárbara quedó pausada. Responda desde el CRM o con #r.'
  );
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

async function handleCustomerMessageNow({ phone, name, text }, { notify = notifyAdvisor } = {}) {
  let chat = db.upsertChat(phone, name);
  if (isPauseExpired(chat)) {
    db.resumeChat(phone);
    chat = db.getChat(phone);
  }

  const lastReplyAt = db.getLastModelMessageAt(phone);
  const isNewConversation = !lastReplyAt || Date.now() - lastReplyAt > config.newConversationHours * 3600 * 1000;
  db.addMessage(phone, 'user', text);
  const displayName = chat.name || name;

  if (chat.paused) {
    await notify(
      `${displayName || '+' + phone} (+${phone}) escribió con el chat pausado:\n"${text}"\n\nResponda desde el CRM.`,
      { kind: 'paused', phone, title: 'Mensaje en chat pausado', whatsapp: false },
    );
    return { reply: null, escalated: false, paused: true };
  }

  if (ATTACHMENT_RE.test(text)) {
    const order = db.getActiveOrder(phone);
    const note = order
      ? `Pedido #${order.id} (${order.status})${order.total_bs ? ` · Bs. ${order.total_bs.toFixed(2)}` : ''}`
      : text.slice(0, 80);
    await abrirTicketPago({ phone, name: displayName, note });
  }

  const history = db.getHistory(phone);
  const outcome = await produceReply({ phone, displayName, text, history, isNewConversation, notify });
  return finishReply({ phone, displayName, text, notify, outcome });
}

/**
 * Genera la respuesta a partir del historial ya guardado. `resume` no vuelve a guardar el mensaje del cliente.
 */
async function produceReply({ phone, displayName, text, history, isNewConversation, notify, resume = false }) {
  const bcv = await getBcvRate();
  const products = buildProductContext(history, bcv);
  const productContext = `${products.text}\n${renderDeliveryFees(bcv)}`;
  const tools = createOrderTools({ phone, name: displayName, bcv, notify, customerText: pendingCustomerText(history) });
  const systemPrompt = buildSystemPrompt({
    name: displayName, phone, productContext, orderContext: renderOrderContext(phone, bcv), isNewConversation,
  });

  let reply;
  let escalated;
  let toolCalls;
  let model;
  const pendingBefore = pendingWeighItems(db.getActiveOrder(phone)?.items ?? []).length;
  try {
    const result = await generateBarbaraReply(systemPrompt, history, tools);
    if (result.ignore && !tools.state.cartChanged && !isGreeting(text)) {
      verbose(`[${phone}] Mensaje ajeno a la bodega: Bárbara no responde.`);
      if (resume) db.addMessage(phone, 'model', SILENT_MARK);
      return { reply: null, escalated: false, paused: false, ignored: true, productContext, model: result.model, tools };
    }
    if (!result.ignore && pendingBefore === 0) await ensureHandOff(result.text, pendingCustomerText(history), tools);
    reply = result.ignore && !tools.state.cartChanged
      ? greetingReply(text, isNewConversation)
      : enforceBusinessName(stripPrematurePaymentPitch(applyOrderFlow(result.text, tools.state), tools.state)) || EMPTY_ESCALATION_REPLY;
    if (isNewConversation && !/b[aá]rbara/i.test(reply)) reply = `${INTRO}\n\n${reply}`;
    escalated = result.escalate;
    toolCalls = result.toolCalls;
    model = result.model;
  } catch (error) {
    if (!isGreeting(text)) {
      const failed = await handleAiFailure({ phone, name: displayName, text, error, notify, productContext, resume });
      return { ...failed, tools };
    }
    logError(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}); se respondió el saludo sin IA.`);
    reply = greetingReply(text, isNewConversation);
  }

  if (resume && reply && !FAILURE_REPLY_RE.test(reply) && !/demora/i.test(reply)) {
    reply = `${RESUME_NOTE}\n\n${reply}`;
  }

  if (reply && shouldAuditReply(reply, tools?.state)) {
    const orderContext = renderOrderContext(phone, bcv);
    const audited = await runAuditor({
      phone,
      mensaje_cliente: pendingCustomerText(history) || text,
      datos_bd: `${productContext}\n\nPedido actual:\n${orderContext}`,
      borrador_barbara: reply,
      isNewConversation,
      resume,
    });
    if (audited) reply = audited;
  }

  return { reply, escalated, paused: false, productContext, toolCalls, model, tools };
}

/** No auditar plantillas del sistema (boleta, dirección, fallas) ni mensajes vacíos. */
function shouldAuditReply(reply, state = {}) {
  if (!config.auditor.enabled) return false;
  if (!reply || FAILURE_REPLY_RE.test(reply)) return false;
  if (state.boleta || state.addressSaved) return false;
  return true;
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
  const order = db.getActiveOrder(phone);
  const kind = physicalTicketKind({ reply, tools });

  // Solo excepciones físicas → ficha telegráfica + botones 1-tap. El cliente ya recibió tono de mostrador.
  if (!escalated && kind === 'pesaje') {
    const pending = order ? pendingWeighItems(order.items) : [];
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

  if (reply) db.addMessage(phone, 'model', reply);

  if (escalated) {
    db.pauseChat(phone);
    await notify(escalationNotice({ name: displayName, phone, text }), {
      kind: 'escalate', phone, title: 'Chat escalado', whatsapp: false,
    });
    await notifyAdvisor(
      `🚨 Escalado · +${phone}${displayName ? ` · ${displayName}` : ''}\nResponda en el CRM`,
      { kind: 'escalate', phone, whatsapp: true, skipCrm: true },
    );
  }

  return { reply, escalated, paused: outcome.paused || escalated, productContext: outcome.productContext, toolCalls: outcome.toolCalls, model: outcome.model };
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
  let reply = text;

  if (state.boleta) {
    const boleta = state.boletaForCustomer();
    reply = reply.includes(BOLETA_MARKER)
      ? reply.replace(BOLETA_MARKER, boleta)
      : `${boleta}\n\n${ADDRESS_QUESTION}`;
    if (!reply.includes(ADDRESS_QUESTION)) reply = `${reply}\n\n${ADDRESS_QUESTION}`;
    return reply;
  }

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

  if (state.cartChanged && !state.addressSaved && !reply.includes(MORE_ITEMS_QUESTION)) {
    reply = `${reply}\n\n${MORE_ITEMS_QUESTION}`;
  }
  return reply;
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
    db.pauseChat(phone);
    await notify(`${escalationNotice({ name, phone, text })}\n\n⚠️ Motivo: error técnico de la IA. ${error.hint ?? ''}`, {
      kind: 'tech', phone, title: 'Falla técnica', whatsapp: false,
    });
    return { reply: FALLBACK_REPLY, escalated: false, paused: true, productContext, error };
  }

  if (Date.now() - lastTechAlertAt > TECH_ALERT_INTERVAL_MS) {
    lastTechAlertAt = Date.now();
    await notify(
      `${error.hint ?? error.message}\nÚltimo cliente: ${name || 'Sin nombre'} (+${phone}): "${text}"`,
      { kind: 'tech', phone, title: 'Bárbara no pudo responder', whatsapp: false },
    );
  }
  if (resume && FAILURE_REPLY_RE.test(db.getLatestMessage(phone)?.content ?? '')) {
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
  const latest = db.getLatestMessage(phone);
  if (!needsResume(latest) || Date.now() - latest.created_at > catchupMs()) return;

  let chat = db.getChat(phone);
  if (chat?.paused) {
    if (!isPauseExpired(chat)) return;
    db.resumeChat(phone);
    chat = db.getChat(phone);
  }

  const history = db.getHistory(phone).filter((m) => !FAILURE_REPLY_RE.test(m.content));
  const text = pendingCustomerText(history);
  if (!text.trim()) return;
  const lastReplyAt = db.getLastModelMessageAt(phone);
  const isNewConversation = !lastReplyAt || Date.now() - lastReplyAt > config.newConversationHours * 3600 * 1000;
  const outcome = await produceReply({
    phone, displayName: chat?.name, text, history, isNewConversation, notify: notifyAdvisor, resume: true,
  });
  const sent = await finishReply({ phone, displayName: chat?.name, text, notify: notifyAdvisor, outcome });
  if (!sent.reply) return;
  await sendMessage(phone, sent.reply);
  info(`[${phone}] Conversación retomada${sent.model ? ` (${sent.model})` : ''}.`);
}

/** Responde lo pendiente de la última hora: avisos de inconveniente y mensajes que llegaron con Bárbara apagada. */
export async function resumePendingConversations() {
  if (resumeRunning) return;
  resumeRunning = true;
  try {
    const pending = db.listLatestMessagesSince(Date.now() - catchupMs()).filter(needsResume);
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
export function recordAdvisorMessage(phone, text) {
  db.upsertChat(phone, null);
  db.addMessage(phone, 'model', text);
}
