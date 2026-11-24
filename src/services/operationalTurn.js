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
import { isAddIntent, isOrderStatusQuestion } from './customerText.js';
import { searchProducts } from './catalogService.js';
import {
  createOrderTools,
  expandCustomerReply,
  pendingWeighItems,
  planPurchase,
} from './orderService.js';

/**
 * Dirección, pago, ubicación y “es todo” se resuelven en código.
 * Así no se busca el catálogo ni se espera otra llamada al modelo.
 */
export async function tryOperationalTurn({ phone, name, text, bcv, notify }) {
  const raw = String(text || '').trim();
  const location = parseLocation(raw);
  const payment = parsePaymentReport(raw);
  const tools = createOrderTools({ phone, name, bcv, notify, customerText: raw });

  if (isOrderStatusQuestion(raw)) {
    const order = await db.getActiveOrder(phone);
    if (!order?.items?.length) return reply('Todavía no tiene productos anotados en el pedido.');
    const lines = order.items.map((item) => `• ${item.cantidad} x ${item.nombre}${item.presentacion ? ` (${item.presentacion})` : ''}`);
    const where = order.address ? `\n\nDirección anotada: ${order.address}` : '';
    return reply(`En su pedido va:\n${lines.join('\n')}${where}`);
  }

  if (/^(tienen|hay|tiene)\b/i.test(raw) && !isAddIntent(raw)) {
    const found = await searchProducts(raw, {});
    const products = (found.products || []).slice(0, 5);
    if (!products.length) return null;
    const lines = products.map((product) => `• *${product.nombre}* (${product.presentacion}): $ ${Number(product.precio).toFixed(2)} USD`);
    return reply(`Tenemos estas opciones:\n${lines.join('\n')}\n\n¿Cuál desea y cuántas?`);
  }

  if (isAddIntent(raw)) {
    const plan = await planPurchase(raw);
    if (plan.action === 'choose') {
      const lines = plan.products.map((product) => `• *${product.nombre}* (${product.presentacion}): $ ${Number(product.precio).toFixed(2)} USD`);
      return reply(`Hay varias parecidas:\n${lines.join('\n')}\n\n¿Cuál desea y cuántas?`);
    }
    if (plan.action === 'add') {
      const result = await tools.execute('agregar_producto', { producto: plan.product.nombre, cantidad: plan.qty });
      if (result?.ok) {
        const textOut = expandCustomerReply(
          tools.finalize([{ name: 'agregar_producto', args: {}, result }]) || `Anoté: ${result.agregado}.`,
          tools.state,
        );
        return { reply: textOut, toolCalls: [{ name: 'agregar_producto', args: { producto: plan.product.nombre, cantidad: plan.qty }, result }], escalated: false };
      }
    }
  }

  if (!isOperationalTurn(raw) && !location && !payment) return null;

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
    const textOut = expandCustomerReply(tools.finalize([{ name: 'generar_boleta', args: {}, result }]) || '', tools.state);
    return { reply: textOut, toolCalls: [{ name: 'generar_boleta', args: {}, result }], escalated: false };
  }

  if (isOperationalTurn(raw)) {
    const order = await db.getCommercialOrder(phone);
    if (order?.items?.length && ['borrador', 'boleta_enviada', 'pago_reportado', 'pago_verificado'].includes(order.lifecycle || 'borrador')) {
      const result = await tools.execute('registrar_direccion', { direccion: raw });
      if (result?.ok) {
        const textOut = tools.finalize([{ name: 'registrar_direccion', args: { direccion: raw }, result }]);
        return { reply: textOut, toolCalls: [{ name: 'registrar_direccion', args: { direccion: raw }, result }], escalated: false };
      }
      if (result?.error && /n[uú]mero de casa|apto/i.test(result.error)) {
        return reply('Para la entrega necesito el número de casa o del apartamento. También puede enviar su ubicación de WhatsApp o escribir “retiro en tienda”.');
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
