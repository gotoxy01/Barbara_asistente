// Punto único de envío de mensajes, independiente del canal (whatsapp-web.js o Cloud API de Meta).

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

export async function sendMessage(phone, text) {
  if (!sender) throw new Error('El canal de WhatsApp aún no está conectado');
  await sender(phone, text);
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
