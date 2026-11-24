// Bárbara en la WhatsApp Cloud API oficial de Meta (canal principal).
// Uso: npm start
import express from 'express';
import { assertBusinessConfig, assertDatabaseConfig, assertGeminiConfig, assertWhatsAppConfig, config } from './config.js';
import { startCrmServer } from './crm/server.js';
import * as db from './db.js';
import { initDb } from './db.js';
import { warn } from './log.js';
import { setChannel, setInteractiveSender, setSender } from './messenger.js';
import { enqueue, openInboundQueue } from './queue.js';
import { handleAdvisorCommand } from './services/advisorCommands.js';
import { getBcvRate } from './services/bcvService.js';
import { warnIfDemoCatalog } from './services/catalogService.js';
import { startCatalogSync } from './services/productSync.js';
import { completeCustomerTurn, handleCustomerMessage, startResumeLoop } from './services/chatService.js';
import { voiceNoteToText } from './services/mediaService.js';
import { tryHandleOperatorInbound } from './services/operatorConsoleService.js';
import {
  downloadMedia,
  isValidSignature,
  markAsRead,
  sendInteractiveButtons,
  sendText,
} from './whatsapp.js';

assertWhatsAppConfig();
assertGeminiConfig();
assertBusinessConfig();
assertDatabaseConfig();
await initDb();
setChannel('cloud');
setSender((phone, text) => sendText(phone, text));
setInteractiveSender((phone, payload) => sendInteractiveButtons(phone, payload));

startCrmServer().catch((err) => warn('No se pudo iniciar el CRM:', err.message));
startCatalogSync();
startResumeLoop();

const inbound = await openInboundQueue({
  windowMs: config.debounceWindowMs,
  onFlush: (phone, items) => processBatch(phone, items),
});

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('Bárbara - Abasto Los Cuchos: en línea'));

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

function usableId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

app.post('/webhook', async (req, res) => {
  if (!isValidSignature(req.rawBody, req.get('x-hub-signature-256'))) {
    console.warn('Firma de webhook ausente o inválida; petición rechazada');
    return res.sendStatus(401);
  }

  // Meta reintenta si no recibe 200 rápido, así que se responde antes de procesar.
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = value.contacts ?? [];
      for (const message of value.messages ?? []) {
        if (!usableId(message?.id)) {
          console.warn('Webhook sin wamid; mensaje omitido');
          continue;
        }
        if (await db.isDuplicateEvent(message.id)) continue;
        const name = contacts.find((c) => c.wa_id === message.from)?.profile?.name;
        if (config.advisorPhone && message.from === config.advisorPhone) {
          enqueue(message.from, () => processAdvisor(message, name));
        } else {
          inbound.push(message.from, { message, name });
        }
      }
    }
  }
});

async function messageToText(message) {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';
    case 'image':
      return `[El cliente adjuntó una imagen${message.image?.id ? ` id:${message.image.id}` : ''}${message.image?.caption ? ` con el texto: "${message.image.caption}"` : ''}]`;
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

async function processAdvisor(message, name) {
  try {
    markAsRead(message.id).catch(() => {});
    const buttonId = message.interactive?.button_reply?.id || message.button?.payload || null;
    const text = message.type === 'text'
      ? (message.text?.body ?? '')
      : (message.interactive?.button_reply?.title ?? message.button?.text ?? '');
    if (await tryHandleOperatorInbound({ buttonId, text, interactive: message.interactive, button: message.button })) {
      await db.markProcessed(message.id);
      return;
    }
    if (message.type === 'text' && await handleAdvisorCommand(message.text.body)) {
      await db.markProcessed(message.id);
      return;
    }
    await processBatch(message.from, [{ message, name }]);
  } catch (err) {
    console.error(`[${message.from}]`, err);
  }
}

async function processBatch(phone, items) {
  const fresh = [];
  for (const item of items) {
    if (usableId(item.message?.id) && !await db.isDuplicateEvent(item.message.id)) fresh.push(item);
  }
  if (!fresh.length) return;

  try {
    markAsRead(fresh.at(-1).message.id).catch(() => {});
    const texts = [];
    for (const item of fresh) {
      const text = await messageToText(item.message);
      if (text) texts.push(text);
    }
    if (!texts.length) {
      for (const item of fresh) await db.markProcessed(item.message.id);
      return;
    }
    const name = [...fresh].reverse().map((item) => item.name).find(Boolean);
    const result = await handleCustomerMessage({
      phone,
      name,
      text: texts.join('\n'),
      wamid: fresh[0].message.id,
    });
    await completeCustomerTurn(phone, result);
    for (const item of fresh) await db.markProcessed(item.message.id);
  } catch (err) {
    console.error(`[${phone}] No se completó el turno; Meta puede reintentarlo:`, err.message ?? err);
  }
}

app.listen(config.port, () => {
  console.log(`Bárbara (Cloud API ${config.whatsapp.apiVersion}) en http://localhost:${config.port}`);
  console.log(`Webhook: http://localhost:${config.port}/webhook`);
  const catalog = warnIfDemoCatalog();
  console.log(`Catálogo: ${catalog.count} productos (${catalog.source})`);
  getBcvRate().then((bcv) => console.log(bcv ? `Tasa BCV: ${bcv.rate} Bs/USD (${bcv.date})` : 'Tasa BCV no disponible'));
  if (!config.advisorPhone) console.warn('ADVISOR_PHONE no configurado: los avisos de escalado quedan en el CRM.');
  db.listOpenOrders()
    .then((orders) => console.log(`Pedidos abiertos recuperados: ${orders.length}.`))
    .catch((err) => console.warn('No se pudieron recargar los pedidos abiertos:', err.message));
});
