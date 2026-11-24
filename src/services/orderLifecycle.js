/**
 * Estados del pedido. El dinero no vive en el chat: cada cambio es un evento.
 * borrador -> boleta_enviada -> pago_reportado -> pago_verificado -> en_logistica -> entregado
 * cancelado puede salir de cualquiera de los anteriores.
 */

export const LIFECYCLE = [
  'borrador',
  'boleta_enviada',
  'pago_reportado',
  'pago_verificado',
  'en_logistica',
  'entregado',
  'cancelado',
];

const RANK = {
  borrador: 1,
  boleta_enviada: 2,
  pago_reportado: 3,
  pago_verificado: 4,
  en_logistica: 5,
  entregado: 6,
  cancelado: 7,
};

const OPEN = new Set(['borrador', 'boleta_enviada', 'pago_reportado', 'pago_verificado', 'en_logistica']);

export function lifecycleFromLegacy(status) {
  return {
    abierto: 'borrador',
    boleta: 'boleta_enviada',
    recibido: 'en_logistica',
    cancelado: 'cancelado',
  }[status] || 'borrador';
}

export function legacyStatus(lifecycle) {
  switch (lifecycle) {
    case 'borrador': return 'abierto';
    case 'boleta_enviada':
    case 'pago_reportado': return 'boleta';
    case 'pago_verificado':
    case 'en_logistica':
    case 'entregado': return 'recibido';
    case 'cancelado': return 'cancelado';
    default: return 'abierto';
  }
}

/** No baja de estado. Cancelar sí pisa cualquier estado. */
export function mergeLifecycle(current, incoming) {
  if (incoming === 'cancelado') return 'cancelado';
  if (!incoming) return current || 'borrador';
  if (!current) return incoming;
  if (current === 'boleta_enviada' && incoming === 'borrador') return 'borrador';
  return (RANK[incoming] || 0) >= (RANK[current] || 0) ? incoming : current;
}

export function isOpenLifecycle(lifecycle) {
  return OPEN.has(lifecycle);
}

/** Un pago reportado no se borra por ORDER_MEMORY_HOURS. */
export function isProtectedFromExpiry(order) {
  if (!order) return false;
  if (['pago_reportado', 'pago_verificado', 'en_logistica'].includes(order.lifecycle)) return true;
  return Boolean(order.payment_reference || order.payment_media_id);
}

export function stockLines(items = []) {
  return items
    .filter((item) => item && item.precio != null && item.nombre)
    .map((item) => ({
      sku: item.sku || null,
      nombre: item.nombre,
      cantidad: Number(item.cantidad) || 1,
    }));
}

export function isPickupText(text) {
  return /retiro\s+en\s+(la\s+)?tienda|paso\s+a\s+(buscar|buscarlo)|voy\s+a\s+(buscar|buscarlo|pasar)|recoger\s+en\s+(la\s+)?tienda|pickup/i.test(String(text || ''));
}

export function hasHouseNumber(address) {
  if (isPickupText(address)) return true;
  return /\d/.test(String(address || '')) || /\b(quinta|qta\.?)\s+\S+|\bs\/n\b|\bsin\s+n[uú]mero\b/i.test(String(address || ''));
}

export function hasValidLocation(order) {
  if (!order) return false;
  if (order.fulfillment === 'pickup' || isPickupText(order.address)) return true;
  if (order.location_lat != null && order.location_lng != null) return true;
  return Boolean(order.address) && hasHouseNumber(order.address);
}

export function paymentWasReported(order) {
  if (!order) return false;
  return ['pago_reportado', 'pago_verificado', 'en_logistica', 'entregado'].includes(order.lifecycle)
    || Boolean(order.payment_reference || order.payment_media_id);
}

export function shouldEnterLogistics(order) {
  return paymentWasReported(order) && hasValidLocation(order) && order.lifecycle !== 'cancelado';
}

const ADDRESS_RE = /\b(torre|calle|carrera|avenida|av\.|urbanizacion|urbanización|urb\.|edificio|edif\.?|piso|apto|apartamento|casa|sector|quinta|manzana|direccion|dirección|entrega|las mercedes|referencia)\b/i;
const PRODUCT_RE = /\b(harina|queso|jamon|jamón|aceite|arroz|pasta|precio|cuesta|kilo|kg)\b/i;
const PAYMENT_RE = /referencia|comprobante|pago\s*m[oó]vil|pagu[eé]|ya\s+pagu|transferenc|baucher|voucher|captura/i;
const CHECKOUT_RE = /^(es todo|nada mas|nada más|mas nada|más nada|listo|confirmar|confirmo|eso es todo|solo eso|sólo eso|ya esta|ya está|no mas|no más)\b/i;
const LOCATION_RE = /^\/ubicacion\b|comparti[oó] su ubicaci[oó]n|\blat\s*-?\d+(?:\.\d+)?\s*,\s*lon\s*-?\d/i;

/** Dirección, pago o cierre: no es una búsqueda de catálogo. */
export function isOperationalTurn(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (LOCATION_RE.test(raw) || PAYMENT_RE.test(raw) || CHECKOUT_RE.test(raw) || isPickupText(raw)) return true;
  if (ADDRESS_RE.test(raw) && !PRODUCT_RE.test(raw)) return true;
  return false;
}

export function parseLocation(text) {
  const raw = String(text || '');
  const cmd = raw.match(/^\/ubicacion\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (cmd) return { lat: Number(cmd[1]), lng: Number(cmd[2]), label: 'Ubicación enviada por el cliente' };
  const pin = raw.match(/lat\s*(-?\d+(?:\.\d+)?)\s*,\s*lon\s*(-?\d+(?:\.\d+)?)/i);
  if (pin) {
    const name = raw.match(/ubicaci[oó]n:\s*([^(\n]+)/i)?.[1]?.trim();
    return { lat: Number(pin[1]), lng: Number(pin[2]), label: name || 'Ubicación de WhatsApp' };
  }
  return null;
}

export function parsePaymentReport(text) {
  const raw = String(text || '');
  const mediaId = raw.match(/\bid:([A-Za-z0-9._:-]+)/)?.[1] || null;
  const labeled = raw.match(/referencia\s*[:#]?\s*(\d{4,14})/i)?.[1] || null;
  const loose = raw.match(/\b(\d{6,14})\b/)?.[1] || null;
  const mentions = PAYMENT_RE.test(raw);
  const attachment = /adjunt[oó] una imagen|adjunt[oó] un documento/i.test(raw);
  if (!mentions && !attachment) return null;
  return {
    reference: labeled || (mentions ? loose : null),
    mediaId,
    attachment,
    weak: attachment && !mentions && !labeled,
  };
}

export function isCheckoutClose(text) {
  return CHECKOUT_RE.test(String(text || '').trim());
}

export function blankOrder(phone) {
  return {
    id: null,
    phone,
    status: 'abierto',
    lifecycle: 'borrador',
    items: [],
    address: null,
    fulfillment: null,
    location_lat: null,
    location_lng: null,
    location_label: null,
    payment_reference: null,
    payment_media_id: null,
    payment_note: null,
    stock_deducted: false,
    total_usd: null,
    total_bs: null,
    bcv_rate: null,
    boleta_pendiente: 0,
  };
}

function clone(order) {
  return {
    ...order,
    items: Array.isArray(order.items) ? order.items.map((item) => ({ ...item })) : [],
  };
}

function event(order, from, actor, detail) {
  return {
    order_id: order.id,
    wa_id: order.phone,
    from_state: from,
    to_state: order.lifecycle,
    actor,
    detail,
  };
}

function place(order, lifecycle) {
  order.lifecycle = lifecycle;
  order.status = legacyStatus(lifecycle);
  if (lifecycle === 'en_logistica' || lifecycle === 'pago_verificado' || lifecycle === 'entregado') {
    order.kitchen_status = order.kitchen_status || 'nuevo';
  }
}

/**
 * Aplica un cambio al pedido en memoria. No escribe en la base.
 * @returns {{ order?: object, event?: object, ledger?: {action:string, lines:object[]}|null, logistics?: boolean, error?: string, customerReply?: string, notice?: string }}
 */
export function reduceOrder(order, action) {
  const type = action?.type;
  const current = order ? clone(order) : null;
  const from = current?.lifecycle || null;

  if (type === 'add_item') {
    const next = current && isOpenLifecycle(current.lifecycle) && !['pago_verificado', 'en_logistica', 'entregado'].includes(current.lifecycle)
      ? current
      : blankOrder(action.phone);
    if (['pago_reportado'].includes(current?.lifecycle) && current?.phone === action.phone) {
      return { error: 'El pago de este pedido ya fue reportado. No agregue productos hasta que el asesor lo revise.' };
    }
    next.items.push(action.item);
    place(next, 'borrador');
    return { order: next, event: event(next, from, action.actor || 'barbara', { tipo: 'agregar', nombre: action.item?.nombre }), ledger: null, logistics: false };
  }

  if (!current) return { error: 'No hay un pedido en curso.' };

  if (type === 'boleta') {
    if (!current.items.length) return { error: 'El pedido está vacío.' };
    place(current, 'boleta_enviada');
    if (action.totals) {
      current.total_usd = action.totals.totalUsd;
      current.total_bs = action.totals.totalBs;
      current.bcv_rate = action.totals.rate ?? null;
    }
    return { order: current, event: event(current, from, 'barbara', { tipo: 'boleta' }), ledger: null, logistics: false };
  }

  if (type === 'save_address') {
    if (!current.items?.length) return { error: 'No hay productos para asociar la dirección.' };
    if (!['borrador', 'boleta_enviada', 'pago_reportado', 'pago_verificado'].includes(current.lifecycle)) {
      return { error: 'Ese pedido ya no admite dirección.' };
    }
    const raw = String(action.address || '').trim();
    const pickup = isPickupText(raw);
    if (!pickup && !hasHouseNumber(raw)) {
      return { error: 'Falta el número de casa o apto.', missingHouseNumber: true };
    }
    current.address = pickup ? '🏪 Retiro en tienda' : raw;
    current.fulfillment = pickup ? 'pickup' : 'delivery';
    if (action.totals) {
      current.total_usd = action.totals.totalUsd;
      current.total_bs = action.totals.totalBs;
      current.bcv_rate = action.totals.rate ?? null;
    }
    const logistics = shouldEnterLogistics(current);
    if (logistics && current.lifecycle === 'pago_verificado') place(current, 'en_logistica');
    return {
      order: current,
      event: event(current, from, 'cliente', { tipo: 'direccion', address: current.address }),
      ledger: null,
      logistics,
      notice: logistics ? logisticsNotice(current, action.name) : null,
    };
  }

  if (type === 'save_location') {
    current.location_lat = action.lat;
    current.location_lng = action.lng;
    current.location_label = action.label || 'Ubicación de WhatsApp';
    if (!current.fulfillment) current.fulfillment = 'delivery';
    const logistics = shouldEnterLogistics(current);
    if (logistics && current.lifecycle === 'pago_verificado') place(current, 'en_logistica');
    return {
      order: current,
      event: event(current, from, 'cliente', { tipo: 'ubicacion', lat: action.lat, lng: action.lng }),
      ledger: null,
      logistics,
      notice: logistics ? logisticsNotice(current, action.name) : null,
    };
  }

  if (type === 'report_payment') {
    if (!['boleta_enviada', 'pago_reportado', 'pago_verificado', 'en_logistica'].includes(current.lifecycle)) {
      return { error: 'Todavía no hay una boleta para reportar el pago.' };
    }
    current.payment_reference = action.reference || current.payment_reference;
    current.payment_media_id = action.mediaId || current.payment_media_id;
    current.payment_note = action.note || current.payment_note;
    if (!['pago_verificado', 'en_logistica', 'entregado'].includes(current.lifecycle)) place(current, 'pago_reportado');
    const logistics = shouldEnterLogistics(current);
    if (logistics && current.lifecycle === 'pago_verificado') place(current, 'en_logistica');
    return {
      order: current,
      event: event(current, from, 'cliente', { tipo: 'pago_reportado', referencia: current.payment_reference, comprobante: current.payment_media_id }),
      ledger: null,
      logistics,
      notice: logistics ? logisticsNotice(current, action.name) : null,
      customerReply: customerAfterPayment(current, action.name),
    };
  }

  if (type === 'verify_payment') {
    if (current.lifecycle === 'cancelado') return { error: 'Ese pedido está cancelado.' };
    if (!paymentWasReported(current) && current.lifecycle !== 'pago_reportado') {
      return { error: 'El cliente todavía no reportó el pago.' };
    }
    const already = current.stock_deducted === true;
    if (current.lifecycle !== 'en_logistica' && current.lifecycle !== 'entregado') {
      place(current, hasValidLocation(current) ? 'en_logistica' : 'pago_verificado');
    }
    current.stock_deducted = true;
    const logistics = shouldEnterLogistics(current);
    return {
      order: current,
      event: event(current, from, action.actor || 'operador', { tipo: 'pago_verificado', ya_descontado: already }),
      ledger: already ? null : { action: 'deduct', lines: stockLines(current.items) },
      logistics,
      notice: logistics ? logisticsNotice(current, action.name) : null,
      customerReply: 'Listo: el asesor confirmó su pago. Gracias por comprar en *Abasto Los Cuchos*.',
    };
  }

  if (type === 'reject_payment') {
    if (current.lifecycle === 'cancelado') return { error: 'Ese pedido está cancelado.' };
    const restore = current.stock_deducted === true;
    place(current, 'boleta_enviada');
    current.stock_deducted = false;
    return {
      order: current,
      event: event(current, from, action.actor || 'operador', { tipo: 'pago_rechazado' }),
      ledger: restore ? { action: 'restore', lines: stockLines(current.items) } : null,
      logistics: false,
      customerReply: 'Disculpe, no pudimos validar el comprobante. El pago no está confirmado. ¿Podría enviarlo de nuevo, por favor?',
    };
  }

  if (type === 'cancel') {
    const restore = current.stock_deducted === true;
    place(current, 'cancelado');
    current.stock_deducted = false;
    return {
      order: current,
      event: event(current, from, action.actor || 'barbara', { tipo: 'cancelado' }),
      ledger: restore ? { action: 'restore', lines: stockLines(current.items) } : null,
      logistics: false,
    };
  }

  return { error: `Cambio desconocido: ${type}` };
}

export function locationText(order) {
  if (!order) return 'sin ubicación';
  if (order.fulfillment === 'pickup' || isPickupText(order.address)) return 'retiro en tienda';
  if (order.location_lat != null && order.location_lng != null) {
    return `${order.location_label || 'punto'} (${order.location_lat}, ${order.location_lng})`;
  }
  return order.address || 'sin ubicación';
}

export function logisticsNotice(order, name) {
  const who = name || `+${order.phone}`;
  const usd = order.total_usd != null ? `$ ${Number(order.total_usd).toFixed(2)}` : 'USD por confirmar';
  const bs = order.total_bs != null ? `Bs. ${Number(order.total_bs).toFixed(2)}` : 'Bs. por confirmar';
  return `El cliente ${who} pagó el pedido #${order.id} (${bs} / ${usd}, referencia ${order.payment_reference || 'sin número'}, comprobante ${order.payment_media_id || 'no adjunto'}) y envió la ubicación: ${locationText(order)}.`;
}

export function customerAfterPayment(order, name) {
  const ref = order.payment_reference ? ` Recibimos la referencia *${order.payment_reference}*.` : '';
  const base = `Recibimos su reporte de pago.${ref} Todavía no está confirmado: un asesor lo revisa con el banco y le avisamos cuando quede verificado.`;
  if (shouldEnterLogistics(order)) {
    const who = name ? `, ${String(name).split(' ')[0]}` : '';
    return `Listo${who}. Ya tenemos el pedido y la ubicación. Un agente de *Abasto Los Cuchos* coordinará la entrega con usted.${ref} El pago sigue en verificación; no está confirmado hasta que el asesor lo revise.`;
  }
  if (!hasValidLocation(order)) {
    return `${base}\n\nPara coordinar la entrega envíe la dirección con número de casa, su ubicación de WhatsApp, o escriba “retiro en tienda”.`;
  }
  return base;
}

export function customerLogisticsReply(name) {
  const who = name ? `, ${String(name).split(' ')[0]}` : '';
  return `Listo${who}. Un agente de *Abasto Los Cuchos* coordinará la entrega con usted. El pago queda en verificación hasta que el asesor lo confirme.`;
}

/** Resumen corto para el modelo. No incluye precios inventados. */
export function renderProfileSummary(profile, orders = []) {
  const done = (orders || []).filter((order) => order && order.lifecycle !== 'cancelado' && order.items?.length);
  const last = [...done].reverse().find((order) => order.lifecycle !== 'borrador') || done.at(-1);
  const parts = [];
  if (done.some((order) => order.lifecycle && order.lifecycle !== 'borrador')) parts.push('Cliente frecuente');
  const nombre = profile?.display_name;
  if (nombre) parts.push(`nombre: ${nombre}`);
  if (last?.items?.length) {
    const items = last.items.map((item) => `${item.cantidad ?? 1} ${item.nombre}`).join(', ');
    parts.push(`última compra: ${items}`);
  }
  const address = profile?.addresses?.[0]?.text || last?.address;
  if (address) parts.push(`dirección guardada: ${address}`);
  if (profile?.fulfillment === 'pickup' || last?.fulfillment === 'pickup') parts.push('prefiere retiro en tienda');
  else if (profile?.fulfillment === 'delivery' || address) parts.push('prefiere delivery');
  if (profile?.notes) parts.push(`nota: ${profile.notes}`);
  if (!parts.length) return '';
  return `${parts.join(', ')}.`;
}
