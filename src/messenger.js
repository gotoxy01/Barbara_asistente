// Punto único de envío de mensajes, independiente del canal (whatsapp-web.js o Cloud API de Meta).

let sender = null;
let selfPhone = '';

/** @param {(phone: string, text: string) => Promise<void>} fn */
export function setSender(fn) {
  sender = fn;
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
