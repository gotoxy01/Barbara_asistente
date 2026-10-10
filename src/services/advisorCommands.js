import { config } from '../config.js';
import * as db from '../db.js';
import { sendMessage } from '../messenger.js';
import { getBcvRate } from './bcvService.js';
import { notifyAdvisor, recordAdvisorMessage } from './chatService.js';
import { applyNotAvailable, applyWeighedPrice, pendingWeighItems } from './orderService.js';

const HELP =
  '*Comandos del asesor*\n' +
  '#precio <monto>: precio en USD de lo que pesó o consultó (responda a la alerta de caja)\n' +
  '#precio <teléfono> <monto>: igual, indicando el cliente\n' +
  '#nohay: avisar al cliente que no hay lo que consultó (responda a la alerta de caja)\n' +
  '#nohay <teléfono>: igual, indicando el cliente\n' +
  '#b: ver los pedidos pendientes\n' +
  '#b <teléfono>: borrar el pedido pendiente de ese cliente\n' +
  '#r <teléfono> <mensaje>: responder al cliente desde el número del negocio\n' +
  '#pausar <teléfono>: pausar a Bárbara en ese chat\n' +
  '#reanudar <teléfono>: reactivar a Bárbara en ese chat\n' +
  '#ayuda: ver esta lista';

const manualPauseMs = () => config.manualPauseMinutes * 60 * 1000;

/** Cliente de una alerta de caja: "• *Cliente:* +584121234567 (Nombre)". */
function phoneFromAlert(text) {
  return String(text ?? '').match(/Cliente:\*?\s*\+?(\d{8,15})/)?.[1] ?? null;
}

async function handlePrice(body, quotedBody) {
  const match = body.match(/^#precio\s+(?:\+?(\d{8,15})\s+)?\$?\s*(\d+(?:[.,]\d{1,2})?)\s*\$?\s*$/i);
  if (!match) {
    await notifyAdvisor('Formato inválido. Escriba el precio total en dólares, por ejemplo: #precio 1.50');
    return;
  }
  const usd = Number(match[2].replace(',', '.'));
  if (!(usd > 0)) {
    await notifyAdvisor('El monto debe ser mayor que cero. Ejemplo: #precio 1.50');
    return;
  }

  const phone = await pendingCustomer(match[1], quotedBody, '#precio <teléfono> <monto>');
  if (!phone) return;
  await deliverToCustomer(phone, applyWeighedPrice(phone, usd, await getBcvRate()), `✅ Precio $ ${usd.toFixed(2)} enviado a +${phone}.`);
}

async function handleNotAvailable(body, quotedBody) {
  const explicit = body.match(/^#nohay\s+\+?(\d{8,15})\s*$/i)?.[1];
  const phone = await pendingCustomer(explicit, quotedBody, '#nohay <teléfono>');
  if (!phone) return;
  await deliverToCustomer(phone, applyNotAvailable(phone, await getBcvRate()), `✅ Se le avisó a +${phone} que no hay disponible.`);
}

/** "0414-123.45.67", "+58 414 1234567" o "584141234567" -> "584141234567". */
function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (/^0\d{10}$/.test(digits)) return `58${digits.slice(1)}`;
  if (/^4\d{9}$/.test(digits)) return `58${digits}`;
  return digits;
}

function describeOrder(o) {
  const count = o.items.length;
  const total = o.total_usd != null ? ` - $ ${o.total_usd.toFixed(2)}` : '';
  const state = { abierto: 'armando', boleta: 'boleta enviada', recibido: 'registrado' }[o.status] ?? o.status;
  return `Pedido #${o.id} (${state}): ${count} producto${count === 1 ? '' : 's'}${total}`;
}

/** #b <teléfono>: cancela los pedidos sin cerrar del cliente. #b solo: lista los pedidos pendientes. */
async function handleCancelOrder(args, quotedBody) {
  const phone = normalizePhone(args) || phoneFromAlert(quotedBody);
  if (!phone) {
    const pending = db.getPendingOrders();
    if (!pending.length) {
      await notifyAdvisor('No hay pedidos pendientes.');
      return;
    }
    const list = pending.map((o) => {
      const name = db.getChat(o.phone)?.name;
      return `• +${o.phone}${name ? ` (${name})` : ''}: ${describeOrder(o)}`;
    }).join('\n');
    await notifyAdvisor(`📋 *Pedidos pendientes (${pending.length})*\n${list}\n\nPara borrar uno escriba: #b <teléfono>`);
    return;
  }
  if (phone.length < 10) {
    await notifyAdvisor('Número inválido. Ejemplo: #b 04141234567');
    return;
  }

  const cancelled = db.cancelPendingOrders(phone);
  if (!cancelled.length) {
    await notifyAdvisor(`+${phone} no tiene pedidos pendientes.`);
    return;
  }
  console.log(`[${phone}] Pedido(s) cancelado(s) por el asesor: ${cancelled.map((o) => `#${o.id}`).join(', ')}`);
  await notifyAdvisor(`🗑️ Pedido borrado para +${phone}:\n${cancelled.map((o) => `• ${describeOrder(o)}`).join('\n')}\n\nSi el cliente vuelve a escribir, empieza un pedido nuevo.`);
}

/** Cliente al que va dirigido el comando: el indicado, el de la alerta citada o el único que está esperando. */
async function pendingCustomer(explicitPhone, quotedBody, usage) {
  const phone = explicitPhone || phoneFromAlert(quotedBody);
  if (phone) return phone;
  const waiting = db.getOrdersAwaitingWeight();
  if (waiting.length === 1) return waiting[0].phone;
  if (!waiting.length) {
    await notifyAdvisor('No hay clientes esperando un pesaje o consulta.');
    return null;
  }
  const list = waiting.map((o) => `• +${o.phone}: ${pendingWeighItems(o.items).map((i) => i.detalle).join('; ')}`).join('\n');
  await notifyAdvisor(`Hay varios clientes esperando:\n${list}\n\nResponda a la alerta de ese cliente, o escriba: ${usage}`);
  return null;
}

async function deliverToCustomer(phone, result, confirmation) {
  if (result.error) {
    await notifyAdvisor(`❌ ${result.error}`);
    return;
  }
  try {
    await sendMessage(phone, result.message);
    db.addMessage(phone, 'model', result.message);
    await notifyAdvisor(confirmation);
  } catch (err) {
    await notifyAdvisor(`❌ No se pudo enviar el mensaje a +${phone}: ${err.message}`);
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
  if (/^#precio\b/i.test(text)) {
    await handlePrice(text, quotedBody);
    return true;
  }
  if (/^#no\s?hay\b/i.test(text)) {
    await handleNotAvailable(text.replace(/^#no\s?hay/i, '#nohay'), quotedBody);
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
      await notifyAdvisor(HELP);
      return true;
    case 'pausar':
      if (!phone) break;
      db.upsertChat(phone, null);
      db.pauseChat(phone);
      await notifyAdvisor(`⏸️ Bárbara pausada para +${phone}.`);
      return true;
    case 'reanudar':
      if (!phone) break;
      db.upsertChat(phone, null);
      db.resumeChat(phone);
      await notifyAdvisor(`▶️ Bárbara reactivada para +${phone}.`);
      return true;
    case 'r':
    case 'responder':
      if (!phone || !rest.trim()) break;
      try {
        await sendMessage(phone, rest.trim());
        recordAdvisorMessage(phone, rest.trim());
        db.pauseChat(phone, manualPauseMs());
        await notifyAdvisor(`✅ Enviado a +${phone}. Bárbara se reactiva sola en ${config.manualPauseMinutes} min.`);
      } catch (err) {
        await notifyAdvisor(`❌ No se pudo enviar a +${phone}: ${err.message}`);
      }
      return true;
    default:
      return false;
  }

  await notifyAdvisor(`Formato inválido.\n\n${HELP}`);
  return true;
}
