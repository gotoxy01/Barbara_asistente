import { Type } from '@google/genai';
import { config } from '../config.js';
import * as db from '../db.js';
import { toBolivares } from './bcvService.js';
import { findProduct, getDeliveryCost, isBotellon, productLabel } from './catalogService.js';

export const BOLETA_MARKER = '[BOLETA]';

export const MORE_ITEMS_QUESTION = '¿Desea agregar algo más? 🛒';

export function renderPagoMovil() {
  const { telefono, cedula, banco } = config.pagoMovil;
  return `📲 *Datos para Pago Móvil:*\n• Tlf: ${telefono}\n• C.I.: ${cedula}\n• Banco: ${banco}`;
}
export const ADDRESS_QUESTION =
  'Para proceder con el envío, por favor indíquenos su dirección exacta y un punto de referencia. 🏠\n\n' +
  '⚠️ *Importante:* no olvide indicar su *número de casa* (o de apto/quinta); sin él no podemos finalizar su pedido.';

export const HOUSE_NUMBER_REMINDER =
  '⚠️ Para poder finalizar su pedido nos falta su *número de casa* (o de apto/quinta). 🏠\n\n' +
  'Por favor, indíquenos su número de casa y en seguida cerramos su pedido.';

/** La dirección debe traer número de casa/apto, nombre de quinta o un "sin número" explícito. */
export function hasHouseNumber(address) {
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
 * Un solo delivery por pedido, al precio del artículo "Delivery costo" del sistema de caja.
 * @param {object[]} items
 * @param {import('./bcvService.js').BcvRate|null} bcv
 */
export function computeTotals(items, bcv) {
  const rate = bcv?.rate;
  const line = (usd) => ({ usd: round2(usd), bs: rate ? toBolivares(usd, rate) : null });

  const lines = items.filter((i) => i.precio != null).map((item) => ({
    label: itemLabel(item),
    ...line(item.precio * item.cantidad),
  }));
  const pending = pendingWeighItems(items).map((i) => i.detalle);

  const fees = [];
  if (items.length) fees.push({ label: '🚚 Delivery', ...line(getDeliveryCost()) });

  const all = [...lines, ...fees];
  const totalUsd = round2(all.reduce((s, l) => s + l.usd, 0));
  // El total en Bs es la suma de las líneas, para que la boleta cuadre al sumarla a mano.
  const totalBs = rate ? round2(all.reduce((s, l) => s + l.bs, 0)) : null;
  return { lines, fees, pending, totalUsd, totalBs, rate };
}

export function renderBoleta(items, bcv) {
  const t = computeTotals(items, bcv);
  return [
    '🧾 *RESUMEN DE SU PEDIDO - Abasto Los Cuchos*',
    SEPARATOR,
    ...[...t.lines, ...t.fees].map((l) => `• ${l.label}: ${money(l.usd, l.bs)}`),
    SEPARATOR,
    `💰 *TOTAL A PAGAR:* ${money(t.totalUsd, t.totalBs)}`,
    t.rate ? `(Calculado a Tasa BCV: ${t.rate.toFixed(2)} Bs/USD)` : '(El monto en Bs. se calcula a la Tasa BCV del día al momento del pago)',
  ].join('\n');
}

/** Tarifa de delivery ya convertida a Bs, para que la IA no tenga que calcularla. */
export function renderDeliveryFees(bcv) {
  const usd = getDeliveryCost();
  const fee = bcv ? `Bs. ${toBolivares(usd, bcv.rate).toFixed(2)} (o $ ${usd.toFixed(2)} USD)` : `$ ${usd.toFixed(2)} USD`;
  return `TARIFA DE DELIVERY: ${fee} por pedido (una sola vez, sin importar los productos).`;
}

/** Resumen del carrito para el System Prompt de Bárbara. */
export function renderOrderContext(phone, bcv) {
  const order = db.getActiveOrder(phone);
  if (!order || !order.items.length) return 'El cliente aún no tiene productos en su pedido.';
  const t = computeTotals(order.items, bcv);
  const status = order.status === 'boleta'
    ? 'BOLETA YA ENVIADA: falta que el cliente indique su dirección de entrega.'
    : 'EN CURSO: el cliente sigue agregando productos.';
  return [
    `Estado: ${status}`,
    ...[...t.lines, ...t.fees].map((l) => `- ${l.label}: ${money(l.usd, l.bs)}`),
    ...pendingWeighItems(order.items).map((i) => (i.consulta
      ? `- 🔎 ${i.detalle}: PENDIENTE DE CONSULTA (el encargado en caja está verificando disponibilidad y precio)`
      : `- ⚖️ ${i.detalle}: PENDIENTE DE PESAJE (el encargado en caja lo está pesando; aún no tiene precio)`)),
    `Total actual${t.pending.length ? ' (sin los productos pendientes del encargado)' : ''}: ${money(t.totalUsd, t.totalBs)}`,
    ...(order.boleta_pendiente ? ['El cliente ya pidió cerrar el pedido: la boleta se enviará sola en cuanto el encargado envíe el precio.'] : []),
  ].join('\n');
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
function closePending(order, header, bcv) {
  if (order.boleta_pendiente && order.items.length) {
    const t = computeTotals(order.items, bcv);
    Object.assign(order, { status: 'boleta', boleta_pendiente: 0, total_usd: t.totalUsd, total_bs: t.totalBs, bcv_rate: t.rate ?? null });
    db.saveOrder(order);
    return { order, message: `${header}\n\n${renderBoleta(order.items, bcv)}\n\n${renderPagoMovil()}\n\n${ADDRESS_QUESTION}` };
  }
  order.boleta_pendiente = 0;
  db.saveOrder(order);
  const closing = order.items.length ? MORE_ITEMS_QUESTION : '¿Le puedo ayudar con algún otro producto? 😊';
  return { order, message: `${header}\n\n${closing}` };
}

/** El encargado indicó que NO hay los productos consultados: se quitan del pedido y se avisa al cliente. */
export function applyNotAvailable(phone, bcv) {
  const order = db.getActiveOrder(phone);
  const pending = order ? pendingWeighItems(order.items) : [];
  if (!pending.length) return { error: `+${phone} no tiene productos pendientes de consulta.` };

  order.items = order.items.filter((i) => i.precio != null);
  const header = `Disculpe, el encargado en caja me confirma que por ahora *no tenemos disponible*: ${pending.map((i) => i.detalle).join(', ')}. 😔`;
  return closePending(order, header, bcv);
}

/**
 * Aplica el precio que envió el encargado a TODOS los productos por pesar del cliente.
 * Devuelve el mensaje para el cliente (o la boleta, si ya había pedido cerrar el pedido).
 */
export function applyWeighedPrice(phone, usd, bcv) {
  const order = db.getActiveOrder(phone);
  const pending = order ? pendingWeighItems(order.items) : [];
  if (!pending.length) return { error: `+${phone} no tiene productos pendientes por pesar.` };

  const detalle = pending.map((i) => i.detalle).join(', ');
  const consulta = pending.every((i) => i.consulta);
  order.items = order.items.filter((i) => i.precio != null);
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
    description: 'Elimina todos los productos del pedido (solo si el cliente pide cancelar o empezar de nuevo).',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'generar_boleta',
    description: 'Cierra la selección y genera la boleta detallada con delivery y total. Úsala cuando el cliente confirme que es todo ("es todo", "nada más", "confirmar", etc.).',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'registrar_direccion',
    description: 'Guarda la dirección de entrega que el cliente envió después de recibir la boleta, y envía el pedido al equipo de despacho.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        direccion: { type: Type.STRING, description: 'Dirección exacta, número de casa/apto y punto de referencia, tal como los escribió el cliente' },
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
    agregar_producto({ producto, cantidad }) {
      const qty = Number(cantidad);
      if (!(qty > 0)) return { error: 'La cantidad debe ser mayor que cero.' };
      const found = findProduct(String(producto ?? ''));
      if (found.options) return { error: 'Hay varios productos parecidos; pregunte al cliente cuál desea.', opciones: optionsList(found.options) };
      if (!found.product) return { error: `"${producto}" no está en el catálogo.` };

      const p = found.product;
      let addQty = qty;

      // "dame $2 de queso": convierte monto → kilos con el precio/kg de la BD (sin pesaje).
      const moneyUsd = moneyAmountMentioned(customerText);
      if (isSoldByWeight(p) && moneyUsd > 0 && p.precio > 0) {
        addQty = round2(moneyUsd / p.precio);
        if (!(addQty > 0)) return { error: 'No se pudo calcular el peso a partir del monto.' };
      } else if (isSoldByWeight(p) && !weightMentionedFor(p.nombre, customerText)) {
        // "un aguacate", "3 plátanos": unidades → balanza.
        const result = handlers.solicitar_pesaje({ producto: p.nombre, cantidad: `${qty} ${qty === 1 ? 'unidad' : 'unidades'}` });
        return { ...result, nota: `El cliente pidió ${p.nombre} por unidades (no por kilos ni monto): se envió a pesar en caja.` };
      }

      const order = db.getOrCreateActiveOrder(phone);
      const existing = order.items.find((i) => i.nombre === p.nombre && i.presentacion === p.presentacion);
      if (existing) existing.cantidad = round2(existing.cantidad + addQty);
      else order.items.push({ nombre: p.nombre, presentacion: p.presentacion, precio: p.precio, cantidad: addQty, botellon: isBotellon(p) });
      order.status = 'abierto';
      db.saveOrder(order);
      state.cartChanged = true;
      state.catalogAdded = true;
      const nota = moneyUsd > 0 && isSoldByWeight(p)
        ? `Calculado: $ ${moneyUsd.toFixed(2)} ÷ $ ${p.precio}/kg = ${addQty} kg (sin molestar al encargado).`
        : undefined;
      return { ok: true, agregado: `${addQty} x ${productLabel(p)}`, ...(nota ? { nota } : {}), pedido: summarize(order, bcv) };
    },

    solicitar_pesaje({ producto, cantidad }) {
      const nombre = String(producto ?? '').trim();
      if (!nombre) return { error: 'Indique el producto a pesar.' };
      const qty = String(cantidad ?? '').trim();
      const detalle = qty ? `${nombre} (${qty})` : nombre;
      const order = db.getOrCreateActiveOrder(phone);
      order.items.push({ nombre, presentacion: 'por pesar', detalle, precio: null, cantidad: 1, pesable: true, botellon: false });
      order.status = 'abierto';
      db.saveOrder(order);
      state.cartChanged = true;
      state.weighed.push(nombre);
      return {
        ok: true,
        anotado_para_pesar: detalle,
        instruccion: 'El sistema avisa al encargado y envía al cliente el mensaje de espera. No inventes precio para este producto ni generes la boleta todavía.',
      };
    },

    consultar_encargado({ producto, cantidad, tipo }) {
      const nombre = String(producto ?? '').trim();
      if (!nombre) return { error: 'Indique el artículo a consultar.' };
      const qty = String(cantidad ?? '').trim();
      const detalle = qty ? `${nombre} (${qty})` : nombre;
      const order = db.getOrCreateActiveOrder(phone);
      order.items.push({
        nombre, presentacion: tipo === 'farmacia' ? 'farmacia' : 'ferretería', detalle,
        precio: null, cantidad: 1, pesable: true, consulta: true, botellon: false,
      });
      order.status = 'abierto';
      db.saveOrder(order);
      state.cartChanged = true;
      state.consulted.push({ nombre, tipo: tipo === 'farmacia' ? 'farmacia' : 'ferreteria' });
      return {
        ok: true,
        consultado_al_encargado: detalle,
        instruccion: 'El sistema avisa al encargado y envía al cliente el mensaje de espera. No des precio ni confirmes disponibilidad de este artículo; espera la respuesta del encargado.',
      };
    },

    quitar_producto({ producto, cantidad }) {
      const order = db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'El pedido está vacío.' };
      const wanted = String(producto ?? '').toLowerCase();
      const item = order.items.find((i) => `${i.nombre} (${i.presentacion})`.toLowerCase() === wanted)
        ?? order.items.find((i) => `${i.nombre} (${i.presentacion})`.toLowerCase().includes(wanted) || wanted.includes(i.nombre.toLowerCase()));
      if (!item) return { error: `"${producto}" no está en el pedido.`, pedido: summarize(order, bcv) };

      const qty = Number(cantidad);
      if (qty > 0 && qty < item.cantidad) item.cantidad = round2(item.cantidad - qty);
      else order.items = order.items.filter((i) => i !== item);
      order.status = 'abierto';
      db.saveOrder(order);
      state.cartChanged = true;
      return { ok: true, pedido: summarize(order, bcv) };
    },

    vaciar_pedido() {
      const order = db.getActiveOrder(phone);
      if (order) {
        order.items = [];
        order.status = 'abierto';
        db.saveOrder(order);
      }
      state.cartChanged = true;
      return { ok: true };
    },

    generar_boleta() {
      const order = db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'El pedido está vacío; pregunte al cliente qué productos desea.' };
      if (pendingWeighItems(order.items).length) {
        order.boleta_pendiente = 1;
        db.saveOrder(order);
        state.waitingWeight = true;
        return {
          error: 'Hay productos esperando el precio del encargado (pesaje o consulta).',
          instruccion: 'Dile al cliente que en cuanto el encargado en caja confirme el precio le enviamos la boleta completa con el total. No escribas [BOLETA].',
        };
      }
      const t = computeTotals(order.items, bcv);
      Object.assign(order, { status: 'boleta', total_usd: t.totalUsd, total_bs: t.totalBs, bcv_rate: t.rate ?? null });
      db.saveOrder(order);
      state.boleta = renderBoleta(order.items, bcv);
      return {
        ok: true,
        instruccion: `Escribe exactamente ${BOLETA_MARKER} en tu respuesta (el sistema lo reemplaza por la boleta con los montos exactos) y a continuación pide la dirección de entrega. No escribas tú los montos ni el total.`,
      };
    },

    async registrar_direccion({ direccion }) {
      const order = db.getActiveOrder(phone);
      if (!order?.items.length) return { error: 'No hay un pedido en curso para este cliente.' };
      if (order.status !== 'boleta') return { error: 'Primero genere la boleta (generar_boleta) y confírmela con el cliente.' };
      const address = String(direccion ?? '').trim();
      if (!hasHouseNumber(address)) {
        state.missingHouseNumber = true;
        return {
          error: 'La dirección no incluye el número de casa/apto.',
          instruccion: 'NO registres el pedido todavía. Pide amablemente al cliente su número de casa (o apto/quinta) para poder finalizar el pedido.',
        };
      }
      order.address = address;
      order.status = 'recibido';
      db.saveOrder(order);
      state.addressSaved = true;

      await notify(
        `Pedido #${order.id}\nCliente: ${name || 'Sin nombre'} (+${phone})\nDirección: ${order.address}\n\n${renderBoleta(order.items, bcv)}`,
        { kind: 'order', phone, title: `Nuevo pedido #${order.id}`, whatsapp: false },
      );
      return { ok: true, pedido_numero: order.id, direccion: order.address, instruccion: 'Confirma al cliente que su pedido fue registrado e incluye los datos de Pago Móvil.' };
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
    const terminal = new Set(['generar_boleta', 'registrar_direccion']);
    if (!calls.length || !calls.every((c) => terminal.has(c.name) && c.result?.ok)) return null;

    const address = calls.find((c) => c.name === 'registrar_direccion');
    if (address) {
      return `¡Muchas gracias${name ? `, ${name.split(' ')[0]}` : ''}! ✅ Su pedido *#${address.result.pedido_numero}* fue registrado con éxito.\n\n` +
        `📍 *Dirección de entrega:* ${address.result.direccion}\n\n` +
        'Si paga por Pago Móvil, envíenos la captura del pago por este chat y de inmediato despachamos su pedido. 🛵\n' +
        'También puede pagar en efectivo (USD o Bs.) al recibir. ¡Gracias por preferir *Abasto Los Cuchos*! 🙏';
    }
    return `${BOLETA_MARKER}\n\n${ADDRESS_QUESTION}`;
  }

  /** La boleta que ve el cliente lleva los datos de Pago Móvil (el aviso al asesor no). */
  state.boletaForCustomer = () => state.boleta && `${state.boleta}\n\n${renderPagoMovil()}`;

  return { declarations: ORDER_TOOL_DECLARATIONS, execute, finalize, state };
}
