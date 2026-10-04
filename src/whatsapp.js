import crypto from 'node:crypto';
import { config } from './config.js';

function apiUrl(path) {
  return `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/${path}`;
}

async function post(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data.error || data)}`);
  }
  return data;
}

export function sendText(to, text) {
  return post('messages', {
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  });
}

/** Marca el mensaje como leído y muestra "escribiendo..." al cliente (hasta 25 s o hasta que llegue la respuesta). */
export function markAsRead(messageId) {
  return post('messages', { status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
}

/** Descarga un archivo multimedia recibido (p. ej. una nota de voz) y lo devuelve en base64. */
export async function downloadMedia(mediaId) {
  const headers = { Authorization: `Bearer ${config.whatsapp.token}` };
  const metaRes = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`, { headers });
  if (!metaRes.ok) throw new Error(`WhatsApp media ${metaRes.status}`);
  const { url, mime_type: mimeType } = await metaRes.json();
  const fileRes = await fetch(url, { headers });
  if (!fileRes.ok) throw new Error(`WhatsApp media download ${fileRes.status}`);
  return { mimeType, data: Buffer.from(await fileRes.arrayBuffer()).toString('base64') };
}

export function isValidSignature(rawBody, signatureHeader) {
  if (!config.whatsapp.appSecret) return true;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(rawBody)
    .digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  );
}
