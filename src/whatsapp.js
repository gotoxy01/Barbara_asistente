import crypto from 'node:crypto';
import { config, isPanelMode } from './config.js';

function apiUrl(path) {
  return `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/${path}`;
}

async function post(path, body) {
  if (isPanelMode()) {
    console.log(`[modo prueba] Envío a WhatsApp deshabilitado (${path}) para +${body?.to || '?'}.`);
    return { skipped: true, messages: [] };
  }
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
    throw new WhatsAppApiError(res.status, data);
  }
  return data;
}

export class WhatsAppApiError extends Error {
  constructor(status, data) {
    super(`WhatsApp API ${status}: ${JSON.stringify(data?.error || data)}`);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = Number(data?.error?.code) || null;
  }
}

/** Meta rechaza texto libre fuera de la ventana de 24 h con el código 131047. */
export function isServiceWindowError(err) {
  return Number(err?.code) === 131047 || /131047/.test(String(err?.message ?? ''));
}

export function sendText(to, text) {
  return post('messages', {
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  });
}

/**
 * Tarjeta con hasta 3 botones de respuesta rápida (WhatsApp Cloud API).
 * Títulos máx. 20 caracteres; ids máx. 256.
 * @param {string} to
 * @param {{ bodyText: string, buttons: { id: string, title: string }[], footer?: string }} opts
 */
export function sendInteractiveButtons(to, { bodyText, buttons, footer }) {
  const replyButtons = (buttons || []).slice(0, 3).map((b) => ({
    type: 'reply',
    reply: {
      id: String(b.id).slice(0, 256),
      title: String(b.title).slice(0, 20),
    },
  }));
  return post('messages', {
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(bodyText || '').slice(0, 1024) },
      ...(footer ? { footer: { text: String(footer).slice(0, 60) } } : {}),
      action: { buttons: replyButtons },
    },
  });
}

/**
 * Lista interactiva. Máximo 10 filas; título ≤24; descripción ≤72.
 * @param {string} to
 * @param {{ bodyText: string, buttonText?: string, rows: { id: string, title: string, description?: string }[] }} opts
 */
export function sendInteractiveList(to, { bodyText, buttonText = 'Ver opciones', rows }) {
  const mapped = (rows || []).slice(0, 10).map((row) => ({
    id: String(row.id).slice(0, 200),
    title: String(row.title).slice(0, 24),
    ...(row.description ? { description: String(row.description).slice(0, 72) } : {}),
  }));
  return post('messages', {
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: {
        button: String(buttonText).slice(0, 20),
        sections: [{ title: 'Opciones', rows: mapped }],
      },
    },
  });
}

/** Plantilla preaprobada. Es el único envío permitido fuera de la ventana de 24 h. */
export function sendTemplate(to, name = config.whatsapp.templateName, lang = config.whatsapp.templateLang) {
  if (!name) throw new Error('Falta WHATSAPP_TEMPLATE_NAME para escribir fuera de la ventana de 24 h');
  return post('messages', {
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name,
      language: { code: lang || 'es' },
    },
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

/**
 * Firma HMAC-SHA256 del cuerpo crudo. Sin secreto, o con cabecera ausente, rechaza.
 * @param {Buffer|string|null|undefined} rawBody
 * @param {string|undefined} signatureHeader  valor de X-Hub-Signature-256
 * @param {string} appSecret
 */
export function verifyHubSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || rawBody == null) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function isValidSignature(rawBody, signatureHeader) {
  return verifyHubSignature(rawBody, signatureHeader, config.whatsapp.appSecret);
}
