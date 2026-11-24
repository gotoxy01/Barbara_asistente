import { Type } from '@google/genai';
import { config } from '../config.js';
import { publishCrm } from '../crm/events.js';
import * as db from '../db.js';
import { toBolivares } from './bcvService.js';
import { catalogCustomerReply, catalogOverviewText, findProduct, getDeliveryCost, isBotellon, productLabel, searchProducts } from './catalogService.js';
import { buildPriceResult, buildStockResult } from './priceTools.js';
import { STOCK_CHECK_REPLY, isGenericCatalogQuery } from './customerText.js';
import { closeTicketsForPhone } from './ticketStore.js';
import { applyAction } from './orderBook.js';
import { customerLogisticsReply } from './orderLifecycle.js';

export const BOLETA_MARKER = '[BOLETA]';
/** Marca en el historial: a partir de aquí el carrito anterior ya no cuenta. */
export const CANCEL_MARKER = '[PEDIDO_CANCELADO]';

export const MORE_ITEMS_QUESTION = '¿Desea agregar algo más? 🛒';

export function renderPagoMovil() {
  const { telefono, cedula, banco } = config.pagoMovil;
  return `📲 *Datos para Pago Móvil:*\n• Tlf: ${telefono}\n• C.I.: ${cedula}\n• Banco: ${banco}`;
}
export const ADDRESS_QUESTION =
  'Para *cerrar y registrar* su pedido necesitamos una de estas dos opciones:\n\n' +
  '🛵 *Delivery:* indíquenos su dirección exacta con *número de casa* (o apto/quinta) y un punto de referencia.\n' +
  '🏪 *Retiro en tienda:* escriba “retiro en tienda” (o “paso a buscar”).\n\n' +
  '⚠️ *Importante:* si no nos da la ubicación de delivery ni confirma retiro en tienda, el pedido *no queda cerrado* y no pasa a cocina/despacho.';

export const HOUSE_NUMBER_REMINDER =
  '⚠️ Para poder finalizar su pedido nos falta su *número de casa* (o apto/quinta), o bien confirmar *retiro en tienda*. 🏠\n\n' +
  'Sin dirección de delivery ni retiro en tienda, el pedido no se cierra.';

/** Cliente retira en el local (no lleva delivery). */
export function isPickupAddress(address) {
  return /retiro\s+en\s+(la\s+)?tienda|paso\s+a\s+(buscar|buscarlo)|voy\s+a\s+(buscar|buscarlo|pasar)|recoger\s+en\s+(la\s+)?tienda|buscar\s+en\s+(la\s+)?tienda|pickup|pasar\s+por\s+(la\s+)?tienda/i.test(
    String(address || ''),
  );
}

/** La dirección debe traer número de casa/apto, nombre de quinta, "sin número", o ser retiro en tienda. */
export function hasHouseNumber(address) {
  if (isPickupAddress(address)) return true;
  return /\d/.test(address) || /\b(quinta|qta\.?)\s+\S+|\bs\/n\b|\bsin\s+n[uú]mero\b/i.test(address);
}

const round2 = (n) => Math.round(n * 100) / 100;

export const isSoldByWeight = (p) => /kilo|\bkg\b/i.test(p?.presentacion || '');

const plain = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** El cliente habló de peso ("1 kilo", "medio kilo", "500 gr", "1/2", "2kg")? Si no, pidió unidades. */
export function mentionsWeight(text) {
  return /kilo|kg|\bk\b|gramo|\d\s*grs?\b|\bgrs?\b|\bmedio\b|\bcuarto\b|\d\s*\/\s*\d/i.test(text);
}

/** "dame $2 de queso" / "2 dolares de jamón" → monto USD pedido (sin ir a balanza). */
export function moneyAmountMentioned(text) {
  const t = String(text || '');
  const usd = t.match(/(?:\$|usd|d[oó]lares?)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(?:\$|usd|d[oó]lares?)/i);
  if (usd) return Number((usd[1] || usd[2]).replace(',', '.'));
  return null;
}

/**
 * Revisa solo el fragmento donde el cliente nombra el producto ("1 kilo de tomate y 2 aguacates": el aguacate va por unidades).
 * Si no lo nombra (ej. respondió "2" a "¿cuántos plátanos desea?"), revisa todo su mensaje.
 */
export function weightMentionedFor(productName, text) {
  const stem = plain(productName).split(/\s+/)[0].slice(0, 5);
  const related = String(text).split(/[,;\n]|\s+y\s+|\s+e\s+|\s+con\s+/i).filter((s) => plain(s).includes(stem));
  return mentionsWeight(related.length ? related.join(' ') : text);
}
const SEPARATOR = '--------------------------------------------------';

// ---------------------------------------------------------------------------
// Cálculos (siempre en código, nunca en la IA)
// ---------------------------------------------------------------------------

function itemLabel(item) {
  if (item.pesable) return `${item.consulta ? '🔎' : '⚖️'} ${item.detalle}`;
  const qty = /kilo/i.test(item.presentacion) ? `${item.cantidad} kg` : `${item.cantidad}x`;
  return `${qty} ${item.nombre} (${item.presentacion})`;
}

/** Productos que el encargado aún no ha pesado (sin precio). */
export const pendingWeighItems = (items) => items.filter((i) => i.precio == null);

function money(usd, bs) {
  return bs == null ? `$ ${usd.toFixed(2)} USD` : `Bs. ${bs.toFixed(2)} ($ ${usd.toFixed(2)} USD)`;
}

/**
 * Líneas del pedido + tarifas de delivery + totales.
 * Un solo delivery por pedido (se omite si es retiro en tienda).
 * @param {object[]} items
 * @param {import('./bcvService.js').BcvRate|null} bcv
 * @param {{ pickup?: boolean }} [opts]
 */
export function computeTotals(items, bcv, { pickup = false } = {}) {
  const rate = bcv?.rate;
  const line = (usd) => ({ usd: round2(usd), bs: rate ? toBolivares(usd, rate) : null });

  const lines = items.filter((i) => i.precio != null).map((item) => ({
    label: itemLabel(item),
    ...line(item.precio * item.cantidad),
  }));
  const pending = pendingWeighItems(items).map((i) => i.detalle);

  const fees = [];
  if (items.length && !pickup) fees.push({ label: '🚚 Delivery', ...line(getDeliveryCost()) });
  if (items.length && pickup) fees.push({ label: '🏪 Retiro en tienda', ...line(0) });

  const all = [...lines, ...fees];
  const totalUsd = round2(all.reduce((s, l) => s + l.usd, 0));
  // El total en Bs es la suma de las líneas, para que la boleta cuadre al sumarla a mano.
  const totalBs = rate ? round2(all.reduce((s, l) => s + (l.bs || 0), 0)) : null;
  return { lines, fees, pending, totalUsd, totalBs, rate, pickup: !!pickup };
}

export function renderBoleta(items, bcv, { pickup = false } = {}) {
  const t = computeTotals(items, bcv, { pickup });
  return [
    '🧾 *RESUMEN DE SU PEDIDO - Abasto Los Cuchos*',
    SEPARATOR,
    ...[...t.lines, ...t.fees].map((l) => `• ${l.label}: ${money(l.usd, l.bs)}`),
    SEPARATOR,
    `💰 *TOTAL A PAGAR:* ${money(t.totalUsd, t.totalBs)}`,
    t.rate ? `(Calculado a Tasa BCV: ${t.rate.toFixed(2)} Bs/USD)` : '(El monto en Bs. se calcula a la Tasa BCV del día al momento del pago)',
    '',
    pickup
      ? '🏪 *Modalidad:* Retiro en tienda'
      : '⚠️ El pedido *solo se cierra* cuando confirme *dirección de delivery* (con número de casa) o *retiro en tienda*.',
  ].join('\n');
}

/** Tarifa de delivery ya convertida a Bs, para que la IA no tenga que calcularla. */
export function renderDeliveryFees(bcv) {
  const usd = getDeliveryCost();
  const fee = bcv ? `Bs. ${toBolivares(usd, bcv.rate).toFixed(2)} (o $ ${usd.toFixed(2)} USD)` : `$ ${usd.toFixed(2)} USD`;
  return `TARIFA DE DELIVERY: ${fee} por pedido (una sola vez, sin importar los productos).`;
}

/** Resumen del carrito para el System Prompt de Bárbara. */
export async function renderOrderContext(phone, bcv) {
  const order = await db.getActiveOrder(phone);
  if (!order || !order.items.length) {
    return [
      'El cliente aún no tiene productos en su pedido ACTUAL.',
      'IMPORTANTE: ignore productos de mensajes viejos o de pedidos cancelados. Solo agregue lo que pida AHORA.',
    ].join('\n');
  }
  const t = computeTotals(order.items, bcv);
  const status = order.status === 'boleta'
    ? 'BOLETA YA ENVIADA: el pedido NO está cerrado. Falta dirección de delivery (con número de casa) O “retiro en tienda”.'
    : 'EN CURSO: el cliente sigue agregando productos.';
  return [
    'SOLO ESTE CARRITO ES VÁLIDO (pedido actual de ESTE chat). No mezcle ni reincorpore ítems de pedidos cancelados ni del historial antiguo.',
    `Pedido #${order.id} · Estado: ${status}`,
    ...[...t.lines, ...t.fees].map((l) => `- ${l.label}: ${money(l.usd, l.bs)}`),
    ...pendingWeighItems(order.items).map((i) => (i.consulta
      ? `- 🔎 ${i.detalle}: PENDIENTE DE CONSULTA (el encargado en caja está verificando disponibilidad y precio)`
      : `- ⚖️ ${i.detalle}: PENDIENTE DE PESAJE (el encargado en caja lo está pesando; aún no tiene precio)`)),
    `Total actual${t.pending.length ? ' (sin los productos pendientes del encargado)' : ''}: ${money(t.totalUsd, t.totalBs)}`,
    ...(order.boleta_pendiente ? ['El cliente ya pidió cerrar el pedido: la boleta se enviará sola en cuanto el encargado envíe el precio.'] : []),
  ].join('\n');
}

/** Historial desde el último pedido cancelado (o completo si no hubo). */
export function trimHistorySinceCancel(history) {
  if (!Array.isArray(history) || !history.length) return history || [];
  let start = 0;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role === 'model' && String(history[i].content || '').includes(CANCEL_MARKER)) {
      start = i + 1;
    }
  }
  return history.slice(start);
}

/**
 * En conversación nueva: solo el turno actual (mensajes del cliente tras la última respuesta),
 * para no arrastrar chats de pedidos ya cancelados.
 */
export function trimHistoryForFreshSession(history) {
  if (!Array.isArray(history) || !history.length) return history || [];
  const lastReply = history.map((m) => m.role).lastIndexOf('model');
  if (lastReply < 0) return history.slice(-6);
  const pending = history.slice(lastReply + 1);
  return pending.length ? pending : history.slice(-1);
}

/** Conversación nueva: solo lo que el cliente acaba de escribir, sin la respuesta vieja. */
export function scopeHistoryForTurn(history, isNewConversation) {
  const trimmed = trimHistorySinceCancel(history || []);
  if (!isNewConversation) return trimmed;
  return trimHistoryForFreshSession(trimmed);
}

/**
 * Seguimiento corto del hilo ("2", "sí", "la pequeña", "¿hay de esa?").
 * No exige repetir el nombre del producto que se estaba hablando.
 */
export function isShortFollowUp(customerText) {
  const text = String(customerText || '').trim();
  if (!text) return true;
  if (/pequeñ[ao]s?|grand[eo]s?|median[ao]s?|m[aá]s\s+grand|m[aá]s\s+peque/i.test(text) && text.length <= 48) {
    return true;
  }
  if (/^(y\s+)?(hay|tienen|tiene|cuesta)?\s*(de\s+)?(la|el|las|los)?\s*(pequeñ|grand|median|esa|ese|esos|esas|otra|otro|mismo|misma)/i.test(text)) {
    return true;
  }
  if (text.length <= 28 && /^(s[ií]|no|ok|okay|dale|va|listo|ese|esa|eso|esos|esas|el de|la de|unos?|unas?|\d)/i.test(text)) {
    return true;
  }
  return text.length <= 10 && !/[a-záéíóúñ]{5,}/i.test(text);
}

/** ¿El texto del cliente parece referirse a este producto? */
export function customerMentionsProduct(productName, customerText) {
  const text = String(customerText || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const name = String(productName || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  if (!text.trim() || !name.trim()) return true; // sin texto no bloqueamos
  if (isShortFollowUp(customerText)) return true;
  const token = name.split(/[\s(/]+/).filter((t) => t.length > 2)[0];
  if (!token) return true;
  if (text.includes(token)) return true;
  // Diminutivos / typos suaves: "tomate" ⊂ "tomates", "quesito" ≈ "queso"
  if (token.length >= 4 && text.includes(token.slice(0, Math.max(4, token.length - 1)))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Productos pesables (frutas, verduras, charcutería por trozo, carnes...)
// ---------------------------------------------------------------------------

const joinNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]);

/**
 * Mensaje al cliente mientras el encargado pesa (frutas, verduras...) o consulta (ferretería, farmacia).
 * @param {string[]} weighedNames productos por pesar
 * @param {boolean} hasCatalogItems si en el mismo turno se agregaron productos de catálogo
 * @param {{ nombre: string, tipo: string }[]} [consulted] artículos de ferretería/farmacia consultados al encargado
 */
export function renderWeighWaitMessage(weighedNames, hasCatalogItems, consulted = []) {
  const parts = [];
  if (hasCatalogItems) parts.push('¡Excelente! Ya tengo anotados sus productos de catálogo.');
  if (weighedNames.length) {
    parts.push(
      `¡Claro! Déjeme pesar *${joinNames(weighedNames)}* aquí en un momentico para darle el monto exacto y ya le aviso. ⚖️`,
    );
  }
  if (consulted.length) {
    parts.push(
      `Déjeme verificar rapidito *${joinNames(consulted.map((c) => c.nombre))}* en el mostrador y le confirmo.`,
    );
  }
  if (!parts.length) parts.push('¡Claro! Déjeme revisarlo aquí en un momentico y ya le aviso.');
  return parts.join(' ');
}

function precioKgLabel(item) {
  const found = findProduct(String(item?.nombre || item?.detalle || ''));
  const p = found.product;
  if (p?.precio != null) return `$ ${Number(p.precio).toFixed(2)}/kg`;
  return 'ver BD';
}

/**
 * Ficha telegráfica de 3 líneas para la consola del encargado (pesaje).
 * @param {{ ticketId?: string, name?: string|null, items: object[] }} opts
 */
export function renderWeighAlert({ ticketId, name, items }) {
  const id = ticketId || '—';
  const quien = name || 'Cliente';
  const pide = (items || []).map((i) => i.detalle || i.nombre).join('; ') || 'producto';
  const precios = [...new Set((items || []).map((i) => precioKgLabel(i)))].join(', ');
  return [
    `⚖️ *[PESAJE] — #${id} (${quien})*`,
    `• *Pide:* ${pide} (Precio BD: ${precios})`,
    '• *Falta:* Peso exacto en balanza (responde citando este mensaje con los gramos o kilos).',
  ].join('\n');
}

/** Misma ficha para CRM (detalle). */
export function renderWeighAlertDetail(opts) {
  return renderWeighAlert(opts);
}

/** Ficha telegráfica de flete. */
export function renderFreightAlert({ ticketId, name, zona }) {
  return [
    `🛵 *[FLETE] — #${ticketId || '—'} (${name || 'Cliente'})*`,
    `• *Pide:* Envío a ${zona || 'zona indicada'}`,
    '• *Falta:* Tarifa de delivery para esa zona (responde con el monto en USD).',
  ].join('\n');
}

/** Ficha telegráfica de validación de pago. */
export function renderPaymentAlert({ ticketId, name, phone, note }) {
  return [
    `🧾 *[PAGO] — #${ticketId || '—'} (${name || 'Cliente'})*`,
    `• *Pide:* Validar comprobante (+${phone})`,
    `• *Falta:* Revisar capture/transferencia${note ? ` — ${note}` : ''} y confirmar despacho.`,
  ].join('\n');
}

/** Tras resolver los pendientes: si el cliente ya había cerrado el pedido, se envía la boleta; si no, se pregunta si desea algo más. */
async function closePending(order, header, bcv) {
  if (order.boleta_pendiente && order.items.length) {
    const t = computeTotals(order.items, bcv);
    Object.assign(order, { status: 'boleta', boleta_pendiente: 0, total_usd: t.totalUsd, total_bs: t.totalBs, bcv_rate: t.rate ?? null });
    await db.saveOrder(order);
    return { order, message: `${header}\n\n${renderBoleta(order.items, bcv)}\n\n${renderPagoMovil()}\n\n${ADDRESS_QUESTION}` };
  }
  order.boleta_pendiente = 0;
  await db.saveOrder(order);
  const closing = order.items.length ? MORE_ITEMS_QUESTION : '¿Le puedo ayudar con algún otro producto? 😊';
  return { order, message: `${header}\n\n${closing}` };
}

function matchPendingByTicket(pending, ticketItems) {
  if (!ticketItems?.length) return pending;
  const keys = ticketItems.map((i) => String(i.detalle || i.nombre || '').toLowerCase()).filter(Boolean);
  if (!keys.length) return pending;
  const matched = pending.filter((p) => {
    const d = String(p.detalle || p.nombre || '').toLowerCase();
    return keys.some((k) => d.includes(k) || k.includes(d) || d.includes(k.split('(')[0].trim()));
  });
  // Si la nota no cuadra con el carrito actual, no inventar: usar solo lo pendiente MÁS reciente.
  if (!matched.length) {
    return pending.slice(-1);
  }
  return matched;
}

async function orderFromTarget(target) {
  const digits = String(target || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 7) {
    const byId = await db.getOrderById(Number(digits));
    if (byId && byId.lifecycle !== 'cancelado') return byId;
  }
  return (await db.getCommercialOrder(digits)) || (await db.getActiveOrder(digits));
}

/** El asesor confirmó que el producto sí está y pasó el precio en USD. */
export async function applyConfirmedStock(target, productName, usd, bcv) {
  const order = await orderFromTarget(target);
  if (!order) return { error: 'No encontré ese pedido o ese cliente.' };
  const needle = String(productName || '').toLowerCase();
  let item = order.items.find((entry) => entry.verificacion && String(entry.nombre || '').toLowerCase().includes(needle))
    || order.items.find((entry) => entry.precio == null && String(entry.nombre || entry.detalle || '').toLowerCase().includes(needle));
  if (!item) {
    item = { nombre: productName, presentacion: 'confirmado en tienda', detalle: productName, precio: round2(usd), cantidad: 1, verificacion: false, botellon: false };
    order.items.push(item);
  } else {
    item.precio = round2(usd);
    item.verificacion = false;
    item.pesable = false;
    item.presentacion = 'confirmado en tienda';
  }
  await db.saveOrder(order);
  const price = bcv ? `Bs. ${toBolivares(usd, bcv.rate).toFixed(2)} (o $ ${usd.toFixed(2)} USD)` : `$ ${usd.toFixed(2)} USD`;
  return { order, message: `Sí lo tenemos: *${item.nombre}* quedó anotado en ${price}. ¿Desea agregar algo más?` };
}

/** El asesor confirmó que ese producto no está. Solo entonces se lo decimos al cliente. */
export async function applyRejectedStock(target, productName) {
  const order = await orderFromTarget(target);
  if (!order) return { error: 'No encontré ese pedido o ese cliente.' };
  const needle = String(productName || '').toLowerCase();
  const before = order.items.length;
  order.items = order.items.filter((entry) => !String(entry.nombre || entry.detalle || '').toLowerCase().includes(needle));
  if (order.items.length === before) return { error: `No está "${productName}" en el pedido #${order.id}.` };
  await db.saveOrder(order);
  return { order, message: `Le confirmo que *${productName}* no lo tenemos en este momento. ¿Le ofrezco otra cosa?` };
}

/** El encargado indicó que NO hay los productos consultados: se quitan del pedido y se avisa al cliente. */
export async function applyNotAvailable(phone, bcv, { ticketItems = null } = {}) {
  const order = await db.getActiveOrder(phone);
  const allPending = order ? pendingWeighItems(order.items) : [];
  const pending = matchPendingByTicket(allPending, ticketItems);
  if (!pending.length) return { error: `+${phone} no tiene productos pendientes de consulta en el pedido actual.` };

  const drop = new Set(pending);
  order.items = order.items.filter((i) => i.precio != null || !drop.has(i));
  const header = `Disculpe, el encargado en caja me confirma que por ahora *no tenemos disponible*: ${pending.map((i) => i.detalle).join(', ')}. 😔`;
  return closePending(order, header, bcv);
}

/**
 * Aplica el precio del encargado a los pendientes del pedido ACTUAL.
 * Si viene de una nota (ticketItems), solo toca esos ítems — no precios viejos de otro pedido.
 */
export async function applyWeighedPrice(phone, usd, bcv, { ticketItems = null } = {}) {
  const order = await db.getActiveOrder(phone);
  const allPending = order ? pendingWeighItems(order.items) : [];
  const pending = matchPendingByTicket(allPending, ticketItems);
  if (!pending.length) return { error: `+${phone} no tiene productos pendientes por pesar en el pedido actual.` };

  const detalle = pending.map((i) => i.detalle).join(', ');
  const consulta = pending.every((i) => i.consulta);
  const drop = new Set(pending);
  order.items = order.items.filter((i) => i.precio != null || !drop.has(i));
  order.items.push({
    nombre: consulta ? 'Productos consultados' : 'Productos pesados',
    presentacion: consulta ? 'confirmado en tienda' : 'pesado en tienda',
    detalle, precio: round2(usd), cantidad: 1, pesable: true, consulta, botellon: false,
  });

  const price = bcv ? `Bs. ${toBolivares(usd, bcv.rate).toFixed(2)} (o $ ${usd.toFixed(2)} USD)` : `$ ${usd.toFixed(2)} USD`;
  const header = consulta
    ? `✅ ¡Listo! El encargado confirmó que sí lo tenemos y lo anoté en su pedido:\n• 🔎 *${detalle}*: ${price}`
    : `✅ ¡Listo! Ya pesamos sus productos:\n• ⚖️ *${detalle}*: ${price}`;
  return closePending(order, header, bcv);
}

// ---------------------------------------------------------------------------
// Herramientas (function calling) que Gemini usa para manejar el pedido
// ---------------------------------------------------------------------------

export const ORDER_TOOL_DECLARATIONS = [
  {
    name: 'search_catalog',
    description: 'Busca en el inventario las palabras del cliente y devuelve solo sku reales. Úsela antes de get_price si no tiene el sku. Nunca invente un código.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        consulta: { type: Type.STRING, description: 'Lo que pidió el cliente, por ejemplo "harina pan"' },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'get_price',
    description: 'Precio vigente en USD y bolívares de un sku. Úsela SIEMPRE antes de decir un precio. El catálogo del prompt no trae montos.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sku: { type: Type.STRING, description: 'Código sku tal como aparece en el catálogo, por ejemplo sku=harina-pan-1-kg' },
      },
      required: ['sku'],
    },
  },
  {
    name: 'get_stock',
    description: 'Existencia vigente de un sku. Úsela antes de afirmar que hay o que no hay.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sku: { type: Type.STRING, description: 'Código sku del catálogo' },
      },
      required: ['sku'],
    },
  },
  {
    name: 'agregar_producto',
    description: 'Agrega un producto del catálogo al pedido del cliente (o suma cantidad si ya estaba). Úsala cada vez que el cliente pida o confirme que quiere un producto.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        producto: { type: Type.STRING, description: 'Nombre exacto del producto tal como aparece en el catálogo, con su presentación entre paréntesis. Ej: "Harina pan (unidad)"' },
        cantidad: { type: Type.NUMBER, description: 'Cantidad de unidades, o kilos si el producto es "por kilo" (se permiten decimales, ej. 0.5)' },
      },
      required: ['producto', 'cantidad'],
    },
  },
  {
    name: 'solicitar_pesaje',
    description: 'Solo para pesaje físico en balanza: el cliente pidió por unidad/pieza/trozo SIN kilos ni monto fijo (ej. "5 plátanos", "un pedazo de queso", "una bandeja de muslos"). NO la uses si pidió kilos/gramos exactos ni si pidió un monto en $ o Bs. (ej. "dame $2 de queso": calcula kilos y usa agregar_producto).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        producto: { type: Type.STRING, description: 'Nombre del producto como lo pidió el cliente. Ej: "plátanos", "queso blanco"' },
        cantidad: { type: Type.STRING, description: 'Cantidad tal como la pidió el cliente. Ej: "5 unidades", "1 trozo", "medio kilo aprox."' },
      },
      required: ['producto', 'cantidad'],
    },
  },
  {
    name: 'consultar_encargado',
    description: 'EXCEPCIÓN rara. NO la uses para ferretería/farmacia ni productos del catálogo. Solo si necesitas un dato físico fuera de BD que no sea pesaje (el pesaje usa solicitar_pesaje) ni flete (el sistema abre ticket de flete). En la práctica casi no la uses.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        producto: { type: Type.STRING, description: 'Qué hay que verificar físicamente' },
        cantidad: { type: Type.STRING, description: 'Detalle opcional' },
        tipo: { type: Type.STRING, enum: ['ferreteria', 'farmacia'], description: 'Clasificación interna si aplica' },
      },
      required: ['producto', 'tipo'],
    },
  },
  {
    name: 'quitar_producto',
    description: 'Quita un producto del pedido, o reduce su cantidad.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        producto: { type: Type.STRING, description: 'Nombre del producto tal como está en el pedido' },
        cantidad: { type: Type.NUMBER, description: 'Cantidad a quitar. Omítela para quitar el producto completo.' },
      },
      required: ['producto'],
    },
  },
  {
    name: 'vaciar_pedido',
    description: 'Vacía el carrito para empezar de nuevo (el cliente quiere cambiar todo o armar otro pedido). NO la uses si dice que NO quiere el pedido / que lo cancelen: en ese caso usa cancelar_pedido.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'cancelar_pedido',
    description: 'Cancela por completo el pedido del cliente (en curso, con boleta o ya registrado). Úsala SIEMPRE que diga que no quiere proceder, que cancele, que ya no lo quiere, que no lo mande, que anule el pedido, etc.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'generar_boleta',
    description: 'Cierra la selección y genera la boleta detallada con delivery y total. Úsala cuando el cliente confirme que es todo ("es todo", "nada más", "confirmar", etc.).',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'registrar_direccion',
    description: 'Cierra el pedido tras la boleta: guarda la dirección de delivery O registra retiro en tienda, y envía la comanda al equipo. Sin esto el pedido NO queda cerrado. Use también si el cliente dice “retiro en tienda”, “paso a buscar”, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direccion: {
          type: Type.STRING,
          description: 'Dirección exacta con número de casa/apto, O el texto “retiro en tienda” / “paso a buscar” si recoge en el local',
        },
      },
      required: ['direccion'],
    },
  },
];

function summarize(order, bcv) {
  const t = computeTotals(order.items, bcv);
  return {
    productos: t.lines.map((l) => `${l.label}: ${money(l.usd, l.bs)}`),
    por_pesar: t.pending,
    delivery: t.fees.map((l) => `${l.label}: ${money(l.usd, l.bs)}`),
    total: money(t.totalUsd, t.totalBs),
  };
}

function optionsList(options) {
  return options.map((p) => productLabel(p));
}

/**
 * Crea el ejecutor de herramientas para un turno de conversación.
 * `state` registra lo ocurrido para que chatService ajuste la respuesta final.
 */
export function createOrderTools({ phone, name, bcv, notify, customerText = '' }) {
  const state = {
    cartChanged: false, catalogAdded: false, boleta: null, addressSaved: false,
    missingHouseNumber: false, weighed: [], consulted: [], waitingWeight: false,
  };

  const handlers = {
    async search_catalog({ consulta }) {
      const query = String(consulta || customerText || '');
      if (isGenericCatalogQuery(query)) {
        return {
          ok: true,
          general: true,
          productos: [],
          resumen: catalogOverviewText(),
          respuesta_sugerida: catalogCustomerReply(),
          instruccion: 'Es una pregunta general del catálogo. No llame de nuevo a search_catalog. Liste las categorías del resumen. confianza 100. requiere_especialista false. No diga que no hay.',
        };
      }
      const found = await searchProducts(query, {});
      const productos = (found.products || []).slice(0, 5).map((product) => ({
        sku: product.sku,
        nombre: `${product.nombre} (${product.presentacion})`,
        precio_usd: Number(product.precio).toFixed(2),
      }));
      if (!productos.length) {
        return {
          ok: false,
          productos: [],
          instruccion: 'No hay un sku para inventar. Diga que va a verificar en el inventario. No diga que no hay.',
        };
      }
      return { ok: true, productos, instruccion: 'Use solo estos sku y estos precios. No invente otro código.' };
    },
    async get_price({ sku }) {
      const row = await db.getProductBySku(String(sku || '').trim());
      return buildPriceResult(row, bcv?.rate);
    },
    async get_stock({ sku }) {
      const row = await db.getProductBySku(String(sku || '').trim());
      return buildStockResult(row);
    },
    async agregar_producto({ producto, cantidad }) {
      const qty = Number(cantidad);
      if (!(qty > 0)) return { error: 'La cantidad debe ser mayor que cero.' };
      const found = findProduct(String(producto ?? ''));
      if (found.options) {
        return {
          error: found.soft
            ? 'No hay coincidencia exacta; hay productos parecidos (posible error de escritura u otro nombre). Pregunte cuál desea.'
            : 'Hay varios productos parecidos; pregunte al cliente cuál desea.',
          opciones: optionsList(found.options),
          instruccion: 'Muestre las opciones con su nombre exacto del catálogo y precios. No diga que no hay hasta que el cliente descarte todas.',
        };
      }
      if (!found.product) {
        return handlers.verificar_stock({ producto: String(producto || '').trim(), cantidad: qty });
      }

      const p = found.product;
      const live = await db.getProductBySku(p.sku);
      if (live) {
        p.precio = Number(live.price);
        p.stock = live.stock;
      }
      if (p.stock == null) {
        return handlers.verificar_stock({ producto: p.nombre, cantidad: qty });
      }
      if (p.stock === 0) {
        return handlers.verificar_stock({ producto: p.nombre, cantidad: qty });
      }
      // Auditoría dura: no agregar algo que el cliente no pidió en este turno (evita arrastrar pedidos viejos).
      if (customerText && !customerMentionsProduct(p.nombre, customerText) && !customerMentionsProduct(producto, customerText)) {
        return {
          error: `El cliente no pidió "${p.nombre}" en su mensaje actual.`,
          instruccion: 'NO agregue productos del historial viejo. Confirme con el cliente qué desea AHORA, usando solo su último mensaje.',
        };
      }
      let addQty = qty;

      // "dame $2 de queso": convierte monto → kilos con el precio/kg de la BD (sin pesaje).
      const moneyUsd = moneyAmountMentioned(customerText);
      if (isSoldByWeight(p) && moneyUsd > 0 && p.precio > 0) {
        addQty = round2(moneyUsd / p.precio);
        if (!(addQty > 0)) return { error: 'No se pudo calcular el peso a partir del monto.' };
      } else if (isSoldByWeight(p) && !weightMentionedFor(p.nombre, customerText)) {
        // "un aguacate", "3 plátanos": unidades → balanza.
        const result = await handlers.solicitar_pesaje({ producto: p.nombre, cantidad: `${qty} ${qty === 1 ? 'unidad' : 'unidades'}` });
        return { ...result, nota: `El cliente pidió ${p.nombre} por unidades (no por kilos ni monto): se envió a pesar en caja.` };
      }

      const order = await db.getOrCreateActiveOrder(phone);
      if (['pago_reportado', 'pago_verificado', 'en_logistica', 'entregado'].includes(order.lifecycle)) {
        return { error: 'Ese pedido ya tiene un pago reportado. No se le agregan productos hasta que el asesor lo revise.' };
      }
      const existing = order.items.find((i) => i.nombre === p.nombre && i.presentacion === p.presentacion);
      if (existing) existing.cantidad = round2(existing.cantidad + addQty);
      else order.items.push({ sku: p.sku || null, nombre: p.nombre, presentacion: p.presentacion, precio: p.precio, cantidad: addQty, botellon: isBotellon(p) });
      order.status = 'abierto';
      order.lifecycle = 'borrador';
      await db.saveOrder(order);
      state.cartChanged = true;
      state.catalogAdded = true;
      const nota = moneyUsd > 0 && isSoldByWeight(p)
        ? `Calculado: $ ${moneyUsd.toFixed(2)} ÷ $ ${p.precio}/kg = ${addQty} kg (sin molestar al encargado).`
        : undefined;
      return { ok: true, agregado: `${addQty} x ${productLabel(p)}`, ...(nota ? { nota } : {}), pedido: summarize(order, bcv) };
    },

    async verificar_stock({ producto, cantidad }) {
      const nombre = String(producto || '').trim();
      if (!nombre || isGenericCatalogQuery(nombre)) {
        return {
          ok: true,
          general: true,
          respuesta_sugerida: catalogCustomerReply(),
          instruccion: 'No es un producto concreto. Responda con las categorías. No escale.',
        };
      }
      const qty = Number(cantidad) > 0 ? Number(cantidad) : 1;
      const detalle = qty === 1 ? nombre : `${nombre} (${qty})`;
      const order = await db.getOrCreateActiveOrder(phone);
      order.items.push({
        nombre, presentacion: 'por verificar', detalle, precio: null, cantidad: qty,
        verificacion: true, pesable: true, botellon: false,
      });
      order.status = 'abierto';
      order.lifecycle = order.lifecycle && order.lifecycle !== 'borrador' ? order.lifecycle : 'borrador';
      await db.saveOrder(order);
      state.cartChanged = true;
      state.consulted.push({ nombre, tipo: 'verificacion' });
      await notify(
        [
          `Verificar stock: *${detalle}*`,
          `Cliente: ${name || 'Sin nombre'} (+${phone})`,
          order.id ? `Pedido #${order.id}` : null,
          customerText ? `Escribió: "${String(customerText).slice(0, 240)}"` : null,
          `Si lo hay: #hay ${order.id || phone} ${nombre} <precio USD>`,
          `Si no lo hay: #nohay ${order.id || phone} ${nombre}`,
        ].filter(Boolean).join('\n'),
        { kind: 'weigh', phone, title: `Verificar stock: ${nombre}`, whatsapp: true },
      );
      return {
        ok: true,
        verificacion: true,
        respuesta_cliente: STOCK_CHECK_REPLY,
        instruccion: `Responda exactamente: "${STOCK_CHECK_REPLY}" No diga que no hay. El chat sigue abierto para el resto del pedido.`,
      };
    },

    async solicitar_pesaje({ producto, cantidad }) {
      const nombre = String(producto ?? '').trim();
      if (!nombre) return { error: 'Indique el producto a pesar.' };
      // Nunca anotar el mensaje completo como "producto".
      if (nombre.length > 60 || /\n/.test(nombre) || /^(hola|buenas|quiero|dame|necesito)\b/i.test(nombre)) {
        const found = findProduct(nombre);
        const clean = found.product?.nombre;
        if (!clean) {
          return {
            error: 'Nombre de producto inválido para pesaje.',
            instruccion: 'Use el nombre corto del producto (ej. "tomate", "queso"), no la frase completa del cliente.',
          };
        }
        return await handlers.solicitar_pesaje({ producto: clean, cantidad });
      }
      if (customerText && !customerMentionsProduct(nombre, customerText)) {
        return {
          error: `El cliente no pidió pesar "${nombre}" en su mensaje actual.`,
          instruccion: 'Solo abra pesaje de lo que el cliente pidió AHORA. No reutilice productos de pedidos cancelados.',
        };
      }
      const qty = String(cantidad ?? '').trim();
      const detalle = qty ? `${nombre} (${qty})` : nombre;
      const order = await db.getOrCreateActiveOrder(phone);
      order.items.push({ nombre, presentacion: 'por pesar', detalle, precio: null, cantidad: 1, pesable: true, botellon: false });
      order.status = 'abierto';
      await db.saveOrder(order);
      state.cartChanged = true;
      state.weighed.push(nombre);
      return {
        ok: true,
        anotado_para_pesar: detalle,
        instruccion: 'El sistema avisa al encargado y envía al cliente el mensaje de espera. No inventes precio para este producto ni generes la boleta todavía.',
      };
    },

    async consultar_encargado({ producto, cantidad, tipo }) {
      const nombre = String(producto ?? '').trim();
      if (!nombre) return { error: 'Indique el artículo a consultar.' };
      const qty = String(cantidad ?? '').trim();
      const detalle = qty ? `${nombre} (${qty})` : nombre;
      const order = await db.getOrCreateActiveOrder(phone);
      order.items.push({
        nombre, presentacion: tipo === 'farmacia' ? 'farmacia' : 'ferretería', detalle,
        precio: null, cantidad: 1, pesable: true, consulta: true, botellon: false,
      });
      order.status = 'abierto';
      await db.saveOrder(order);
      state.cartChanged = true;
      state.consulted.push({ nombre, tipo: tipo === 'farmacia' ? 'farmacia' : 'ferreteria' });
      return {
        ok: true,
        consultado_al_encargado: detalle,
        instruccion: 'El sistema avisa al encargado y envía al cliente el mensaje de espera. No des precio ni confirmes disponibilidad de este artículo; espera la respuesta del encargado.',
      };
    },

    async quitar_producto({ producto, cantidad }) {
      const order = await db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'El pedido está vacío.' };
      const wanted = String(producto ?? '').toLowerCase();
      const item = order.items.find((i) => `${i.nombre} (${i.presentacion})`.toLowerCase() === wanted)
        ?? order.items.find((i) => `${i.nombre} (${i.presentacion})`.toLowerCase().includes(wanted) || wanted.includes(i.nombre.toLowerCase()));
      if (!item) return { error: `"${producto}" no está en el pedido.`, pedido: summarize(order, bcv) };

      const qty = Number(cantidad);
      if (qty > 0 && qty < item.cantidad) item.cantidad = round2(item.cantidad - qty);
      else order.items = order.items.filter((i) => i !== item);
      order.status = 'abierto';
      await db.saveOrder(order);
      state.cartChanged = true;
      return { ok: true, pedido: summarize(order, bcv) };
    },

    async vaciar_pedido() {
      const order = await db.getActiveOrder(phone);
      if (order) {
        order.items = [];
        order.status = 'abierto';
        order.boleta_pendiente = 0;
        await db.saveOrder(order);
      }
      state.cartChanged = true;
      return { ok: true, instruccion: 'Confirme que el carrito quedó vacío y pregunte qué desea pedir ahora.' };
    },

    async cancelar_pedido() {
      const canceled = await db.cancelPendingOrders(phone);
      closeTicketsForPhone(phone);
      await db.resolveAlertsByPhoneKind(phone, 'order');
      await db.resolveAlertsByPhoneKind(phone, 'weigh');
      await db.resolveAlertsByPhoneKind(phone, 'payment');
      await db.resolveAlertsByPhoneKind(phone, 'ticket');
      // Carrito limpio para el próximo pedido de este chat.
      await db.startFreshActiveOrder(phone);
      state.cartChanged = true;
      state.canceled = true;
      if (!canceled.length) {
        return {
          ok: true,
          nota: 'No había pedido activo que cancelar.',
          instruccion: 'Diga amablemente que no hay un pedido en curso y ofrezca ayudar si desea armar uno nuevo.',
        };
      }
      for (const o of canceled) {
        publishCrm({ type: 'kitchen', orderId: o.id, kitchenStatus: 'cancelado', phone });
      }
      const ids = canceled.map((o) => `#${o.id}`).join(', ');
      return {
        ok: true,
        cancelados: canceled.map((o) => o.id),
        cancelMarker: CANCEL_MARKER,
        instruccion: `Confirme con amabilidad que el pedido ${ids} quedó cancelado y que puede pedir de nuevo cuando guste. Incluya exactamente ${CANCEL_MARKER} al final de su respuesta (el cliente no lo verá; el sistema lo usa). No insista en continuar ese pedido.`,
      };
    },

    async generar_boleta() {
      const order = await db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'El pedido está vacío; pregunte al cliente qué productos desea.' };
      if (pendingWeighItems(order.items).length) {
        order.boleta_pendiente = 1;
        await db.saveOrder(order);
        state.waitingWeight = true;
        return {
          error: 'Hay productos esperando el precio del encargado (pesaje o consulta).',
          instruccion: 'Dile al cliente que en cuanto el encargado en caja confirme el precio le enviamos la boleta completa con el total. No escribas [BOLETA].',
        };
      }
      const t = computeTotals(order.items, bcv);
      Object.assign(order, { status: 'boleta', lifecycle: 'boleta_enviada', total_usd: t.totalUsd, total_bs: t.totalBs, bcv_rate: t.rate ?? null });
      await db.saveOrder(order);
      state.boleta = renderBoleta(order.items, bcv);
      return {
        ok: true,
        instruccion: `Escribe exactamente ${BOLETA_MARKER} en tu respuesta (el sistema lo reemplaza por la boleta). Deja claro que el pedido AÚN NO ESTÁ CERRADO hasta que indiquen dirección de delivery (con número de casa) o “retiro en tienda”. No escribas tú los montos ni el total.`,
      };
    },

    async registrar_direccion({ direccion }) {
      const order = await db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'No hay un pedido en curso para este cliente.' };
      if (order.status !== 'boleta' && order.lifecycle !== 'boleta_enviada' && order.lifecycle !== 'pago_reportado') {
        return { error: 'Primero genere la boleta (generar_boleta) y confírmela con el cliente.' };
      }
      const raw = String(direccion ?? '').trim();
      const pickup = isPickupAddress(raw);
      if (!pickup && !hasHouseNumber(raw)) {
        state.missingHouseNumber = true;
        return {
          error: 'Falta número de casa/apto o confirmación de retiro en tienda.',
          instruccion: 'NO registres el pedido todavía. Pida dirección con número de casa, o que escriba “retiro en tienda”. Sin eso el pedido no se cierra.',
        };
      }
      const t = computeTotals(order.items, bcv, { pickup });
      const reduced = await applyAction(phone, { type: 'save_address', address: raw, totals: t, name });
      if (reduced.error) return { error: reduced.error };
      state.addressSaved = true;
      state.pickup = pickup;
      state.logistics = Boolean(reduced.logistics);
      if (reduced.notice) {
        await notify(reduced.notice, {
          kind: 'logistica', phone, title: `Logística pedido #${reduced.order.id}`, whatsapp: true,
        });
      }
      return {
        ok: true,
        pedido_numero: reduced.order.id,
        direccion: reduced.order.address,
        pickup,
        logistics: Boolean(reduced.logistics),
        instruccion: reduced.logistics
          ? 'El pago y la ubicación ya están. Diga que un agente coordinará la entrega. No diga que el pago está confirmado.'
          : (pickup
            ? 'La dirección quedó guardada como retiro en tienda. Pida el comprobante de pago. No diga que el pago está confirmado ni que ya salió a cocina.'
            : 'La dirección quedó guardada. Pida el comprobante de pago. No diga que el pago está confirmado.'),
      };
    },
  };

  async function execute(toolName, args = {}) {
    const handler = handlers[toolName];
    if (!handler) return { error: `Herramienta desconocida: ${toolName}` };
    try {
      return await handler(args);
    } catch (err) {
      console.error(`[${phone}] Error en ${toolName}:`, err);
      return { error: 'Error interno al procesar el pedido.' };
    }
  }

  /**
   * Para la boleta y la dirección la respuesta ya está definida por el sistema, así que se arma aquí
   * y se ahorra una segunda llamada a Gemini (varios segundos).
   */
  function finalize(calls) {
    if (!calls.length) return null;
    const checks = calls.filter((call) => call.result?.verificacion);
    const added = calls.filter((call) => call.name === 'agregar_producto' && call.result?.ok);
    const onlyCart = calls.every((call) => call.result?.verificacion || (call.name === 'agregar_producto' && call.result?.ok));
    if (onlyCart && (checks.length || added.length)) {
      const parts = [];
      if (checks.length) parts.push(STOCK_CHECK_REPLY);
      if (added.length) parts.push(`Anoté: ${added.map((call) => call.result.agregado).join(', ')}. ¿Desea agregar algo más?`);
      return parts.join('\n\n');
    }
    const prices = calls.filter((call) => call.name === 'get_price' && call.result?.ok);
    const onlyLookup = calls.every((call) => ['get_price', 'get_stock', 'search_catalog'].includes(call.name));
    if (prices.length && onlyLookup && !calls.some((call) => call.result?.general)) {
      const lines = prices.map((call) => {
        const row = call.result;
        const money = row.precio_bs != null
          ? `Bs. ${Number(row.precio_bs).toFixed(2)} (o $ ${Number(row.precio_usd).toFixed(2)} USD)`
          : `$ ${Number(row.precio_usd).toFixed(2)} USD`;
        return `*${row.nombre}*${row.presentacion ? ` (${row.presentacion})` : ''}: ${money}`;
      });
      return `${lines.join('\n')}\n\n¿Cuántos desea?`;
    }
    const terminal = new Set(['generar_boleta', 'registrar_direccion']);
    if (!calls.every((call) => terminal.has(call.name) && call.result?.ok)) return null;

    const address = calls.find((c) => c.name === 'registrar_direccion');
    if (address) {
      if (address.result.logistics) return customerLogisticsReply(name);
      const modo = address.result.pickup
        ? '🏪 *Modalidad:* Retiro en tienda (sin cargo de delivery)'
        : `📍 *Dirección guardada:* ${address.result.direccion}`;
      return `¡Gracias${name ? `, ${name.split(' ')[0]}` : ''}! Anoté la entrega del pedido *#${address.result.pedido_numero}*.\n\n` +
        `${modo}\n\n` +
        'Cuando pague por Pago Móvil, envíe la captura y el número de referencia por este chat. El pago queda en verificación hasta que un asesor lo confirme. 🛵';
    }
    return `${BOLETA_MARKER}\n\n${ADDRESS_QUESTION}`;
  }

  /** La boleta que ve el cliente lleva los datos de Pago Móvil (el aviso al asesor no). */
  state.boletaForCustomer = () => state.boleta && `${state.boleta}\n\n${renderPagoMovil()}`;

  return { declarations: ORDER_TOOL_DECLARATIONS, execute, finalize, state };
}
