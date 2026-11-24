// Punto único de envío de mensajes, independiente del canal (whatsapp-web.js o Cloud API de Meta).

import { config } from './config.js';
import * as db from './db.js';
import { isWithinServiceWindow } from './services/window.js';
import { isServiceWindowError, sendTemplate } from './whatsapp.js';

let sender = null;
let interactiveSender = null;
let selfPhone = '';
/** @type {'cloud'|'wweb'|'text'} */
let channel = 'text';

/** @param {(phone: string, text: string) => Promise<void>} fn */
export function setSender(fn) {
  sender = fn;
}

/**
 * Envío de botones interactivos (Cloud API). Si no hay, se hace fallback a texto.
 * @param {(phone: string, payload: { bodyText: string, buttons: { id: string, title: string }[], footer?: string }) => Promise<void>} fn
 */
export function setInteractiveSender(fn) {
  interactiveSender = fn;
}

/** @param {'cloud'|'wweb'|'text'} name */
export function setChannel(name) {
  channel = name;
}

export function getChannel() {
  return channel;
}

/** Número del propio negocio (en whatsapp-web.js): recibe los avisos si no hay ADVISOR_PHONE. */
export function setSelfPhone(phone) {
  selfPhone = phone;
}

export function getSelfPhone() {
  return selfPhone;
}

function templateRecord() {
  const name = config.whatsapp.templateName || 'sin_nombre';
  return `[Plantilla ${name} enviada: fuera de la ventana de 24 h no se puede mandar texto libre]`;
}

/** Texto que queda en el historial: la plantilla, si el texto libre no estaba permitido. */
export function outboundRecord(result, text) {
  if (result?.mode === 'template') return templateRecord();
  return text;
}

async function freeTextAllowed(phone) {
  const chat = await db.getChat(phone);
  return isWithinServiceWindow(chat?.last_user_message_at, Date.now(), config.serviceWindowHours);
}

async function sendApprovedTemplate(phone, reason) {
  console.warn(`[${phone}] ${reason} Se envía la plantilla "${config.whatsapp.templateName}".`);
  await sendTemplate(phone);
  return { mode: 'template' };
}

/**
 * Envía texto libre, o la plantilla aprobada si la ventana de 24 h está cerrada
 * (también si Meta responde 131047).
 * @returns {Promise<{ mode: 'text'|'template', recovered?: boolean }>}
 */
export async function sendMessage(phone, text) {
  if (!sender) throw new Error('El canal de WhatsApp aún no está conectado');
  if (channel === 'cloud' && !await freeTextAllowed(phone)) {
    return sendApprovedTemplate(phone, 'Fuera de la ventana de 24 h.');
  }
  try {
    await sender(phone, text);
    return { mode: 'text' };
  } catch (err) {
    if (channel === 'cloud' && isServiceWindowError(err)) {
      const sent = await sendApprovedTemplate(phone, 'WhatsApp devolvió 131047.');
      return { ...sent, recovered: true };
    }
    throw err;
  }
}

/**
 * WhatsApp Cloud API interactive buttons, o texto con payloads si el canal no soporta botones.
 * @param {string} phone
 * @param {{ bodyText: string, buttons: { id: string, title: string }[], footer?: string }} payload
 */
export async function sendInteractiveButtons(phone, payload) {
  if (interactiveSender) {
    await interactiveSender(phone, payload);
    return;
  }
  const lines = [
    payload.bodyText,
    '',
    'Responda con un toque o escriba:',
    ...payload.buttons.map((b) => `• ${b.title} → \`${b.id}\``),
  ];
  if (payload.footer) lines.push('', `_${payload.footer}_`);
  await sendMessage(phone, lines.join('\n'));
}
