// Bárbara conectada a WhatsApp escaneando un código QR con el teléfono del negocio (whatsapp-web.js).
// Uso: npm start
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';
import { assertGeminiConfig, config } from './config.js';
import * as db from './db.js';
import { setSelfPhone, setSender } from './messenger.js';
import { enqueue } from './queue.js';
import { handleAdvisorCommand } from './services/advisorCommands.js';
import { getBcvRate } from './services/bcvService.js';
import { getCatalogInfo } from './services/catalogService.js';
import { handleCustomerMessage, notifyAdvisor, recordAdvisorMessage } from './services/chatService.js';
import { voiceNoteToText } from './services/mediaService.js';

const { Client, LocalAuth } = wweb;

assertGeminiConfig();
migrateLegacySession();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: config.wweb.sessionPath }),
  webVersionCache: { type: 'none' },
  puppeteer: {
    headless: config.wweb.headless,
    protocolTimeout: 120_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

/** Copia la sesión de la carpeta del proyecto (dentro de OneDrive) a la nueva ubicación, para no volver a escanear el QR. */
function migrateLegacySession() {
  const legacy = path.resolve('.wwebjs_auth');
  const target = path.resolve(config.wweb.sessionPath);
  if (legacy === target || !fs.existsSync(legacy) || fs.existsSync(target)) return;
  try {
    fs.cpSync(legacy, target, { recursive: true });
    console.log(`Sesión de WhatsApp movida fuera de OneDrive: ${target}`);
  } catch (err) {
    console.warn('No se pudo copiar la sesión anterior (habrá que escanear el QR de nuevo):', err.message);
  }
}

// ---------------------------------------------------------------------------
// Identificación de clientes
// ---------------------------------------------------------------------------

/** teléfono -> id del chat de WhatsApp (puede ser @c.us o @lid), para responder al chat correcto. */
const chatIdByPhone = new Map();
const phoneByLid = new Map();

const digits = (id) => String(id).split('@')[0].split(':')[0].replace(/\D/g, '');

/** Las versiones nuevas de WhatsApp Web no siempre traen `_serialized` en los ids. */
function serializeId(id) {
  if (!id) return '';
  if (typeof id === 'string') return id;
  if (id._serialized) return serializeId(id._serialized);
  if (id.id) return `${id.fromMe ? 'true' : 'false'}_${serializeId(id.remote)}_${id.id}`;
  if (id.user) return `${id.user}@${id.server || 'c.us'}`;
  return '';
}

function messageKey(msg) {
  return serializeId(msg.id) || `${msg.from}_${msg.timestamp}_${msg.body ?? ''}`.slice(0, 200);
}

/** WhatsApp a veces oculta el número detrás de un id "@lid"; aquí se recupera el teléfono real. */
async function resolvePhone(chatId) {
  if (!chatId.endsWith('@lid')) return digits(chatId);
  if (phoneByLid.has(chatId)) return phoneByLid.get(chatId);
  let phone = digits(chatId);
  try {
    const [info] = await client.getContactLidAndPhone([chatId]);
    if (info?.pn) phone = digits(info.pn);
  } catch (err) {
    console.warn(`No se pudo obtener el teléfono de ${chatId}:`, err.message);
  }
  phoneByLid.set(chatId, phone);
  return phone;
}

function isCustomerChat(id) {
  return Boolean(id) && (id.endsWith('@c.us') || id.endsWith('@lid'));
}

// ---------------------------------------------------------------------------
// Envío (con registro de lo que envía el bot, para detectar cuando responde una persona)
// ---------------------------------------------------------------------------

const botSent = new Map(); // "teléfono|texto" -> marca de tiempo

function rememberBotSent(phone, text) {
  const key = `${phone}|${text.trim()}`;
  botSent.set(key, Date.now());
  setTimeout(() => botSent.delete(key), 120_000);
}

/** Ids posibles de un chat: el número real (@c.us) primero, porque WhatsApp Web a veces falla al abrir chats @lid. */
function chatIdCandidates(phone, chatId) {
  return [...new Set([phone && `${phone}@c.us`, chatId].filter(Boolean))];
}

async function sendToPhone(phone, text, chatId = chatIdByPhone.get(phone)) {
  let lastError;
  rememberBotSent(phone, text);
  for (const id of chatIdCandidates(phone, chatId)) {
    try {
      await client.sendMessage(id, text);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Chat para marcar como leído y mostrar "escribiendo..."; es opcional, si falla se sigue sin eso. */
async function getChatSafe(phone, chatId) {
  for (const id of chatIdCandidates(phone, chatId)) {
    try {
      const chat = await client.getChatById(id);
      if (chat) return chat;
    } catch {
      // se prueba el siguiente id
    }
  }
  return null;
}

setSender((phone, text) => sendToPhone(phone, text));

// ---------------------------------------------------------------------------
// Conversión de mensajes a texto
// ---------------------------------------------------------------------------

async function messageToText(msg) {
  const caption = msg.body ? ` con el texto: "${msg.body}"` : '';
  switch (msg.type) {
    case 'chat':
    case 'buttons_response':
    case 'list_response':
    case 'template_button_reply':
      return msg.body || null;
    case 'ptt':
    case 'audio':
      return voiceNoteToText(async () => {
        const media = await msg.downloadMedia();
        return media ? { mimeType: media.mimetype, data: media.data } : null;
      });
    case 'image':
      return `[El cliente adjuntó una imagen${caption}]`;
    case 'document': {
      const filename = msg._data?.filename ? ` llamado "${msg._data.filename}"` : '';
      return `[El cliente adjuntó un documento${filename}${caption}]`;
    }
    case 'video':
      return `[El cliente envió un video${caption}]`;
    case 'location': {
      const loc = msg.location ?? {};
      return `[El cliente compartió su ubicación: ${loc.description || ''} (lat ${loc.latitude}, lon ${loc.longitude})]`;
    }
    case 'sticker':
      return '[El cliente envió un sticker]';
    case 'vcard':
    case 'multi_vcard':
      return '[El cliente compartió un contacto]';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mensajes entrantes
// ---------------------------------------------------------------------------

async function processIncoming(msg, phone) {
  if (!db.markProcessed(messageKey(msg))) return;

  const chat = await getChatSafe(phone, msg.from);
  chat?.sendSeen().catch(() => {});

  if (config.advisorPhone && phone === config.advisorPhone && msg.type === 'chat') {
    if (await handleAdvisorCommand(msg.body, { quotedBody: await quotedBodyOf(msg) })) return;
  }

  chat?.sendStateTyping().catch(() => {});
  const text = await messageToText(msg);
  if (!text) {
    chat?.clearState().catch(() => {});
    return;
  }

  const name = msg._data?.notifyName || (await msg.getContact().catch(() => null))?.pushname;
  console.log(`[${phone}] Cliente: ${text.slice(0, 120)}`);
  const result = await handleCustomerMessage({ phone, name, text });

  if (result.paused && !result.reply) {
    console.log(`[${phone}] Chat pausado (atendido por una persona): Bárbara no responde. Para reactivarla escriba en "Mensajes para mí": #reanudar ${phone}`);
  }
  if (result.reply) {
    await sendToPhone(phone, result.reply, msg.from);
    console.log(`[${phone}] Bárbara respondió${result.model ? ` (${result.model})` : ''}.`);
  }
  chat?.clearState().catch(() => {});
}

function debugEvent(event, msg) {
  if (!config.wweb.debug) return;
  console.log(`[debug ${event}] type=${msg.type} fromMe=${msg.fromMe} from=${msg.from} to=${msg.to} body=${String(msg.body ?? '').slice(0, 40)}`);
}

client.on('message', async (msg) => {
  debugEvent('message', msg);
  if (msg.fromMe || msg.isStatus || !isCustomerChat(msg.from) || !['chat', 'ptt', 'audio', 'image', 'document', 'video', 'location', 'sticker', 'vcard', 'multi_vcard', 'buttons_response', 'list_response'].includes(msg.type)) return;
  const phone = await resolvePhone(msg.from);
  chatIdByPhone.set(phone, msg.from);
  enqueue(phone, () => processIncoming(msg, phone));
});

// ---------------------------------------------------------------------------
// Mensajes enviados desde el propio teléfono del negocio
// ---------------------------------------------------------------------------

async function quotedBodyOf(msg) {
  if (!msg.hasQuotedMsg) return undefined;
  try {
    return (await msg.getQuotedMessage())?.body;
  } catch {
    return undefined;
  }
}

/** Al conectar, WhatsApp reenvía mensajes viejos; esos no deben contar como respuestas manuales. */
const STALE_MESSAGE_MS = 2 * 60 * 1000;
const isStale = (msg) => msg.timestamp && Date.now() - msg.timestamp * 1000 > STALE_MESSAGE_MS;

client.on('message_create', async (msg) => {
  debugEvent('message_create', msg);
  if (!msg.fromMe || !isCustomerChat(msg.to) || isStale(msg)) return;

  // Comandos escritos en "Mensajes para mí" (chat con uno mismo; el id puede ser @c.us o @lid).
  const own = serializeId(client.info?.wid);
  const phone = await resolvePhone(msg.to);
  if (msg.to === msg.from || msg.to === own || phone === getOwnPhone()) {
    if (msg.type === 'chat' && msg.body.startsWith('#')) {
      const quotedBody = await quotedBodyOf(msg);
      enqueue('asesor', () => handleAdvisorCommand(msg.body, { quotedBody }));
    }
    return;
  }

  if (msg.type !== 'chat') return;
  if (botSent.has(`${phone}|${msg.body.trim()}`)) return;

  // Una persona respondió desde el teléfono del negocio: Bárbara se calla unos minutos en ese chat
  // (cada mensaje manual reinicia el contador) y luego se reactiva sola.
  chatIdByPhone.set(phone, msg.to);
  enqueue(phone, async () => {
    const wasPaused = db.getChat(phone)?.paused === 1;
    recordAdvisorMessage(phone, msg.body);
    db.pauseChat(phone, config.manualPauseMinutes * 60 * 1000);
    if (!wasPaused) {
      console.log(`[${phone}] Respuesta manual desde el teléfono del negocio: Bárbara pausada ${config.manualPauseMinutes} min en este chat.`);
      await notifyAdvisor(
        `✋ Usted respondió a +${phone} desde el teléfono: Bárbara se pausa ${config.manualPauseMinutes} min en ese chat y luego se reactiva sola.\n` +
        `Para reactivarla ya: #reanudar ${phone}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Ciclo de vida de la sesión
// ---------------------------------------------------------------------------

function getOwnPhone() {
  return digits(serializeId(client.info?.wid));
}

client.on('qr', (qr) => {
  console.log('\nEscanee este código con el WhatsApp del negocio (Dispositivos vinculados > Vincular un dispositivo):\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('Sesión de WhatsApp autenticada.'));
client.on('auth_failure', (m) => console.error('Falló la autenticación de WhatsApp:', m, '\nBorre la carpeta', config.wweb.sessionPath, 'y vuelva a escanear el QR.'));

client.on('ready', async () => {
  setSelfPhone(getOwnPhone());
  const catalog = getCatalogInfo();
  const bcv = await getBcvRate();
  console.log(`\n✅ Bárbara conectada a WhatsApp como +${getOwnPhone()}`);
  console.log(`Catálogo: ${catalog.count} productos (${catalog.source})`);
  console.log(catalog.deliveryFromCatalog
    ? `Delivery: $ ${catalog.deliveryUsd.toFixed(2)} por pedido (artículo "${config.delivery.itemName}" de la caja)`
    : `⚠️ No se encontró el artículo "${config.delivery.itemName}" en la caja: delivery a $ ${catalog.deliveryUsd.toFixed(2)} (DELIVERY_FALLBACK_USD)`);
  console.log(bcv ? `Tasa BCV: ${bcv.rate} Bs/USD (${bcv.date})` : 'Tasa BCV no disponible');
  console.log(config.advisorPhone
    ? `Avisos al asesor: +${config.advisorPhone}`
    : 'Avisos al asesor: chat "Mensajes para mí" de este mismo WhatsApp (configure ADVISOR_PHONE para usar otro número)');
});

client.on('disconnected', (reason) => {
  console.warn('WhatsApp se desconectó:', reason, '- reintentando en 10 s...');
  setTimeout(() => start(), 10_000);
});

// Las llamadas (entrantes, salientes o perdidas) no pausan a Bárbara: solo los mensajes de texto
// escritos a mano desde el teléfono del negocio la pausan.
client.on('call', async (call) => {
  const phone = await resolvePhone(serializeId(call.from)).catch(() => digits(serializeId(call.from)));
  console.log(`📞 Llamada ${call.isVideo ? 'de video ' : ''}de +${phone}: Bárbara sigue activa en ese chat.`);
});

client.on('change_state', (state) => console.log(`Estado de WhatsApp: ${state}`));

// ---------------------------------------------------------------------------
// Vigilancia de la conexión: si el internet o la PC se "duermen", WhatsApp Web queda
// conectado en apariencia pero deja de recibir mensajes. Aquí se detecta y se reconecta.
// ---------------------------------------------------------------------------

const WATCHDOG_INTERVAL_MS = 60_000;
let failedChecks = 0;
let restarting = false;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('sin respuesta')), ms))]);
}

async function checkConnection() {
  if (restarting || !client.info) return;
  let state;
  try {
    state = await withTimeout(client.getState(), 20_000);
  } catch (err) {
    state = `error (${err.message})`;
  }
  if (state === 'CONNECTED') {
    if (failedChecks) console.log('✅ Conexión con WhatsApp recuperada.');
    failedChecks = 0;
    return;
  }
  failedChecks += 1;
  console.warn(`⚠️ WhatsApp no está conectado (estado: ${state}). Revise el internet de la PC. [${failedChecks}/3]`);
  if (failedChecks >= 3) await restartClient();
}

async function restartClient() {
  restarting = true;
  failedChecks = 0;
  console.warn('Reiniciando la conexión con WhatsApp...');
  await client.destroy().catch(() => {});
  restarting = false;
  start();
}

setInterval(checkConnection, WATCHDOG_INTERVAL_MS);

process.on('SIGINT', async () => {
  console.log('\nCerrando Bárbara...');
  await client.destroy().catch(() => {});
  process.exit(0);
});

const MAX_START_ATTEMPTS = 3;

async function start(attempt = 1) {
  try {
    await client.initialize();
  } catch (err) {
    console.error(`No se pudo abrir WhatsApp Web (intento ${attempt} de ${MAX_START_ATTEMPTS}): ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack.split('\n').slice(1, 14).join('\n'));
    await client.destroy().catch(() => {});
    if (attempt < MAX_START_ATTEMPTS) {
      console.log('Reintentando en 15 s...');
      setTimeout(() => start(attempt + 1), 15_000);
      return;
    }
    console.error(
      '\nWhatsApp Web no termina de cargar. Revise:\n' +
      '  1. Que la PC tenga internet.\n' +
      '  2. Que en el teléfono, en "Dispositivos vinculados", siga apareciendo esta PC.\n' +
      `  3. Si no aparece, borre la carpeta ${path.resolve(config.wweb.sessionPath)} y vuelva a ejecutar npm start para escanear el QR.`,
    );
    process.exit(1);
  }
}

function packageVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve('node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}

console.log(`Node ${process.version} | whatsapp-web.js ${packageVersion('whatsapp-web.js')} | puppeteer ${packageVersion('puppeteer')}`);
console.log('Iniciando WhatsApp (la primera vez tarda un poco)...');
start();
