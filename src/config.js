import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name} (revise su archivo .env)`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  wweb: {
    // Carpeta donde whatsapp-web.js guarda la sesión (para no escanear el QR cada vez).
    // Por defecto fuera de OneDrive: la sincronización bloquea los archivos de Chrome.
    sessionPath: process.env.WWEB_SESSION_PATH
      || path.join(process.env.LOCALAPPDATA || os.homedir(), 'barbara-los-cuchos', 'wwebjs_auth'),
    headless: !/^(0|false|no)$/i.test(process.env.WWEB_HEADLESS || 'true'),
    debug: /^(1|true|si|sí|yes)$/i.test(process.env.WWEB_DEBUG || 'true'),
    // Grupos donde Bárbara atiende a quien escribe, pero siempre respondiéndole por privado.
    groupNames: (process.env.WWEB_GROUPS ?? 'Bodega los cuchos').split(',').map((g) => g.trim()).filter(Boolean),
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    // Reintentos solo para fallas pasajeras (429 por ráfaga, 5xx, respuesta vacía)
    maxRetries: Number(process.env.GEMINI_MAX_RETRIES ?? 2),
    // Modelo que se usa de inmediato si el principal está saturado (503) o no responde a tiempo. Vacío = sin respaldo.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.1-flash-lite',
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 20000),
  },
  advisorPhone: (process.env.ADVISOR_PHONE || '').replace(/\D/g, ''),
  pauseHours: Number(process.env.BOT_PAUSE_HOURS || 12),
  // Si es false, un error técnico de Gemini NO pausa el chat (el cliente puede reintentar)
  pauseOnError: /^(1|true|si|sí)$/i.test(process.env.PAUSE_ON_ERROR || 'false'),
  historyLimit: Number(process.env.HISTORY_LIMIT || 20),
  timezone: process.env.TIMEZONE || 'America/Caracas',
  dbPath: process.env.DB_PATH || 'barbara.db',
  delivery: {
    // Artículo del sistema de caja cuyo precio es el costo del delivery (uno por pedido)
    itemName: process.env.DELIVERY_ITEM_NAME || 'Delivery costo',
    // Solo si ese artículo no existe en el catálogo
    fallbackUsd: Number(process.env.DELIVERY_FALLBACK_USD || 1.5),
  },
  pagoMovil: {
    telefono: process.env.PAGO_MOVIL_TELEFONO || '0414-3697834',
    cedula: process.env.PAGO_MOVIL_CEDULA || '29953424',
    banco: process.env.PAGO_MOVIL_BANCO || 'Banesco',
  },
  // Minutos que Bárbara se queda callada en un chat cuando un asesor escribe a mano (luego se reactiva sola).
  manualPauseMinutes: Number(process.env.MANUAL_PAUSE_MINUTES || 5),
  // Horas sin hablar con Bárbara para considerar que el cliente inicia una conversación nueva (y ella se presenta).
  newConversationHours: Number(process.env.NEW_CONVERSATION_HOURS || 6),
  bcv: {
    // Si se define (> 0), se usa esta tasa fija en lugar de consultarla en línea
    manualRate: Number(process.env.BCV_RATE || 0),
    apiUrl: process.env.BCV_API_URL || 'https://ve.dolarapi.com/v1/dolares/oficial',
    refreshMinutes: Number(process.env.BCV_REFRESH_MINUTES || 60),
  },
  catalog: {
    // auto = usa la base de la caja si existe; si no, el JSON
    source: (process.env.CATALOG_SOURCE || 'auto').toLowerCase(),
    dbPath: process.env.CATALOG_DB_PATH || 'database.db',
    jsonPath: process.env.CATALOG_JSON_PATH || 'data/products.json',
    refreshMinutes: Number(process.env.CATALOG_REFRESH_MINUTES || 5),
    maxResults: Number(process.env.CATALOG_MAX_RESULTS || 12),  },
};

export function assertWhatsAppConfig() {
  required('WHATSAPP_TOKEN');
  required('WHATSAPP_PHONE_NUMBER_ID');
  required('WHATSAPP_VERIFY_TOKEN');
}

export function assertGeminiConfig() {
  required('GEMINI_API_KEY');
}
