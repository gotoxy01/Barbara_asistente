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
    // false por defecto: la consola no se llena con cada mensaje de WhatsApp.
    debug: /^(1|true|si|sí|yes)$/i.test(process.env.WWEB_DEBUG || 'false'),
    // Grupos donde Bárbara atiende a quien escribe, pero siempre respondiéndole por privado.
    groupNames: (process.env.WWEB_GROUPS ?? '').split(',').map((g) => g.trim()).filter(Boolean),
  },
  // true = imprime cada Cliente / Bárbara respondió (útil para depurar).
  logVerbose: /^(1|true|si|sí|yes)$/i.test(process.env.LOG_VERBOSE || 'false'),
  crm: {
    host: process.env.CRM_HOST || '127.0.0.1',
    port: Number(process.env.CRM_PORT || 3847),
    token: process.env.CRM_TOKEN || '',
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v26.0',
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || '',
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'es',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    // Reintentos solo para fallas pasajeras (429 por ráfaga, 5xx, tiempo agotado).
    maxRetries: Number(process.env.GEMINI_MAX_RETRIES ?? 2),
    // Tope de espera reintentando un mismo mensaje.
    retryBudgetMs: Number(process.env.GEMINI_RETRY_BUDGET_MS || 15000),
    // Cuántos clientes puede atender Gemini a la vez. Más de esto satura el modelo y Google responde 503.
    concurrency: Number(process.env.GEMINI_CONCURRENCY || 2),
    // Modelo que se usa si el principal está saturado (503) o no responde a tiempo. Vacío = sin respaldo.
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-latest',
    stableModels: (process.env.GEMINI_STABLE_MODELS || 'gemini-3.5-flash,gemini-flash-latest')
      .split(',').map((name) => name.trim()).filter(Boolean),
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 12000),
    // Tope de la respuesta. El razonamiento largo de Gemini 3 se recorta aparte (thinking mínimo).
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 512),
  },
  // Segunda pasada: revisa precios/cálculos del borrador antes de WhatsApp. AUDITOR_ENABLED=false para desactivar.
  auditor: {
    enabled: !/^(0|false|no)$/i.test(process.env.AUDITOR_ENABLED || 'true'),
    // Vacío = mismo modelo que Bárbara (flash). Puede fijar uno más barato si quiere.
    model: process.env.AUDITOR_MODEL || '',
  },
  // Requerimientos físicos → bloc de notas del CRM. WhatsApp al operador solo si OPERATOR_WA_PING=true.
  operatorConsole: {
    enabled: !/^(0|false|no)$/i.test(process.env.OPERATOR_BUTTONS_ENABLED || 'true'),
    highOrderUsd: Number(process.env.OPERATOR_HIGH_ORDER_USD || 50),
    persistTickets: !/^(0|false|no)$/i.test(process.env.OPERATOR_TICKETS_PERSIST || 'true'),
    // false por defecto: no saturar "Mensajes para mí"; se atiende en http://127.0.0.1:3847
    whatsappPing: /^(1|true|si|sí|yes)$/i.test(process.env.OPERATOR_WA_PING || 'false'),
  },
  advisorPhone: (process.env.ADVISOR_PHONE || '').replace(/\D/g, ''),
  // Horas para volver sola de SPECIALIST a BOT. 0 = se queda callada hasta #reanudar.
  specialistAutoResumeHours: Number(process.env.SPECIALIST_AUTO_RESUME_HOURS ?? 0),
  // Se conserva por compatibilidad; el pase a especialista ya no usa este plazo.
  pauseHours: Number(process.env.BOT_PAUSE_HOURS || 12),
  confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 85),
  debounceWindowMs: Number(process.env.DEBOUNCE_WINDOW_MS ?? 3500),
  flood: {
    perMinute: Number(process.env.MAX_MENSAJES_POR_MINUTO ?? 10),
    perDay: Number(process.env.MAX_MENSAJES_POR_DIA ?? 150),
    blockMinutes: Number(process.env.BLOQUEO_MINUTOS ?? 30),
  },
  usage: {
    serviceFree: Number(process.env.WA_SERVICE_FREE ?? 1000),
    serviceUsd: Number(process.env.WA_SERVICE_USD ?? 0.0113),
    marketingUsd: Number(process.env.WA_MARKETING_USD ?? 0.074),
    inputPerMillion: Number(process.env.GEMINI_INPUT_USD_PER_MILLION ?? 0.30),
    outputPerMillion: Number(process.env.GEMINI_OUTPUT_USD_PER_MILLION ?? 2.50),
  },
  serviceWindowHours: Number(process.env.SERVICE_WINDOW_HOURS ?? 24),
  // Si es false, un error técnico de Gemini NO pausa el chat (el cliente puede reintentar)
  pauseOnError: /^(1|true|si|sí)$/i.test(process.env.PAUSE_ON_ERROR || 'false'),
  historyLimit: Number(process.env.HISTORY_LIMIT || 20),
  // Un pedido sin actividad (y el historial que ve la IA) dejan de contar después de estas horas.
  orderMemoryHours: Number(process.env.ORDER_MEMORY_HOURS || 24),
  timezone: process.env.TIMEZONE || 'America/Caracas',
  dbPath: process.env.DB_PATH || 'barbara.db',
  databaseUrl: process.env.DATABASE_URL || '',
  postgresAdminUrl: process.env.POSTGRES_ADMIN_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  embedding: {
    model: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS || 768),
  },
  hybrid: {
    keywordWeight: Number(process.env.HYBRID_KEYWORD_WEIGHT || 0.55),
    vectorWeight: Number(process.env.HYBRID_VECTOR_WEIGHT || 0.45),
  },
  delivery: {
    // Artículo del sistema de caja cuyo precio es el costo del delivery (uno por pedido)
    itemName: process.env.DELIVERY_ITEM_NAME || 'Delivery costo',
    // Solo si ese artículo no existe en el catálogo
    fallbackUsd: Number(process.env.DELIVERY_FALLBACK_USD || 1.5),
  },
  pagoMovil: {
    telefono: process.env.PAGO_MOVIL_TELEFONO || '',
    cedula: process.env.PAGO_MOVIL_CEDULA || '',
    banco: process.env.PAGO_MOVIL_BANCO || '',
  },
  // Minutos que Bárbara se queda callada en un chat cuando un asesor escribe a mano (luego se reactiva sola).
  manualPauseMinutes: Number(process.env.MANUAL_PAUSE_MINUTES || 5),
  // Horas sin hablar con Bárbara para considerar que el cliente inicia una conversación nueva (y ella se presenta).
  newConversationHours: Number(process.env.NEW_CONVERSATION_HOURS || 6),
  // Al arrancar, o cuando Gemini vuelve, responde lo que quedó pendiente en esta ventana.
  catchupHours: Number(process.env.CATCHUP_HOURS || 1),
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
  required('WHATSAPP_APP_SECRET');
  required('WHATSAPP_TEMPLATE_NAME');
}

export function assertGeminiConfig() {
  required('GEMINI_API_KEY');
}

/** Datos del negocio que no pueden quedar escritos en el código. */
export function assertDatabaseConfig() {
  required('DATABASE_URL');
}

export function assertBusinessConfig() {
  required('PAGO_MOVIL_TELEFONO');
  required('PAGO_MOVIL_CEDULA');
  required('PAGO_MOVIL_BANCO');
  required('CRM_TOKEN');
}
