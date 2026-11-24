import * as db from '../db.js';
import { publishCrm } from '../crm/events.js';
import { outboundRecord, sendMessage } from '../messenger.js';
import { getBcvRate } from './bcvService.js';
import {
  applyNotAvailable,
  applyWeighedPrice,
  computeTotals,
  pendingWeighItems,
  renderBoleta,
  renderPagoMovil,
} from './orderService.js';
import {
  clearEditingTicket,
  closeTicketsForPhone,
  getTicket,
  listOpenTickets,
  updateTicket,
} from './ticketStore.js';

function money(usd, bs) {
  if (bs == null) return `$ ${Number(usd).toFixed(2)}`;
  return `Bs. ${Number(bs).toFixed(2)} ($ ${Number(usd).toFixed(2)})`;
}

/**
 * Vista de bloc de notas: ticket + pedido actual + producto final estimado.
 * @param {object} ticket
 * @param {{ previewUsd?: number|null }} [opts]
 */
export async function decorateNote(ticket, { previewUsd = null } = {}) {
  const bcv = await getBcvRate();
  const order = db.getActiveOrder(ticket.clienteTelefono);
  const items = order?.items || [];
  // Siempre el pendiente REAL del carrito actual de ESE teléfono (no ítems viejos guardados en la nota).
  let pending = pendingWeighItems(items);
  if (ticket.items?.length && pending.length) {
    const keys = ticket.items.map((i) => String(i.detalle || i.nombre || '').toLowerCase()).filter(Boolean);
    const matched = pending.filter((p) => {
      const d = String(p.detalle || p.nombre || '').toLowerCase();
      return keys.some((k) => d.includes(k) || k.includes(d));
    });
    if (matched.length) pending = matched;
  }
  const totals = items.length ? computeTotals(items, bcv) : null;

  let previewMessage = null;
  let previewTotals = null;
  if (previewUsd > 0 && (ticket.motivo === 'pesaje' || ticket.motivo === 'caja' || pending.length)) {
    // Simula el carrito con el precio pendiente aplicado (sin guardar).
    const simulated = items
      .filter((i) => i.precio != null)
      .concat([{
        nombre: 'Productos pesados',
        presentacion: 'pesado en tienda',
        detalle: pending.map((i) => i.detalle).join(', ') || 'pendiente',
        precio: previewUsd,
        cantidad: 1,
        pesable: true,
      }]);
    previewTotals = computeTotals(simulated, bcv);
    previewMessage = [
      `✅ Precio anotado: $ ${Number(previewUsd).toFixed(2)}`,
      '',
      renderBoleta(simulated, bcv),
    ].join('\n');
  } else if (ticket.motivo === 'flete' && previewUsd > 0) {
    previewMessage =
      `✅ El envío hasta su zona queda en $ ${Number(previewUsd).toFixed(2)}` +
      (bcv ? ` (Bs. ${(previewUsd * bcv.rate).toFixed(2)})` : '') +
      '. ¿Desea continuar con el pedido?';
  } else if (ticket.motivo === 'pago') {
    previewMessage = '✅ Recibimos su comprobante. Su pedido será despachado en breve. 🛵';
  } else if (order?.status === 'boleta' || order?.status === 'recibido') {
    previewMessage = `${renderBoleta(items, bcv)}\n\n${renderPagoMovil()}`;
  } else if (totals) {
    previewMessage = [
      'Pedido actual (sin pendientes de balanza):',
      ...totals.lines.map((l) => `• ${l.label}: ${money(l.usd, l.bs)}`),
      ...totals.fees.map((l) => `• ${l.label}: ${money(l.usd, l.bs)}`),
      `Total parcial: ${money(totals.totalUsd, totals.totalBs)}`,
      pending.length ? `Pendiente: ${pending.map((p) => p).join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  return {
    ticketId: ticket.ticketId,
    motivo: ticket.motivo,
    estado: ticket.estado,
    phone: ticket.clienteTelefono,
    name: ticket.clienteNombre || db.getChat(ticket.clienteTelefono)?.name || null,
    items: ticket.items || [],
    pending: pending.map((i) => ({
      detalle: i.detalle,
      nombre: i.nombre,
      consulta: !!i.consulta,
    })),
    order: order ? {
      id: order.id,
      status: order.status,
      address: order.address,
      items: order.items,
      totalUsd: order.total_usd,
      totalBs: order.total_bs,
    } : null,
    totals: totals ? {
      lines: totals.lines,
      fees: totals.fees,
      pending: totals.pending,
      totalUsd: totals.totalUsd,
      totalBs: totals.totalBs,
    } : null,
    previewMessage,
    previewTotals: previewTotals ? {
      totalUsd: previewTotals.totalUsd,
      totalBs: previewTotals.totalBs,
    } : null,
    createdAt: ticket.createdAt,
    note: ticket.borradorRespuesta || '',
  };
}

function itemLine(i) {
  if (i.detalle) return i.detalle;
  if (i.precio == null) return `${i.nombre} (pendiente)`;
  const qty = /kilo/i.test(i.presentacion || '') ? `${i.cantidad} kg` : `${i.cantidad}×`;
  return `${qty} ${i.nombre}${i.presentacion ? ` (${i.presentacion})` : ''}`;
}

/** Comanda de pedido cerrado → nota del bloc (P-12). */
export async function decorateKitchenNote(order) {
  const bcv = await getBcvRate();
  const name = db.getChat(order.phone)?.name || null;
  const boleta = order.items?.length ? renderBoleta(order.items, bcv) : '';
  const kitchen = kitchenOf(order);
  return {
    kind: 'pedido',
    ticketId: `P-${order.id}`,
    orderId: order.id,
    motivo: 'pedido',
    estado: kitchen,
    kitchenStatus: kitchen,
    phone: order.phone,
    name,
    items: (order.items || []).map((i) => ({
      nombre: i.nombre,
      detalle: itemLine(i),
      cantidad: i.cantidad,
      presentacion: i.presentacion,
      precio: i.precio,
      consulta: !!i.consulta,
      // Texto listo para cocina/despacho
      prep: itemLine(i),
    })),
    pending: [],
    order: {
      id: order.id,
      status: order.status,
      address: order.address,
      items: order.items,
      totalUsd: order.total_usd,
      totalBs: order.total_bs,
      kitchenStatus: kitchen,
      createdAt: order.created_at || order.updated_at,
    },
    totals: order.items?.length ? (() => {
      const t = computeTotals(order.items, bcv);
      return { lines: t.lines, fees: t.fees, pending: t.pending, totalUsd: t.totalUsd, totalBs: t.totalBs };
    })() : null,
    previewMessage: [
      boleta,
      order.address ? `\n📍 ${order.address}` : '',
      `\nEstado cocina: ${kitchenLabel(kitchen)}`,
    ].join(''),
    previewTotals: order.total_usd != null ? { totalUsd: order.total_usd, totalBs: order.total_bs } : null,
    createdAt: order.created_at || order.updated_at,
    note: `Pedido #${order.id} listo para cocina/despacho.`,
  };
}

function kitchenLabel(s) {
  return ({ nuevo: '🆕 Nuevo', preparado: '🧺 Preparado', atendido: '🛵 Atendido', cancelado: '❌ Cancelado' })[s] || s;
}

/** Normaliza estado de cocina también si el pedido ya está cancelado a nivel status. */
function kitchenOf(order) {
  if (order.status === 'cancelado') return 'cancelado';
  return order.kitchen_status || 'nuevo';
}

const NOTE_WINDOW_MS = 24 * 3600 * 1000;

/** Cierra notas duplicadas del mismo chat+motivo (deja la más reciente). */
function dedupeOpenTickets(tickets) {
  const best = new Map();
  const drop = [];
  for (const t of tickets) {
    const phone = String(t.clienteTelefono || '').replace(/\D/g, '');
    const key = `${phone}::${t.motivo || 'pesaje'}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, t);
      continue;
    }
    if ((t.createdAt || 0) > (prev.createdAt || 0)) {
      drop.push(prev);
      best.set(key, t);
    } else {
      drop.push(t);
    }
  }
  for (const t of drop) updateTicket(t.ticketId, { estado: 'CERRADO' });
  return [...best.values()];
}

export async function listNotes() {
  const since = Date.now() - NOTE_WINDOW_MS;
  // Solo tickets de las últimas 24 h (nada viejo saturando el bloc).
  let tickets = dedupeOpenTickets(
    listOpenTickets(60).filter((t) => (t.createdAt || 0) >= since),
  );
  // Cierra notas de pesaje huérfanas (carrito ya no tiene pendientes = pedido viejo/cancelado).
  tickets = tickets.filter((t) => {
    if (!['pesaje', 'caja'].includes(t.motivo || '')) return true;
    const order = db.getActiveOrder(t.clienteTelefono);
    const pending = order ? pendingWeighItems(order.items) : [];
    if (pending.length) return true;
    updateTicket(t.ticketId, { estado: 'CERRADO' });
    return false;
  });
  const kitchen = db.listKitchenOrders(40, 24);

  const ticketNotes = [];
  for (const t of tickets) {
    // Solo ítems/pedido de ESE teléfono: nunca mezclar chats.
    const note = await decorateNote(t);
    if (note.phone && t.clienteTelefono && String(note.phone).replace(/\D/g, '') !== String(t.clienteTelefono).replace(/\D/g, '')) {
      continue;
    }
    ticketNotes.push(note);
  }
  const orderNotes = [];
  for (const o of kitchen) orderNotes.push(await decorateKitchenNote(o));

  // Más recientes primero; números 1…n
  const merged = [...ticketNotes, ...orderNotes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return merged.map((note, i) => ({ n: i + 1, ...note }));
}

/** Pedidos recibidos/cancelados visibles (últimas 24 h) para el tablero principal. */
export async function listOrderNotes() {
  const orders = db.listOrdersLastHours(24, 50)
    .filter((o) => !o.board_hidden)
    .filter((o) => o.status === 'recibido' || o.status === 'cancelado' || o.kitchen_status === 'cancelado');
  const notes = [];
  for (const o of orders) notes.push(await decorateKitchenNote(o));
  return notes.map((note, i) => ({ n: i + 1, ...note }));
}

export async function getNoteById(id, { previewUsd = null } = {}) {
  if (String(id).startsWith('P-')) {
    const orderId = Number(String(id).slice(2));
    const order = db.getOrderById(orderId);
    if (!order || order.board_hidden) return null;
    if (!['recibido', 'cancelado'].includes(order.status)) return null;
    return decorateKitchenNote(order);
  }
  const ticket = getTicket(id);
  if (!ticket || ticket.estado === 'CERRADO') return null;
  return decorateNote(ticket, { previewUsd });
}

/**
 * Marca la comanda: preparado / atendido / cancelado.
 * Opcionalmente avisa al cliente por WhatsApp.
 */
export async function noteKitchenStatus(noteId, status, { notifyCustomer = true } = {}) {
  if (!String(noteId).startsWith('P-')) return { error: 'Solo aplica a comandas de pedido (P-…)' };
  const orderId = Number(String(noteId).slice(2));
  const allowed = new Set(['preparado', 'atendido', 'cancelado', 'nuevo']);
  if (!allowed.has(status)) return { error: 'Estado inválido' };

  const before = db.getOrderById(orderId);
  if (!before) return { error: 'Pedido no encontrado' };
  if (!['recibido', 'cancelado'].includes(before.status)) return { error: 'Pedido no encontrado' };
  if (before.board_hidden) return { error: 'Este pedido ya fue borrado del tablero' };

  const order = db.setKitchenStatus(orderId, status);
  if (!order) return { error: 'No se pudo actualizar' };

  if (status === 'cancelado') {
    closeTicketsForPhone(order.phone);
    // No dejar carritos abiertos/pesajes viejos colgados en el mismo chat.
    db.clearActiveCarts(order.phone);
    db.startFreshActiveOrder(order.phone);
  }

  let message = null;
  if (notifyCustomer) {
    if (status === 'preparado') {
      message = `¡Listo! Su pedido *#${order.id}* ya se está preparando. En breve le avisamos. 🧺`;
    } else if (status === 'atendido') {
      message = `Su pedido *#${order.id}* ya fue atendido y va en camino / listo para entrega. ¡Gracias por preferir *Abasto Los Cuchos*! 🛵🙏`;
    } else if (status === 'cancelado') {
      message = `Su pedido *#${order.id}* fue cancelado. Disculpe las molestias. Si desea armar otro, escríbanos por aquí. 🙏\n[PEDIDO_CANCELADO]`;
    }
    if (message) {
      try {
        const forCustomer = message.replace(/\[PEDIDO_CANCELADO\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
        const sent = await sendMessage(order.phone, forCustomer);
        const stored = outboundRecord(sent, message);
        db.addMessage(order.phone, 'model', stored.includes('[PEDIDO_CANCELADO]') || !message.includes('[PEDIDO_CANCELADO]')
          ? stored
          : `${stored}\n[PEDIDO_CANCELADO]`);
      } catch (err) {
        return { ok: true, order, warning: `Estado guardado, pero no se pudo avisar al cliente: ${err.message}` };
      }
    }
  } else if (status === 'cancelado') {
    db.addMessage(
      order.phone,
      'model',
      `Pedido #${order.id} cancelado desde el negocio.\n[PEDIDO_CANCELADO]`,
    );
  }

  if (status === 'atendido' || status === 'cancelado') {
    db.resolveAlertsByPhoneKind(order.phone, 'order');
  }
  publishCrm({ type: 'note_done', ticketId: noteId, phone: order.phone, kitchenStatus: status });
  return { ok: true, order, message, kitchenStatus: status };
}

/** Quita del tablero un pedido ya realizado o cancelado (el chat no se borra). */
export async function noteDeleteFinished(noteId) {
  if (!String(noteId).startsWith('P-')) return { error: 'Solo se pueden borrar comandas de pedido (P-…)' };
  const orderId = Number(String(noteId).slice(2));
  const before = db.getOrderById(orderId);
  if (!before) return { error: 'Pedido no encontrado' };
  const done = before.kitchen_status === 'atendido'
    || before.kitchen_status === 'cancelado'
    || before.status === 'cancelado';
  if (!done) {
    return { error: 'Solo se pueden borrar pedidos ya realizados o cancelados' };
  }
  const order = db.hideFinishedOrderFromBoard(orderId);
  if (!order) return { error: 'No se pudo borrar del tablero' };
  closeTicketsForPhone(order.phone);
  db.resolveAlertsByPhoneKind(order.phone, 'order');
  publishCrm({ type: 'note_deleted', ticketId: noteId, phone: order.phone });
  return { ok: true, order };
}

/** @deprecated alias */
export async function noteDeleteCanceled(noteId) {
  return noteDeleteFinished(noteId);
}

async function deliverAndClose(ticket, message, extraResolveKinds = []) {
  const sent = await sendMessage(ticket.clienteTelefono, message);
  db.addMessage(ticket.clienteTelefono, 'model', outboundRecord(sent, message));
  db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'weigh');
  db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'payment');
  db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'ticket');
  for (const kind of extraResolveKinds) db.resolveAlertsByPhoneKind(ticket.clienteTelefono, kind);
  clearEditingTicket(ticket.ticketId);
  updateTicket(ticket.ticketId, { estado: 'CERRADO', borradorRespuesta: message });
  publishCrm({ type: 'note_done', ticketId: ticket.ticketId, phone: ticket.clienteTelefono });
  return { ok: true, message };
}

/** Confirma precio de pesaje desde el bloc de notas. */
export async function noteSetPrice(ticketId, usd) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  if (ticket.estado === 'CERRADO') return { error: 'Esta nota ya fue atendida' };
  if (!(usd > 0)) return { error: 'Indique un monto en USD mayor que cero' };

  // Solo los ítems de ESTA nota / pedido actual — no precios de pedidos cancelados.
  const result = applyWeighedPrice(ticket.clienteTelefono, usd, await getBcvRate(), {
    ticketItems: ticket.items,
  });
  if (result.error) return { error: result.error };
  return deliverAndClose(ticket, result.message);
}

export async function noteNoStock(ticketId) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  if (ticket.estado === 'CERRADO') return { error: 'Esta nota ya fue atendida' };

  const result = applyNotAvailable(ticket.clienteTelefono, await getBcvRate(), {
    ticketItems: ticket.items,
  });
  if (result.error) return { error: result.error };
  return deliverAndClose(ticket, result.message);
}

export async function noteSetFreight(ticketId, usd) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  if (ticket.estado === 'CERRADO') return { error: 'Esta nota ya fue atendida' };
  if (!(usd > 0)) return { error: 'Indique el flete en USD' };

  const bcv = await getBcvRate();
  const bs = bcv ? (usd * bcv.rate).toFixed(2) : null;
  const message =
    `✅ El envío hasta su zona queda en *$ ${usd.toFixed(2)}*` +
    (bs ? ` (Bs. ${bs})` : '') +
    '.\n\n¿Desea agregar algo más? 🛒';
  return deliverAndClose(ticket, message, ['order']);
}

export async function notePayment(ticketId, { ok, mensaje } = {}) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  if (ticket.estado === 'CERRADO') return { error: 'Esta nota ya fue atendida' };

  const message = String(mensaje || '').trim() || (ok
    ? '✅ Recibimos su comprobante. Su pedido será despachado en breve. 🛵'
    : 'Disculpe, no pudimos validar el comprobante. ¿Podría enviarlo de nuevo, por favor? 🙏');

  return deliverAndClose(ticket, message, ['payment']);
}

export async function noteDismiss(ticketId) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  clearEditingTicket(ticketId);
  updateTicket(ticketId, { estado: 'CERRADO' });
  if (ticket.clienteTelefono) {
    db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'weigh');
    db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'payment');
    db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'ticket');
  }
  publishCrm({ type: 'note_done', ticketId, phone: ticket.clienteTelefono });
  return { ok: true };
}
