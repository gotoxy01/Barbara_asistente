import { config } from '../config.js';
import * as db from '../db.js';
import { sendMessage } from '../messenger.js';
import { getBcvRate } from './bcvService.js';
import { notifyAdvisor, recordAdvisorMessage } from './chatService.js';
import { applyWeighedPrice, pendingWeighItems } from './orderService.js';

const HELP =
  '*Comandos del asesor*\n' +
  '#precio <monto>: precio en USD de lo que pesó (responda a la alerta de caja)\n' +
  '#precio <teléfono> <monto>: igual, indicando el cliente\n' +
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

  let phone = match[1] || phoneFromAlert(quotedBody);
  if (!phone) {
    const waiting = db.getOrdersAwaitingWeight();
    if (waiting.length === 1) phone = waiting[0].phone;
    else if (!waiting.length) {
      await notifyAdvisor('No hay clientes esperando un pesaje.');
      return;
    } else {
      const list = waiting.map((o) => `• +${o.phone}: ${pendingWeighItems(o.items).map((i) => i.detalle).join('; ')}`).join('\n');
      await notifyAdvisor(`Hay varios clientes esperando pesaje:\n${list}\n\nResponda a la alerta de ese cliente, o escriba: #precio <teléfono> <monto>`);
      return;
    }
  }

  const result = applyWeighedPrice(phone, usd, await getBcvRate());
  if (result.error) {
    await notifyAdvisor(`❌ ${result.error}`);
    return;
  }
  try {
    await sendMessage(phone, result.message);
    db.addMessage(phone, 'model', result.message);
    await notifyAdvisor(`✅ Precio $ ${usd.toFixed(2)} enviado a +${phone}.`);
  } catch (err) {
    await notifyAdvisor(`❌ No se pudo enviar el precio a +${phone}: ${err.message}`);
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
