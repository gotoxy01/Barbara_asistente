import { config } from '../config.js';
import * as db from '../db.js';
import { getSelfPhone, sendMessage } from '../messenger.js';
import { buildSystemPrompt, generateBarbaraReply } from './aiService.js';
import { getBcvRate } from './bcvService.js';
import { searchProducts } from './catalogService.js';
import {
  ADDRESS_QUESTION,
  BOLETA_MARKER,
  createOrderTools,
  MORE_ITEMS_QUESTION,
  pendingWeighItems,
  renderDeliveryFees,
  renderOrderContext,
  renderWeighAlert,
  renderWeighWaitMessage,
} from './orderService.js';

const WAITING_WEIGHT_REPLY =
  'En cuanto el encargado termine de pesar, le envío la boleta completa con el total. ¡Un momento por favor! ⚖️';

const ATTACHMENT_RE = /^\[El cliente adjuntó (una imagen|un documento)/;

const INTRO = 'Le saluda *Bárbara*, asistente virtual de *Abasto Los Cuchos*. 🙏';

const FALLBACK_REPLY =
  'Disculpe, en este momento presentamos un inconveniente técnico. 🙏\n\nUno de nuestros asesores de *Abasto Los Cuchos* le atenderá en breve.';

const RETRY_LATER_REPLY =
  'Disculpe, en este momento presentamos un inconveniente técnico y no pude procesar su mensaje. 🙏\n\nPor favor, intente nuevamente en unos minutos. *Abasto Los Cuchos* agradece su paciencia.';

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
    .map((m) => m.content)
    .slice(-5);

  let result = searchProducts(pending, { bcv });

  if (result.type === 'none' && result.terms.length === 0 && pending.length) {
    const previous = history.slice(0, lastReply + 1).reverse().find((m) => m.role === 'user');
    if (previous) {
      const retry = searchProducts(`${previous.content} ${pending.join(' ')}`, { bcv });
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
export async function handleCustomerMessage({ phone, name, text }, { notify = notifyAdvisor } = {}) {
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
  const bcv = await getBcvRate();
  const products = buildProductContext(history, bcv);
  const productContext = `${products.text}\n${renderDeliveryFees(bcv)}`;
  const tools = createOrderTools({ phone, name: displayName, bcv, notify });
  const systemPrompt = buildSystemPrompt({
    name: displayName, phone, productContext, orderContext: renderOrderContext(phone, bcv), isNewConversation,
  });

  let reply;
  let escalated;
  let toolCalls;
  let model;
  try {
    const result = await generateBarbaraReply(systemPrompt, history, tools);
    reply = enforceBusinessName(applyOrderFlow(result.text, tools.state)) || EMPTY_ESCALATION_REPLY;
    if (isNewConversation && !/b[aá]rbara/i.test(reply)) reply = `${INTRO}\n\n${reply}`;
    escalated = result.escalate;
    toolCalls = result.toolCalls;
    model = result.model;
  } catch (error) {
    return handleAiFailure({ phone, name: displayName, text, error, notify, productContext });
  }

  db.addMessage(phone, 'model', reply);

  if (tools.state.weighed.length) {
    const order = db.getActiveOrder(phone);
    const details = order ? pendingWeighItems(order.items).map((i) => i.detalle) : [];
    if (details.length) await notify(renderWeighAlert({ phone, name: displayName, details }));
  }

  if (escalated) {
    db.pauseChat(phone);
    await notify(escalationNotice({ name: displayName, phone, text }));
  }

  return { reply, escalated, paused: escalated, productContext, toolCalls, model };
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

  // Mientras el encargado pesa, el cliente espera: no se le pregunta si desea algo más.
  if (state.weighed.length) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    if (!/balanza/i.test(reply)) reply = `${reply}\n\n${renderWeighWaitMessage(state.weighed, state.catalogAdded)}`.trim();
    return reply;
  }
  if (state.waitingWeight) {
    reply = reply.split(MORE_ITEMS_QUESTION).join('').trim();
    if (!/pes(ar|e|ando|aje)/i.test(reply)) reply = `${reply}\n\n${WAITING_WEIGHT_REPLY}`.trim();
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
async function handleAiFailure({ phone, name, text, error, notify, productContext }) {
  console.error(`[${phone}] Gemini falló (${error.kind ?? 'unknown'} ${error.status ?? ''}): ${error.hint ?? error.message}`);

  if (config.pauseOnError) {
    db.addMessage(phone, 'model', FALLBACK_REPLY);
    db.pauseChat(phone);
    await notify(`${escalationNotice({ name, phone, text })}\n\n⚠️ Motivo: error técnico de la IA. ${error.hint ?? ''}`);
    return { reply: FALLBACK_REPLY, escalated: true, paused: true, productContext, error };
  }

  if (Date.now() - lastTechAlertAt > TECH_ALERT_INTERVAL_MS) {
    lastTechAlertAt = Date.now();
    await notify(
      `⚠️ *Bárbara no puede responder*\n\n${error.hint ?? error.message}\n\n` +
      `Último cliente afectado: *${name || 'Sin nombre'}* (+${phone}): "${text}"\n` +
      `Los chats NO se pausaron; los clientes reciben un aviso para reintentar.`
    );
  }
  return { reply: RETRY_LATER_REPLY, escalated: false, paused: false, productContext, error };
}

/** Registra en el historial un mensaje que un asesor envió manualmente al cliente. */
export function recordAdvisorMessage(phone, text) {
  db.upsertChat(phone, null);
  db.addMessage(phone, 'model', text);
}
