import { config } from '../config.js';
import * as db from '../db.js';
import { info, verbose, error as logError } from '../log.js';
import { getSelfPhone, getChannel, outboundRecord, sendInteractiveButtons, sendMessage } from '../messenger.js';
import { draftFromOperatorInstruction } from './aiService.js';
import { getBcvRate } from './bcvService.js';
import { searchProducts } from './catalogService.js';
import {
  applyNotAvailable,
  pendingWeighItems,
  renderFreightAlert,
  renderPaymentAlert,
  renderWeighAlert,
} from './orderService.js';
import {
  clearEditingTicket,
  upsertOpenTicket,
  getEditingTicket,
  getTicket,
  setEditingTicket,
  updateTicket,
} from './ticketStore.js';

const HOLD_FLETE =
  'Déjeme verificar rapidito cuánto sale el envío hasta allá y le confirmo.';

/**
 * Solo excepciones físicas: pesaje en balanza, flete sin tarifa, o (vía createPaymentTicket) pago.
 * Ya NO se abre ticket por stock crítico, pedido alto ni ambigüedad de catálogo.
 * @returns {'pesaje'|'flete'|null}
 */
export function physicalTicketKind({ reply, tools } = {}) {
  if (!config.operatorConsole.enabled) return null;
  if (tools?.state?.boleta || tools?.state?.addressSaved) return null;
  if (tools?.state?.weighed?.length) return 'pesaje';
  if (/d[eé]jame verificar.*env[ií]o|cu[aá]nto sale el env[ií]o|verificar.*flete|flete hasta/i.test(reply || '')) {
    return 'flete';
  }
  return null;
}

/** @deprecated use physicalTicketKind — se mantiene por compatibilidad. */
export function shouldRequestApproval(args) {
  return physicalTicketKind(args) != null;
}

function operatorTarget() {
  return config.advisorPhone || getSelfPhone();
}

function labelCliente(ticket) {
  return ticket.clienteNombre || `+${ticket.clienteTelefono}`;
}

/** Ficha telegráfica de 3 líneas (sin saludos ni relleno). */
function resumenTicket(ticket) {
  const name = labelCliente(ticket);
  if (ticket.motivo === 'pesaje' || ticket.motivo === 'caja') {
    return renderWeighAlert({ ticketId: ticket.ticketId, name, items: ticket.items });
  }
  if (ticket.motivo === 'flete') {
    return renderFreightAlert({
      ticketId: ticket.ticketId,
      name,
      zona: ticket.items?.[0]?.detalle || ticket.items?.[0]?.nombre || 'zona indicada',
    });
  }
  if (ticket.motivo === 'pago') {
    return renderPaymentAlert({
      ticketId: ticket.ticketId,
      name,
      phone: ticket.clienteTelefono,
      note: ticket.borradorRespuesta?.slice(0, 120),
    });
  }
  return [
    `🎫 *${ticket.ticketId}* (${name})`,
    `• *Pide:* ${ticket.items?.map((i) => i.detalle || i.nombre).join('; ') || 'revisión'}`,
    `• *Falta:* ${ticket.borradorRespuesta?.slice(0, 200) || 'acción del encargado'}`,
  ].join('\n');
}

/**
 * Envía la tarjeta compacta con 3 botones al chat del operador.
 * Cloud API: interactive buttons. wweb / sin interactive: texto con payloads.
 *
 * Alternativa Telegram (comentada):
 * bot.sendMessage(chatId, resumen, {
 *   reply_markup: {
 *     inline_keyboard: [[
 *       { text: '✅ Aprobar', callback_data: `APPROVE_${ticket.ticketId}` },
 *       { text: '✏️ Cambiar', callback_data: `EDIT_${ticket.ticketId}` },
 *       { text: '❌ Sin Stock', callback_data: `NOSTOCK_${ticket.ticketId}` },
 *     ]],
 *   },
 * });
 */
export async function enviarSolicitudConBotones(ticket) {
  const to = operatorTarget();
  if (!to) {
    logError('Sin ADVISOR_PHONE ni teléfono propio: no se puede enviar la tarjeta 1-tap.');
    return false;
  }

  const body = resumenTicket(ticket);
  const buttons = [
    { id: `APPROVE_${ticket.ticketId}`, title: '✅ Aprobar' },
    { id: `EDIT_${ticket.ticketId}`, title: '✏️ Cambiar' },
    { id: `NOSTOCK_${ticket.ticketId}`, title: '❌ Sin Stock' },
  ];

  try {
    await sendInteractiveButtons(to, {
      bodyText: body,
      buttons,
      footer: '1 toque · Bodega Los Cuchos',
    });
    info(`🎫 ${ticket.ticketId} enviado al operador (${getChannel()})`);
    return true;
  } catch (err) {
    logError(`No se pudo enviar tarjeta ${ticket.ticketId}:`, err.message);
    return false;
  }
}

/**
 * Abre ticket físico (pesaje / flete / pago), avisa al operador con ficha + botones.
 * El cliente sigue con su mensaje natural de “voy al mostrador”; no se retiene el borrador de venta.
 */
export async function solicitarAprobacionRapida({
  phone,
  name,
  borradorRespuesta = '',
  items = [],
  montoTotalUSD = null,
  montoTotalBs = null,
  motivo = 'pesaje',
}) {
  // Una nota por chat+motivo: no acumular fichas mezcladas de distintos pedidos/clientes.
  const ticket = upsertOpenTicket({
    clienteTelefono: phone,
    clienteNombre: name || null,
    items,
    montoTotalUSD,
    montoTotalBs,
    borradorRespuesta,
    motivo,
  });

  try {
    db.addAdvisorAlert({
      kind: motivo === 'pago' ? 'payment' : motivo === 'flete' ? 'order' : 'weigh',
      phone,
      title: `Nota ${ticket.ticketId}`,
      body: resumenTicket(ticket),
    });
  } catch {
    // CRM opcional
  }

  // Por defecto solo bloc de notas del CRM; WhatsApp al operador es opcional.
  if (config.operatorConsole.whatsappPing) {
    await enviarSolicitudConBotones(ticket);
  } else {
    info(`📝 ${ticket.ticketId} → bloc de notas CRM (sin ping WhatsApp)`);
  }
  return {
    ticket,
    holdReply: motivo === 'flete' ? HOLD_FLETE : null,
  };
}

/** Ticket de validación de comprobante (excepción física #3). */
export async function abrirTicketPago({ phone, name, note }) {
  return solicitarAprobacionRapida({
    phone,
    name,
    borradorRespuesta: note || 'Comprobante recibido',
    items: [{ nombre: 'Comprobante de pago', detalle: note || 'Capture/transferencia' }],
    motivo: 'pago',
  });
}

/** Extrae acción + ticketId de callback_data / button id / texto. */
export function parseOperatorPayload(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(APPROVE|EDIT|NOSTOCK)[_:](T-\d+)$/i)
    || text.match(/^(APPROVE|EDIT|NOSTOCK)[_:](\d+)$/i);
  if (!match) return null;
  const action = match[1].toUpperCase();
  const id = match[2].startsWith('T-') ? match[2] : `T-${match[2]}`;
  return { action, ticketId: id };
}

async function replyOperator(text) {
  const to = operatorTarget();
  if (!to) return;
  await sendMessage(to, text);
}

async function sendToCustomer(ticket, text) {
  const sent = await sendMessage(ticket.clienteTelefono, text);
  db.addMessage(ticket.clienteTelefono, 'model', outboundRecord(sent, text));
  db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'weigh');
  db.resolveAlertsByPhoneKind(ticket.clienteTelefono, 'ticket');
}

async function closeTicket(ticketId, patch = {}) {
  clearEditingTicket(ticketId);
  return updateTicket(ticketId, { estado: 'CERRADO', ...patch });
}

async function handleApprove(ticket) {
  // En caja (pesaje/consulta) el cliente ya recibió el “espere…”: hace falta el precio.
  const pending = pendingWeighItems(db.getActiveOrder(ticket.clienteTelefono)?.items ?? []);
  if ((ticket.motivo === 'caja' || pending.length) && pending.length) {
    updateTicket(ticket.ticketId, { estado: 'ESPERANDO_EDICION' });
    setEditingTicket(ticket.ticketId);
    await replyOperator(
      `✏️ ${ticket.ticketId}: escriba el precio en USD para ${labelCliente(ticket)} (ej: 1.50), o el ajuste.`,
    );
    return { ok: true, waitingEdit: true };
  }

  if (!ticket.borradorRespuesta) {
    await replyOperator(`⚠️ ${ticket.ticketId} no tiene borrador. Use ✏️ Cambiar para escribir el ajuste.`);
    return { ok: false };
  }
  await closeTicket(ticket.ticketId);
  await sendToCustomer(ticket, ticket.borradorRespuesta);
  await replyOperator(`✅ Enviado a ${labelCliente(ticket)}`);
  return { ok: true };
}

async function handleNoStock(ticket) {
  await closeTicket(ticket.ticketId);

  // Si hay pesaje/consulta pendiente, reutiliza el flujo de caja.
  const pending = pendingWeighItems(db.getActiveOrder(ticket.clienteTelefono)?.items ?? []);
  if (pending.length) {
    const bcv = await getBcvRate();
    const result = applyNotAvailable(ticket.clienteTelefono, bcv, { ticketItems: ticket.items });
    if (!result.error) {
      await sendToCustomer(ticket, result.message);
      await replyOperator(`❌ Notificado sin stock a ${labelCliente(ticket)}`);
      return { ok: true };
    }
  }

  const bcv = await getBcvRate();
  const catalog = searchProducts(
    ticket.items.map((i) => i.nombre || i.detalle || '').filter(Boolean).join(' ') || ticket.borradorRespuesta,
    { bcv },
  );
  const mensaje = await draftFromOperatorInstruction({
    instruccion: 'Avisa con tono amable y humano que el producto se agotó. Ofrece alternativa real de datos_bd si existe; si no, invita a pedir otro producto.',
    ticket,
    datos_bd: catalog.text || 'Sin alternativas claras en catálogo.',
  });
  await sendToCustomer(ticket, mensaje);
  await replyOperator(`❌ Notificado sin stock a ${labelCliente(ticket)}`);
  return { ok: true };
}

async function handleEdit(ticket) {
  updateTicket(ticket.ticketId, { estado: 'ESPERANDO_EDICION' });
  setEditingTicket(ticket.ticketId);
  await replyOperator(
    `✏️ Escribe el ajuste para ${labelCliente(ticket)} (ej: 'Flete son $3', 'Solo quedan 2', o el precio nuevo):`,
  );
  return { ok: true, waitingEdit: true };
}

async function handleEditText(ticket, operatorText) {
  const usd = Number(String(operatorText).replace(',', '.').match(/(\d+(?:\.\d{1,2})?)/)?.[1]);
  const looksLikePriceOnly = /^\s*\$?\s*\d+(?:[.,]\d{1,2})?\s*\$?\s*$/.test(operatorText)
    && pendingWeighItems(db.getActiveOrder(ticket.clienteTelefono)?.items ?? []).length;

  let mensaje;
  if (looksLikePriceOnly && usd > 0) {
    const { applyWeighedPrice } = await import('./orderService.js');
    const result = applyWeighedPrice(ticket.clienteTelefono, usd, await getBcvRate(), {
      ticketItems: ticket.items,
    });
    if (result.error) {
      await replyOperator(`❌ ${result.error}`);
      return { ok: false };
    }
    mensaje = result.message;
  } else {
    const bcv = await getBcvRate();
    const catalog = searchProducts(operatorText, { bcv });
    mensaje = await draftFromOperatorInstruction({
      instruccion: operatorText,
      ticket,
      datos_bd: `${catalog.text || 'Sin coincidencias nuevas.'}\nPedido pendiente en ticket.`,
    });
  }

  await closeTicket(ticket.ticketId, { borradorRespuesta: mensaje });
  await sendToCustomer(ticket, mensaje);
  await replyOperator(`✅ Ajuste enviado a ${labelCliente(ticket)}`);
  return { ok: true };
}

/**
 * Intercepta clics de botón (interactive.button_reply.id / callback_query.data)
 * y el texto posterior cuando el ticket está en ESPERANDO_EDICION.
 *
 * @param {{ payload?: string, text?: string }} input
 * @returns {Promise<{ handled: boolean, ok?: boolean, message?: string }>}
 */
export async function handleOperatorAction(input = {}) {
  const payload = parseOperatorPayload(input.payload || input.text || '');
  if (payload) {
    const ticket = getTicket(payload.ticketId);
    if (!ticket) {
      await replyOperator(`⚠️ Ticket ${payload.ticketId} no existe.`);
      return { handled: true, ok: false };
    }
    if (ticket.estado === 'CERRADO') {
      await replyOperator('⚠️ Este pedido ya fue procesado.');
      return { handled: true, ok: false, message: 'already_closed' };
    }

    if (payload.action === 'APPROVE') return { handled: true, ...(await handleApprove(ticket)) };
    if (payload.action === 'NOSTOCK') return { handled: true, ...(await handleNoStock(ticket)) };
    if (payload.action === 'EDIT') return { handled: true, ...(await handleEdit(ticket)) };
  }

  const editing = getEditingTicket();
  const text = String(input.text || '').trim();
  if (editing && text && !text.startsWith('#')) {
    return { handled: true, ...(await handleEditText(editing, text)) };
  }

  return { handled: false };
}

/**
 * Atajo para el webhook: prioriza id estable del botón; si no, el título/texto.
 * @returns {Promise<boolean>} true si el evento ya fue consumido por la consola 1-tap
 */
export async function tryHandleOperatorInbound(messageLike = {}) {
  if (!config.operatorConsole.enabled) return false;

  const buttonId =
    messageLike.buttonId
    || messageLike.interactive?.button_reply?.id
    || messageLike.button?.payload
    || messageLike.callback_query?.data
    || null;

  const text =
    messageLike.text
    || messageLike.interactive?.button_reply?.title
    || messageLike.button?.text
    || messageLike.body
    || '';

  if (buttonId || parseOperatorPayload(text) || getEditingTicket()) {
    const result = await handleOperatorAction({ payload: buttonId || undefined, text });
    if (result.handled) {
      verbose(`Operador 1-tap: ${buttonId || text.slice(0, 40)}`);
      return true;
    }
  }
  return false;
}
