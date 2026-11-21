import * as db from '../db.js';
import { publishCrm } from '../crm/events.js';
import { sendMessage } from '../messenger.js';
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
  const pending = pendingWeighItems(items);
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
  const kitchen = order.kitchen_status || 'nuevo';
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
      consulta: !!i.consulta,
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

export async function listNotes() {
  const tickets = listOpenTickets(60);
  const kitchen = db.listKitchenOrders(40);

  const ticketNotes = [];
  for (const t of tickets) ticketNotes.push(await decorateNote(t));
  const orderNotes = [];
  for (const o of kitchen) orderNotes.push(await decorateKitchenNote(o));

  // Una sola cola numerada: cajas urgentes y comandas, por llegada.
  const merged = [...ticketNotes, ...orderNotes].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return merged.map((note, i) => ({ n: i + 1, ...note }));
}

export async function getNoteById(id, { previewUsd = null } = {}) {
  if (String(id).startsWith('P-')) {
    const orderId = Number(String(id).slice(2));
    const order = db.getOrderById(orderId);
    if (!order || order.status !== 'recibido') return null;
    if (!['nuevo', 'preparado'].includes(order.kitchen_status || 'nuevo') && previewUsd == null) {
      // Permitir ver recién cambiados; si ya salió del tablero, igual devolver si existe.
    }
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
  if (!before || before.status !== 'recibido') return { error: 'Pedido no encontrado' };

  const order = db.setKitchenStatus(orderId, status);
  if (!order) return { error: 'No se pudo actualizar' };

  let message = null;
  if (notifyCustomer) {
    if (status === 'preparado') {
      message = `¡Listo! Su pedido *#${order.id}* ya se está preparando. En breve le avisamos. 🧺`;
    } else if (status === 'atendido') {
      message = `Su pedido *#${order.id}* ya fue atendido y va en camino / listo para entrega. ¡Gracias por preferir *Abasto Los Cuchos*! 🛵🙏`;
    } else if (status === 'cancelado') {
      message = `Su pedido *#${order.id}* fue cancelado. Disculpe las molestias. Si desea armar otro, escríbanos por aquí. 🙏`;
    }
    if (message) {
      try {
        await sendMessage(order.phone, message);
        db.addMessage(order.phone, 'model', message);
      } catch (err) {
        return { ok: true, order, warning: `Estado guardado, pero no se pudo avisar al cliente: ${err.message}` };
      }
    }
  }

  if (status === 'atendido' || status === 'cancelado') {
    db.resolveAlertsByPhoneKind(order.phone, 'order');
  }
  publishCrm({ type: 'note_done', ticketId: noteId, phone: order.phone, kitchenStatus: status });
  return { ok: true, order, message, kitchenStatus: status };
}

async function deliverAndClose(ticket, message, extraResolveKinds = []) {
  await sendMessage(ticket.clienteTelefono, message);
  db.addMessage(ticket.clienteTelefono, 'model', message);
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

  const result = applyWeighedPrice(ticket.clienteTelefono, usd, await getBcvRate());
  if (result.error) return { error: result.error };
  return deliverAndClose(ticket, result.message);
}

export async function noteNoStock(ticketId) {
  const ticket = getTicket(ticketId);
  if (!ticket) return { error: 'Nota no encontrada' };
  if (ticket.estado === 'CERRADO') return { error: 'Esta nota ya fue atendida' };

  const result = applyNotAvailable(ticket.clienteTelefono, await getBcvRate());
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
