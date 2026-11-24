import * as db from '../db.js';
import { applyAction } from './orderBook.js';
import {
  customerAfterPayment,
  isCheckoutClose,
  isOperationalTurn,
  isPickupText,
  parseLocation,
  parsePaymentReport,
} from './orderLifecycle.js';
import { createOrderTools, pendingWeighItems } from './orderService.js';

/**
 * Dirección, pago, ubicación y “es todo” se resuelven en código.
 * Así no se busca el catálogo ni se espera otra llamada al modelo.
 */
export async function tryOperationalTurn({ phone, name, text, bcv, notify }) {
  const raw = String(text || '').trim();
  const location = parseLocation(raw);
  const payment = parsePaymentReport(raw);
  if (!isOperationalTurn(raw) && !location && !payment) return null;

  const tools = createOrderTools({ phone, name, bcv, notify, customerText: raw });

  if (location) {
    const order = await db.getCommercialOrder(phone);
    if (!order) return reply('Para guardar la ubicación primero armemos el pedido. ¿Qué productos desea?');
    const reduced = await applyAction(phone, { type: 'save_location', ...location, name });
    if (reduced.error) return reply(reduced.error);
    await announce(reduced, phone, notify);
    return reply(reduced.logistics
      ? customerAfterPayment(reduced.order, name)
      : `Guardé su ubicación${reduced.order.location_label ? ` (${reduced.order.location_label})` : ''}. ${reduced.order.lifecycle === 'pago_reportado' ? 'En cuanto el asesor verifique el pago, coordinamos la entrega.' : 'Cuando envíe el comprobante de pago, un agente coordina la entrega.'}`);
  }

  if (payment) {
    const order = await db.getCommercialOrder(phone);
    if (payment.weak && (!order || !['boleta_enviada', 'pago_reportado'].includes(order.lifecycle))) return null;
    if (!order || !['boleta_enviada', 'pago_reportado', 'pago_verificado', 'en_logistica'].includes(order.lifecycle)) {
      return reply('Recibí el dato del pago, pero todavía no hay una boleta abierta. Dígame qué productos desea y lo armamos.');
    }
    const reduced = await applyAction(phone, {
      type: 'report_payment',
      reference: payment.reference,
      mediaId: payment.mediaId,
      note: raw.slice(0, 240),
      name,
    });
    if (reduced.error) return reply(reduced.error);
    await announce(reduced, phone, notify);
    return reply(reduced.customerReply || customerAfterPayment(reduced.order, name));
  }

  if (isCheckoutClose(raw)) {
    const order = await db.getActiveOrder(phone);
    if (!order?.items?.length) return null;
    if (pendingWeighItems(order.items).length) return null;
    const result = await tools.execute('generar_boleta', {});
    if (!result?.ok) return null;
    const textOut = tools.finalize([{ name: 'generar_boleta', args: {}, result }]);
    return { reply: textOut, toolCalls: [{ name: 'generar_boleta', args: {}, result }], escalated: false };
  }

  if (isOperationalTurn(raw)) {
    const order = await db.getCommercialOrder(phone);
    if (order && ['boleta_enviada', 'pago_reportado', 'pago_verificado'].includes(order.lifecycle)) {
      const result = await tools.execute('registrar_direccion', { direccion: raw });
      if (result?.ok) {
        const textOut = tools.finalize([{ name: 'registrar_direccion', args: { direccion: raw }, result }]);
        return { reply: textOut, toolCalls: [{ name: 'registrar_direccion', args: { direccion: raw }, result }], escalated: false };
      }
      if (result?.error && /n[uú]mero de casa|apto/i.test(result.error)) {
        return reply('Para la entrega necesito el número de casa o del apartamento. También puede enviar su ubicación de WhatsApp o escribir “retiro en tienda”.');
      }
    }
    if (!order || order.lifecycle === 'borrador') {
      if (isPickupText(raw) || /\b(torre|calle|avenida|edificio|direcci[oó]n)\b/i.test(raw)) {
        return reply('Anotaré esa dirección cuando cerremos el pedido. ¿Esos son todos los productos, o desea agregar algo más?');
      }
    }
  }

  return null;
}

function reply(text) {
  return { reply: text, toolCalls: [], escalated: false, operational: true };
}

async function announce(reduced, phone, notify) {
  if (!reduced?.notice || typeof notify !== 'function') return;
  await notify(reduced.notice, {
    kind: 'logistica',
    phone,
    title: `Logística pedido #${reduced.order?.id || ''}`,
    whatsapp: true,
  });
}
