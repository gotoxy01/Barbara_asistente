import { config } from '../config.js';
import * as db from '../db.js';
import { outboundRecord, sendMessage } from '../messenger.js';
import { getBcvRate } from './bcvService.js';
import { notifyAdvisor, recordAdvisorMessage } from './chatService.js';
import { applyConfirmedStock, applyNotAvailable, applyRejectedStock, applyWeighedPrice, pendingWeighItems } from './orderService.js';
import { applyAction } from './orderBook.js';
import { getTicket } from './ticketStore.js';

const HELP =
  '*Comandos del asesor*\n' +
  '#precio <monto>: precio en USD de lo que pesó o consultó (responda a la alerta de caja)\n' +
  '#precio <teléfono> <monto>: igual, indicando el cliente\n' +
  '#hay <pedido|teléfono> <producto> <precio>: sí lo hay; se anota con ese precio en USD\n' +
  '#nohay: avisar al cliente que no hay lo que consultó (responda a la alerta de caja)\n' +
  '#nohay <teléfono>: igual, indicando el cliente\n' +
  '#nohay <pedido|teléfono> <producto>: no hay ese producto que se estaba verificando\n' +
  '#b: ver los pedidos pendientes\n' +
  '#b <teléfono>: borrar el pedido pendiente de ese cliente\n' +
  '#r <teléfono> <mensaje>: responder al cliente desde el número del negocio\n' +
  '#pausar <teléfono>: pasar el chat a especialista (Bárbara no responde hasta #reanudar)\n' +
  '#reanudar <teléfono>: reactivar a Bárbara en ese chat\n' +
  '#bloquear <teléfono>: no responderle hasta #desbloquear\n' +
  '#desbloquear <teléfono>: quitar el bloqueo por spam o el manual\n' +
  '#pagado <pedido>: el pago ya se vio en el banco; descuenta el inventario una sola vez\n' +
  '#rechazar <pedido>: el comprobante no sirve; si ya se había descontado, se devuelve\n' +
  '#ayuda: ver esta lista';

const manualPauseMs = () => config.manualPauseMinutes * 60 * 1000;

/** Confirmaciones de comandos WhatsApp: solo al chat consigo mismo, sin saturar el CRM. */
function ack(text) {
  return notifyAdvisor(text, { whatsapp: true, skipCrm: true });
}

/** Cliente de una alerta de caja / ficha telegráfica #T-… */
function phoneFromAlert(text) {
  const t = String(text ?? '');
  const ticketId = t.match(/#?(T-\d+)/i)?.[1];
  if (ticketId) {
    const ticket = getTicket(ticketId);
    if (ticket?.clienteTelefono) return ticket.clienteTelefono;
  }
  return t.match(/Cliente:\*?\s*\+?(\d{8,15})/)?.[1]
    ?? t.match(/\+(\d{8,15})/)?.[1]
    ?? null;
}

async function handleHay(body) {
  const match = body.match(/^#hay\s+(\S+)\s+(.+)\s+(\d+(?:[.,]\d{1,2})?)\s*$/i);
  if (!match) {
    await ack('Formato: #hay <pedido o teléfono> <producto> <precio USD>. Ejemplo: #hay 12 leche 1.80');
    return;
  }
  const usd = Number(match[3].replace(',', '.'));
  if (!(usd > 0)) {
    await ack('El precio en USD debe ser mayor que cero.');
    return;
  }
  const result = await applyConfirmedStock(match[1], match[2].trim(), usd, await getBcvRate());
  if (result.error || !result.order) {
    await ack(result.error || 'No se pudo anotar el producto.');
    return;
  }
  await deliverToCustomer(result.order.phone, result, `✅ ${match[2].trim()} a $ ${usd.toFixed(2)} anotado para +${result.order.phone}.`);
}

async function handleNoHayProduct(target, productName) {
  const result = await applyRejectedStock(target, productName);
  if (result.error || !result.order) {
    await ack(result.error || 'No se pudo actualizar el pedido.');
    return;
  }
  await deliverToCustomer(result.order.phone, result, `✅ Se le avisó a +${result.order.phone} que no está ${productName}.`);
}

async function handlePrice(body, quotedBody) {
  const match = body.match(/^#precio\s+(?:\+?(\d{8,15})\s+)?\$?\s*(\d+(?:[.,]\d{1,2})?)\s*\$?\s*$/i);
  if (!match) {
    await ack('Formato inválido. Escriba el precio total en dólares, por ejemplo: #precio 1.50');
    return;
  }
  const usd = Number(match[2].replace(',', '.'));
  if (!(usd > 0)) {
    await ack('El monto debe ser mayor que cero. Ejemplo: #precio 1.50');
    return;
  }

  const phone = await pendingCustomer(match[1], quotedBody, '#precio <teléfono> <monto>');
  if (!phone) return;
  await deliverToCustomer(phone, await applyWeighedPrice(phone, usd, await getBcvRate()), `✅ Precio $ ${usd.toFixed(2)} enviado a +${phone}.`);
}

async function handleNotAvailable(body, quotedBody) {
  const explicit = body.match(/^#nohay\s+\+?(\d{8,15})\s*$/i)?.[1];
  const phone = await pendingCustomer(explicit, quotedBody, '#nohay <teléfono>');
  if (!phone) return;
  await deliverToCustomer(phone, await applyNotAvailable(phone, await getBcvRate()), `✅ Se le avisó a +${phone} que no hay disponible.`);
}

/** "0414-123.45.67", "+58 414 1234567" o "584141234567" -> "584141234567". */
function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(digits)) return `58${digits.slice(1)}`;
  if (/^4\d{9}$/.test(digits)) return `58${digits}`;
  return digits;
}

async function settlePayment(command, token) {
  const digits = String(token || '').replace(/\D/g, '');
  const order = digits && digits.length <= 7
    ? await db.getOrderById(Number(digits))
    : (digits ? await db.getCommercialOrder(digits) : null);
  if (!order) {
    await ack('No encontré ese pedido. Use #pagado <número> o #rechazar <número>.');
    return;
  }
  const reduced = await applyAction(order.phone, {
    type: command === 'pagado' ? 'verify_payment' : 'reject_payment',
    orderId: order.id,
    actor: 'operador',
  });
  if (reduced.error) {
    await ack(reduced.error);
    return;
  }
  if (reduced.customerReply) {
    try {
      const sent = await sendMessage(order.phone, reduced.customerReply);
      await recordAdvisorMessage(order.phone, outboundRecord(sent, reduced.customerReply));
    } catch (err) {
      await ack(`El pedido #${order.id} quedó en ${reduced.order.lifecycle}, pero no se pudo avisar al cliente: ${err.message}`);
      return;
    }
  }
  const moved = reduced.ledger
    ? ` Inventario en el libro de Bárbara (${reduced.ledger.action}): ${(reduced.ledger.lines || []).map((line) => `${line.cantidad} ${line.nombre}`).join(', ') || 'sin líneas'}. Hay que ajustarlo en la caja; este programa no escribe en database.db.`
    : ' El inventario no se movió otra vez.';
  await ack(`Pedido #${order.id} quedó en ${reduced.order.lifecycle}.${moved}`);
}

function describeOrder(o) {
  const count = o.items.length;
  const total = o.total_usd != null ? ` - $ ${o.total_usd.toFixed(2)}` : '';
  const state = o.lifecycle || ({ abierto: 'armando', boleta: 'boleta enviada', recibido: 'registrado' }[o.status] ?? o.status);
  return `Pedido #${o.id} (${state}): ${count} producto${count === 1 ? '' : 's'}${total}`;
}

/** #b <teléfono>: cancela los pedidos sin cerrar del cliente. #b solo: lista los pedidos pendientes. */
async function handleCancelOrder(args, quotedBody) {
  const phone = normalizePhone(args) || phoneFromAlert(quotedBody);
  if (!phone) {
    const pending = await db.getPendingOrders();
    if (!pending.length) {
      await ack('No hay pedidos pendientes.');
      return;
    }
    const lines = [];
    for (const o of pending) {
      const chat = await db.getChat(o.phone);
      const name = chat?.name;
      lines.push(`• +${o.phone}${name ? ` (${name})` : ''}: ${describeOrder(o)}`);
    }
    const list = lines.join('\n');
    await ack(`📋 *Pedidos pendientes (${pending.length})*\n${list}\n\nPara borrar uno escriba: #b <teléfono>`);
    return;
  }
  if (phone.length < 10) {
    await ack('Número inválido. Ejemplo: #b 04141234567');
    return;
  }

  const cancelled = await db.cancelPendingOrders(phone);
  if (!cancelled.length) {
    await ack(`+${phone} no tiene pedidos pendientes.`);
    return;
  }
  console.log(`[${phone}] Pedido(s) cancelado(s) por el asesor: ${cancelled.map((o) => `#${o.id}`).join(', ')}`);
  await ack(`🗑️ Pedido borrado para +${phone}:\n${cancelled.map((o) => `• ${describeOrder(o)}`).join('\n')}\n\nSi el cliente vuelve a escribir, empieza un pedido nuevo.`);
}

/** Cliente al que va dirigido el comando: el indicado, el de la alerta citada o el único que está esperando. */
async function pendingCustomer(explicitPhone, quotedBody, usage) {
  const phone = explicitPhone || phoneFromAlert(quotedBody);
  if (phone) return phone;
  const waiting = await db.getOrdersAwaitingWeight();
  if (waiting.length === 1) return waiting[0].phone;
  if (!waiting.length) {
    await ack('No hay clientes esperando un pesaje o consulta.');
    return null;
  }
  const list = waiting.map((o) => `• +${o.phone}: ${pendingWeighItems(o.items).map((i) => i.detalle).join('; ')}`).join('\n');
  await ack(`Hay varios clientes esperando:\n${list}\n\nResponda a la alerta de ese cliente, o escriba: ${usage}`);
  return null;
}

async function deliverToCustomer(phone, result, confirmation) {
  if (result.error) {
    await ack(`❌ ${result.error}`);
    return;
  }
  try {
    const sent = await sendMessage(phone, result.message);
    await db.addMessage(phone, 'model', outboundRecord(sent, result.message));
    await db.resolveAlertsByPhoneKind(phone, 'weigh');
    await ack(confirmation);
  } catch (err) {
    await ack(`❌ No se pudo enviar el mensaje a +${phone}: ${err.message}`);
  }
}

/**
 * Procesa un comando del asesor (#precio, #r, #pausar, #reanudar, #ayuda).
 * @param {string} body
 * @param {{ quotedBody?: string }} [context] texto del mensaje citado (p. ej. la alerta de caja)
 * @returns {Promise<boolean>} true si el texto era un comando
 */
export async function handleAdvisorCommand(body, { quotedBody } = {}) {
  const text = String(body ?? '').trim();
  if (/^#hay\b/i.test(text)) {
    await handleHay(text);
    return true;
  }
  if (/^#precio\b/i.test(text)) {
    await handlePrice(text, quotedBody);
    return true;
  }
  if (/^#no\s?hay\b/i.test(text)) {
    const normalized = text.replace(/^#no\s?hay/i, '#nohay');
    const specific = normalized.match(/^#nohay\s+(\S+)\s+(.+)$/i);
    if (specific && !/^\d+(?:[.,]\d+)?$/.test(specific[2].trim())) {
      await handleNoHayProduct(specific[1], specific[2].trim());
      return true;
    }
    await handleNotAvailable(normalized, quotedBody);
    return true;
  }
  if (/^#b(orrar)?\b/i.test(text)) {
    await handleCancelOrder(text.replace(/^#b(orrar)?/i, ''), quotedBody);
    return true;
  }

  const match = text.match(/^#(\w+)\s*(\+?\d+)?\s*([\s\S]*)$/);
  if (!match) return false;

  const [, command, rawPhone, rest] = match;
  const phone = rawPhone?.replace(/\D/g, '');

  switch (command.toLowerCase()) {
    case 'ayuda':
      await ack(HELP);
      return true;
    case 'pagado':
    case 'rechazar':
      await settlePayment(command, rawPhone || rest);
      return true;
    case 'pausar':
      if (!phone) break;
      await db.upsertChat(phone, null);
      await db.setSpecialist(phone);
      await ack(`⏸️ +${phone} quedó con el especialista. Bárbara no responde hasta #reanudar.`);
      return true;
    case 'reanudar':
      if (!phone) break;
      await db.upsertChat(phone, null);
      await db.resumeChat(phone);
      await ack(`▶️ Bárbara reactivada para +${phone}.`);
      return true;
    case 'bloquear': {
      const target = normalizePhone(phone || rest);
      if (!target || target.length < 10) break;
      await db.upsertChat(target, null);
      await db.saveChatBlock(target, { reason: 'manual', blockedUntil: null });
      await ack(`⏸️ +${target} quedó bloqueado. No se le responde hasta #desbloquear.`);
      return true;
    }
    case 'desbloquear': {
      const target = normalizePhone(phone || rest);
      if (!target || target.length < 10) break;
      await db.clearChatBlock(target);
      await ack(`▶️ +${target} quedó desbloqueado.`);
      return true;
    }
    case 'r':
    case 'responder':
      if (!phone || !rest.trim()) break;
      try {
        const sent = await sendMessage(phone, rest.trim());
        await recordAdvisorMessage(phone, outboundRecord(sent, rest.trim()));
        const specialist = (await db.getChat(phone))?.status === 'SPECIALIST';
        if (!specialist) await db.pauseChat(phone, manualPauseMs());
        await ack(sent?.mode === 'template'
          ? `✅ La ventana de 24 h está cerrada: a +${phone} se le envió la plantilla, no el texto libre.`
          : specialist
            ? `✅ Enviado a +${phone}. El chat sigue con el especialista.`
            : `✅ Enviado a +${phone}. Bárbara se reactiva sola en ${config.manualPauseMinutes} min.`);
      } catch (err) {
        await ack(`❌ No se pudo enviar a +${phone}: ${err.message}`);
      }
      return true;
    default:
      return false;
  }

  await ack(`Formato inválido.\n\n${HELP}`);
  return true;
}
