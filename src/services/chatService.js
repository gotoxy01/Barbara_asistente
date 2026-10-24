import { config } from '../config.js';
import * as db from '../db.js';
import { getSelfPhone, sendMessage } from '../messenger.js';
import { buildSystemPrompt, generateBarbaraReply, greetingForNow } from './aiService.js';
import { getBcvRate } from './bcvService.js';
import { searchProducts } from './catalogService.js';
import {
  ADDRESS_QUESTION,
  BOLETA_MARKER,
  createOrderTools,
  HOUSE_NUMBER_REMINDER,
  MORE_ITEMS_QUESTION,
  pendingWeighItems,
  renderDeliveryFees,
  renderOrderContext,
  renderWeighAlert,
  renderWeighWaitMessage,
} from './orderService.js';

const WAITING_WEIGHT_REPLY =
  'En cuanto el encargado en caja me confirme el precio, le envío la boleta completa con el total. ¡Un momento por favor! ⏳';

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
 * Envía un mensaje de WhatsApp al asesor (ADVISOR_PHONE). Con whatsapp-web.js, si no hay ADVISOR_PHONE,
 * el aviso llega al chat "Mensajes para mí" del propio teléfono del negocio. Nunca lanza error.
 */
export async function notifyAdvisor(text) {
  const target = config.advisorPhone || getSelfPhone();
  if (!target) return;
  try {
    await sendMessage(target, text);
  } catch (err) {
    console.error('No se pudo avisar al asesor:', err.message);
  }
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

const HAND_OFF_RE = /(consult|ped|pid|solicit|avis)\w*\s+(al|a un|con el)\s+encargado|una persona de nuestro equipo/i;
const HARDWARE_RE = /ferreter|tornill|clavo|llave de paso|tubo|teflon|teflón|pintura|cable|bombillo|cerradura|candado|herramienta|martillo|destornillador|alicate|cemento|silicon|brocha|rodillo|lija|manguera|codo|niple|breaker|enchufe|tomacorriente|interruptor|bisagra|taladro|mecha|cinta aislante/i;
const WEIGH_CLAIM_RE = /pes(e|ar|ado|aje)|balanza/i;

/**
 * Gemini a veces le dice al cliente "ya le consulté al encargado" sin usar la herramienta, y el encargado
 * nunca se entera. Si eso pasa, el sistema anota lo que pidió el cliente y envía la alerta igual.
 */
async function ensureHandOff(aiText, customerText, tools) {
  const { state } = tools;
  if (state.weighed.length || state.consulted.length || state.waitingWeight || state.boleta) return;
  if (!HAND_OFF_RE.test(aiText) || !customerText.trim()) return;
  const producto = customerText.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (HARDWARE_RE.test(customerText)) await tools.execute('consultar_encargado', { producto, tipo: 'ferreteria' });
  else if (WEIGH_CLAIM_RE.test(aiText)) await tools.execute('solicitar_pesaje', { producto, cantidad: '' });
  else await tools.execute('consultar_encargado', { producto, tipo: 'farmacia' });
  console.log(`Bárbara dijo que consultó al encargado sin usar la herramienta: se envió la alerta a caja igualmente.`);
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
    `🔔 *Chat escalado a humano*\n\n` +
    `Cliente: *${name || 'Sin nombre'}*\n` +
    `Teléfono: +${phone}\n` +
    `Último mensaje: "${text}"\n\n` +
    `El bot quedó *pausado* en este chat.\n` +
    `• Responder desde aquí: #r ${phone} su mensaje\n` +
    `• Reactivar a Bárbara: #reanudar ${phone}\n` +
    `• Escribirle directo: https://wa.me/${phone}`
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
    await notify(`💬 *${displayName || '+' + phone}* (+${phone}) escribió en un chat pausado:\n"${text}"\n\nResponder: #r ${phone} su mensaje`);
    return { reply: null, escalated: false, paused: true };
  }

  if (ATTACHMENT_RE.test(text)) {
    const order = db.getActiveOrder(phone);
    await notify(
      `🧾 *Posible comprobante de pago*\n${displayName || 'Cliente'} (+${phone}) envió: ${text}\n` +
      `${order ? `Pedido #${order.id} (${order.status})${order.total_bs ? ` - Total: Bs. ${order.total_bs.toFixed(2)}` : ''}\n` : ''}` +
      'Revise el chat para verificar el pago. Bárbara sigue atendiendo.',
    );
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
      console.log(`[${phone}] Mensaje ajeno a la bodega (proveedor, cobro, spam...): Bárbara no responde.`);
      if (resume) db.addMessage(phone, 'model', SILENT_MARK);
      return { reply: null, escalated: false, paused: false, ignored: true, productContext, model: result.model, tools };
    }
    if (!result.ignore && pendingBefore === 0) await ensureHandOff(result.text, pendingCustomerText(history), tools);
    reply = result.ignore && !tools.state.cartChanged
      ? greetingReply(text, isNewConversation)
      : enforceBusinessName(applyOrderFlow(result.text, tools.state)) || EMPTY_ESCALATION_REPLY;
    if (isNewConversation && !/b[aá]rbara/i.test(reply)) reply = `${INTRO}\n\n${reply}`;
    escalated = result.escalate;
    toolCalls = result.toolCalls;
    model = result.model;
  } catch (error) {
    if (!isGreeting(text)) {
      const failed = await handleAiFailure({ phone, name: displayName, text, error, notify, productContext, resume });
      return { ...failed, tools };
    }
    console.error(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}); se respondió el saludo sin IA.`);
    reply = greetingReply(text, isNewConversation);
  }

  if (resume && reply && !FAILURE_REPLY_RE.test(reply) && !/demora/i.test(reply)) {
    reply = `${RESUME_NOTE}\n\n${reply}`;
  }
  return { reply, escalated, paused: false, productContext, toolCalls, model, tools };
}

async function finishReply({ phone, displayName, text, notify, outcome }) {
  const { reply, escalated, tools } = outcome;
  if (reply) db.addMessage(phone, 'model', reply);

  if (tools?.state.weighed.length || tools?.state.consulted.length) {
    const order = db.getActiveOrder(phone);
    const items = order ? pendingWeighItems(order.items) : [];
    if (items.length) await notify(renderWeighAlert({ phone, name: displayName, items }));
  }

  if (escalated) {
    db.pauseChat(phone);
    await notify(escalationNotice({ name: displayName, phone, text }));
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

  // Mientras el encargado pesa o consulta, el cliente espera: no se le pregunta si desea algo más.
  if (state.weighed.length || state.consulted.length) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    const hardware = state.consulted.some((c) => c.tipo !== 'farmacia');
    const pharmacy = state.consulted.some((c) => c.tipo === 'farmacia');
    const explained = (!state.weighed.length || /balanza/i.test(reply))
      && (!pharmacy || /encargado/i.test(reply))
      && (!hardware || /persona/i.test(reply));
    if (!explained) reply = `${reply}\n\n${renderWeighWaitMessage(state.weighed, state.catalogAdded, state.consulted)}`.trim();
    return reply;
  }
  if (state.waitingWeight) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    if (!/pes(ar|e|ando|aje)|encargado/i.test(reply)) reply = `${reply}\n\n${WAITING_WEIGHT_REPLY}`.trim();
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
  console.error(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}): ${error.hint ?? error.message}`);
  if (!resume && error.retryable) setTimeout(() => resumeOne(phone).catch((err) => console.error(`[${phone}]`, err.message)), 45_000);

  if (config.pauseOnError) {
    db.pauseChat(phone);
    await notify(`${escalationNotice({ name, phone, text })}\n\n⚠️ Motivo: error técnico de la IA. ${error.hint ?? ''}`);
    return { reply: FALLBACK_REPLY, escalated: false, paused: true, productContext, error };
  }

  if (Date.now() - lastTechAlertAt > TECH_ALERT_INTERVAL_MS) {
    lastTechAlertAt = Date.now();
    await notify(
      `⚠️ *Bárbara no puede responder*\n\n${error.hint ?? error.message}\n\n` +
      `Último cliente afectado: *${name || 'Sin nombre'}* (+${phone}): "${text}"\n` +
      `Los chats NO se pausaron; los clientes reciben un aviso para reintentar.`
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
  console.log(`[${phone}] Conversación retomada${sent.model ? ` (${sent.model})` : ''}.`);
}

/** Responde lo pendiente de la última hora: avisos de inconveniente y mensajes que llegaron con Bárbara apagada. */
export async function resumePendingConversations() {
  if (resumeRunning) return;
  resumeRunning = true;
  try {
    const pending = db.listLatestMessagesSince(Date.now() - catchupMs()).filter(needsResume);
    if (pending.length) console.log(`Retomando ${pending.length} conversación(es) pendiente(s) de la última hora.`);
    for (const row of pending) await resumeOne(row.phone);
  } finally {
    resumeRunning = false;
  }
}

/** Al conectar, y cada 3 minutos, retoma lo que quedó sin respuesta real. */
export function startResumeLoop() {
  if (resumeTimer) return;
  setTimeout(() => resumePendingConversations().catch((err) => console.error('No se pudieron retomar las conversaciones:', err.message)), 15_000);
  resumeTimer = setInterval(() => {
    resumePendingConversations().catch((err) => console.error('No se pudieron retomar las conversaciones:', err.message));
  }, 3 * 60 * 1000);
}

/** Registra en el historial un mensaje que un asesor envió manualmente al cliente. */
export function recordAdvisorMessage(phone, text) {
  db.upsertChat(phone, null);
  db.addMessage(phone, 'model', text);
}
