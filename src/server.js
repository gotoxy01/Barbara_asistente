// Bárbara conectada a la WhatsApp Cloud API oficial de Meta (webhook).
// Uso: npm run start:cloud   (la opción principal es "npm start", con código QR)
import express from 'express';
import { config, assertGeminiConfig, assertWhatsAppConfig } from './config.js';
import * as db from './db.js';
import { setSender } from './messenger.js';
import { enqueue } from './queue.js';
import { handleAdvisorCommand } from './services/advisorCommands.js';
import { getBcvRate } from './services/bcvService.js';
import { getCatalogInfo } from './services/catalogService.js';
import { handleCustomerMessage } from './services/chatService.js';
import { voiceNoteToText } from './services/mediaService.js';
import { downloadMedia, isValidSignature, markAsRead, sendText } from './whatsapp.js';

assertWhatsAppConfig();
assertGeminiConfig();
setSender((phone, text) => sendText(phone, text));

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('Bárbara - Abasto Los Cuchos: en línea ✅'));

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (!isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) {
    console.warn('Firma de webhook inválida; petición descartada');
    return res.sendStatus(401);
  }

  // Meta reintenta si no recibe 200 rápido, así que se responde antes de procesar.
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = value.contacts ?? [];
      for (const message of value.messages ?? []) {
        const name = contacts.find((c) => c.wa_id === message.from)?.profile?.name;
        enqueue(message.from, () => processMessage(message, name));
      }
    }
  }
});

async function messageToText(message) {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';
    case 'image':
      return `[El cliente adjuntó una imagen${message.image?.caption ? ` con el texto: "${message.image.caption}"` : ''}]`;
    case 'document':
      return `[El cliente adjuntó un documento${message.document?.filename ? ` llamado "${message.document.filename}"` : ''}${message.document?.caption ? ` con el texto: "${message.document.caption}"` : ''}]`;
    case 'audio':
      return voiceNoteToText(() => downloadMedia(message.audio.id));
    case 'video':
      return '[El cliente envió un video]';
    case 'location':
      return `[El cliente compartió su ubicación: ${message.location?.name || ''} ${message.location?.address || ''} (lat ${message.location?.latitude}, lon ${message.location?.longitude})]`;
    case 'sticker':
      return '[El cliente envió un sticker]';
    case 'button':
      return message.button?.text ?? '';
    case 'interactive':
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '';
    default:
      return null;
  }
}

async function processMessage(message, name) {
  if (!db.markProcessed(message.id)) return;

  markAsRead(message.id).catch(() => {});

  if (config.advisorPhone && message.from === config.advisorPhone && message.type === 'text') {
    if (await handleAdvisorCommand(message.text.body)) return;
  }

  const text = await messageToText(message);
  if (!text) return;

  const phone = message.from;
  const result = await handleCustomerMessage({ phone, name, text });

  if (result.reply) await sendText(phone, result.reply);
}

app.listen(config.port, () => {
  console.log(`Bárbara escuchando en http://localhost:${config.port}`);
  console.log(`Webhook: http://localhost:${config.port}/webhook`);
  const catalog = getCatalogInfo();
  console.log(`Catálogo: ${catalog.count} productos (${catalog.source})`);
  getBcvRate().then((bcv) => console.log(bcv ? `Tasa BCV: ${bcv.rate} Bs/USD (${bcv.date})` : 'Tasa BCV no disponible'));
  if (!config.advisorPhone) console.warn('ADVISOR_PHONE no configurado: no se enviarán avisos de escalado.');
});
