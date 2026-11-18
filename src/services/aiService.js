import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { verbose } from '../log.js';
import { AUDITOR_SYSTEM_PROMPT } from '../prompts/auditor.js';
import {
  BARBARA_PROMPT,
  BUSINESS_INFO,
  CATALOG_SECTION,
  ESCALATION_TAG,
  IGNORE_TAG,
  KNOWLEDGE_BASE_MARKER,
  ORDER_SECTION,
  SESSION_SECTION,
} from '../prompts/barbara.js';

let client;

function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.gemini.apiKey, httpOptions: { timeout: config.gemini.timeoutMs } });
  }
  return client;
}

function nowInVenezuela() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: config.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date());
}

export function greetingForNow() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 12) return '¡Buenos días!';
  if (hour < 19) return '¡Buenas tardes!';
  return '¡Buenas noches!';
}

/**
 * Arma el System Prompt final de Bárbara: base de conocimiento + catálogo filtrado + datos de sesión.
 * Las partes fijas van primero y las que cambian en cada mensaje al final, para que Gemini pueda
 * reutilizar el prefijo en caché (caché implícita) y responder más rápido.
 * @param {{ name?: string, phone?: string, productContext: string, orderContext?: string }} session
 */
export function buildSystemPrompt({ name, phone, productContext, orderContext, isNewConversation = false }) {
  const staticPart = BARBARA_PROMPT.replace(KNOWLEDGE_BASE_MARKER, BUSINESS_INFO);
  const dynamicPart = [
    CATALOG_SECTION.replace('{CONTEXTO_PRODUCTOS}', productContext),
    ORDER_SECTION.replace('{PEDIDO_ACTUAL}', orderContext || 'El cliente aún no tiene productos en su pedido.'),
    SESSION_SECTION
      .replace('{NOMBRE_CLIENTE}', name || 'No indicado')
      .replace('{TELEFONO_CLIENTE}', phone ? `+${phone}` : 'No indicado')
      .replace('{FECHA_HORA_ACTUAL}', nowInVenezuela())
      .replace('{INICIO_CONVERSACION}', isNewConversation
        ? `SÍ: es el primer mensaje de esta conversación; preséntate como Bárbara empezando con "${greetingForNow()}".`
        : 'NO: ya te presentaste; no vuelvas a presentarte.'),
  ].join('\n\n');

  return `${staticPart}\n\n---\n\n# CONTEXTO DE ESTA CONSULTA (BASE DE CONOCIMIENTO DINÁMICA)\n\n${dynamicPart}`;
}

export class GeminiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind: 'billing'|'auth'|'model'|'rate_limit'|'server'|'empty'|'unknown', retryable: boolean, hint: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'GeminiError';
    Object.assign(this, info);
  }
}

function classifyError(err) {
  if (err instanceof GeminiError) return err;
  const message = String(err?.message ?? err);
  const status = Number(err?.status ?? message.match(/"code"\s*:\s*(\d{3})/)?.[1] ?? 0);

  if (status === 402 || /prepayment credits|billing/i.test(message)) {
    return new GeminiError(message, { status, kind: 'billing', retryable: false,
      hint: 'El proyecto de Google AI Studio no tiene créditos. Recargue o active la facturación en https://ai.studio/projects' });
  }
  if (status === 401 || status === 403 || /API_KEY|PERMISSION_DENIED/i.test(message)) {
    return new GeminiError(message, { status, kind: 'auth', retryable: false,
      hint: 'La clave no es válida para la Gemini API. Genere una en https://aistudio.google.com/apikey' });
  }
  if (status === 404 || status === 400) {
    return new GeminiError(message, { status, kind: 'model', retryable: false,
      hint: `Revise GEMINI_MODEL (actual: ${config.gemini.model}); ejecute "npm run check" para ver los modelos disponibles.` });
  }
  if (status === 429) {
    const quota = /quota|per day|limit: 0/i.test(message);
    return new GeminiError(message, { status, kind: 'rate_limit', retryable: !quota,
      hint: quota ? 'Se agotó la cuota del plan de Gemini.' : 'Demasiadas solicitudes seguidas; se reintentará.' });
  }
  if (status >= 500) {
    return new GeminiError(message, { status, kind: 'server', retryable: true, hint: 'Falla temporal de Google (modelo saturado).' });
  }
  if (/abort|timed?\s?out|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(message)) {
    return new GeminiError(message, { status, kind: 'timeout', retryable: true, hint: `Gemini no respondió en ${config.gemini.timeoutMs / 1000} s.` });
  }
  return new GeminiError(message, { status, kind: 'unknown', retryable: false, hint: 'Error inesperado de Gemini.' });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_TOOL_ROUNDS = 6;

const STABLE_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
const COOLDOWN_MS = 25_000;

/** El principal, los flash estables y al final el respaldo si es un modelo lite (se saturan primero). */
function modelRotation(current) {
  const fallback = config.gemini.fallbackModel;
  const lite = (name) => /lite/i.test(name ?? '');
  const ordered = [current || config.gemini.model];
  if (fallback && !lite(fallback)) ordered.push(fallback);
  ordered.push(...STABLE_MODELS);
  if (fallback && lite(fallback)) ordered.push(fallback);
  return [...new Set(ordered.filter(Boolean))];
}

// Un modelo que acaba de responder 503/504 no se vuelve a llamar durante unos segundos.
const cooldownUntil = new Map();
const cooling = (model) => (cooldownUntil.get(model) ?? 0) > Date.now();
const markDown = (model) => cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
const pickModel = (models) => models.find((model) => !cooling(model)) ?? null;

// Como máximo N llamadas a la vez. La espera entre reintentos no ocupa un cupo, así otro cliente puede pasar.
let geminiActive = 0;
const geminiWaiters = [];

function acquireGemini() {
  if (geminiActive < Math.max(1, config.gemini.concurrency)) {
    geminiActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => geminiWaiters.push(resolve));
}

function releaseGemini() {
  const next = geminiWaiters.shift();
  if (next) next();
  else geminiActive -= 1;
}

/**
 * Si el modelo está saturado, pasa al siguiente que no haya fallado hace un momento.
 * Varios clientes a la vez no se quedan esperando 15 o 20 s detrás del mismo 503.
 * @param {(model: string) => Promise<any>} fn
 * @param {{ model: string }} turn  modelo activo del turno; queda en el que respondió
 */
async function withRetries(fn, turn) {
  const models = modelRotation(turn.model);
  const max = Math.max(config.gemini.maxRetries, models.length);
  const budget = Math.min(Math.max(config.gemini.retryBudgetMs, 20_000), 60_000);
  const started = Date.now();
  let lastError;

  for (let attempt = 0; attempt <= max; attempt++) {
    let model = pickModel(models);
    if (!model) {
      const wait = Math.min(12_000, Math.min(...models.map((m) => cooldownUntil.get(m) ?? 0)) - Date.now());
      if (wait > 0 && Date.now() + wait - started < budget) {
        verbose(`Gemini saturado; siguiente intento en ${Math.ceil(wait / 1000)} s`);
        await sleep(wait);
        continue;
      }
      break;
    }

    turn.model = model;
    await acquireGemini();
    try {
      return await fn(model);
    } catch (err) {
      lastError = classifyError(err);
      if (!lastError.retryable || Date.now() - started >= budget) throw lastError;
      markDown(model);
      const next = pickModel(models);
      verbose(
        `Gemini ${model} falló (${lastError.kind}${lastError.status ? ` ${lastError.status}` : ''}); ` +
        (next ? `sigue con ${next}` : 'todos los modelos saturados'),
      );
    } finally {
      releaseGemini();
    }
  }

  throw lastError ?? new GeminiError('Gemini no respondió', {
    kind: 'server', retryable: true, hint: 'Falla temporal de Google (modelo saturado).',
  });
}

async function callGemini(model, systemPrompt, contents, tools) {
  return getClient().models.generateContent({
    model,
    contents,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.3,
      ...(tools?.declarations?.length ? { tools: [{ functionDeclarations: tools.declarations }] } : {}),
    },
  });
}

const TRANSCRIBE_PROMPT =
  'Transcribe literalmente esta nota de voz de un cliente de una tienda en Venezuela. ' +
  'Devuelve solo la transcripción en español, sin comillas ni comentarios. ' +
  'Si el audio está vacío o no se entiende, devuelve exactamente: [inaudible]';

/**
 * Transcribe una nota de voz con Gemini.
 * @param {{ mimeType: string, data: string }} audio  audio en base64 (WhatsApp usa audio/ogg; codecs=opus)
 * @returns {Promise<string|null>} texto transcrito, o null si no se entendió
 * @throws {GeminiError}
 */
export async function transcribeAudio({ mimeType, data }) {
  const turn = { model: config.gemini.model };
  const response = await withRetries((model) => getClient().models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mimeType.split(';')[0].trim() || 'audio/ogg', data } },
        { text: TRANSCRIBE_PROMPT },
      ],
    }],
    config: { temperature: 0 },
  }), turn);

  const text = (response.text || '').trim();
  return !text || text.includes('[inaudible]') ? null : text;
}

/**
 * Llama a Gemini con el System Prompt y el historial de la conversación.
 * Si se pasan herramientas, ejecuta las llamadas a funciones que pida el modelo hasta obtener el texto final.
 * Reintenta solo las fallas pasajeras; los errores de facturación, clave o modelo se lanzan de inmediato.
 * @param {string} systemPrompt
 * @param {{ role: 'user'|'model', content: string }[]} history  incluye el último mensaje del cliente
 * @param {{ declarations: object[], execute: (name: string, args: object) => Promise<object>,
 *           finalize?: (calls: { name: string, args: object, result: object }[]) => string|null }} [tools]
 *   finalize: si devuelve un texto, se usa como respuesta final sin una segunda llamada a Gemini.
 * @returns {Promise<{ text: string, escalate: boolean, model: string, toolCalls: { name: string, args: object, result: object }[] }>}
 * @throws {GeminiError}
 */
export async function generateBarbaraReply(systemPrompt, history, tools) {
  const contents = history.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
  const toolCalls = [];
  const turn = { model: config.gemini.model };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await withRetries((model) => callGemini(model, systemPrompt, contents, tools), turn);
    const calls = response.functionCalls ?? [];

    if (!calls.length || !tools) {
      const raw = (response.text || '').trim();
      if (!raw) {
        const reason = response.candidates?.[0]?.finishReason ?? 'desconocida';
        throw new GeminiError(`Gemini devolvió una respuesta vacía (finishReason: ${reason})`, {
          kind: 'empty', retryable: false, hint: 'Gemini devolvió una respuesta vacía.' });
      }
      return {
        text: raw.split(ESCALATION_TAG).join('').split(IGNORE_TAG).join('').replace(/\n{3,}/g, '\n\n').trim(),
        escalate: raw.includes(ESCALATION_TAG),
        ignore: raw.includes(IGNORE_TAG),
        model: turn.model,
        toolCalls,
      };
    }

    // Se reenvía el contenido del modelo tal cual (incluye las firmas de razonamiento que exige Gemini 3).
    contents.push(response.candidates[0].content);
    const responses = [];
    const roundCalls = [];
    for (const call of calls) {
      const result = await tools.execute(call.name, call.args ?? {});
      roundCalls.push({ name: call.name, args: call.args ?? {}, result });
      responses.push({ functionResponse: { id: call.id, name: call.name, response: result } });
    }
    toolCalls.push(...roundCalls);

    const finalText = tools.finalize?.(roundCalls);
    if (finalText) return { text: finalText, escalate: false, model: turn.model, toolCalls };

    contents.push({ role: 'user', parts: responses });
  }

  throw new GeminiError('Demasiadas llamadas a herramientas en un solo turno', {
    kind: 'unknown', retryable: false, hint: 'La IA entró en un ciclo de herramientas.' });
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Segunda pasada: valida precios, cálculos y tono del borrador antes de enviarlo.
 * Si el auditor falla o no responde JSON válido, se conserva el borrador original.
 * @param {{ mensaje_cliente: string, datos_bd: string, borrador_barbara: string }} payload
 * @returns {Promise<{ aprobado: boolean, motivo_fallo: string|null, mensaje_final: string, model?: string }>}
 */
export async function auditBarbaraReply(payload) {
  const borrador = String(payload.borrador_barbara || '').trim();
  if (!borrador) {
    return { aprobado: true, motivo_fallo: null, mensaje_final: borrador };
  }

  const userPayload = JSON.stringify({
    mensaje_cliente: String(payload.mensaje_cliente || ''),
    datos_bd: String(payload.datos_bd || ''),
    borrador_barbara: borrador,
  });

  const turn = { model: config.auditor.model || config.gemini.model };
  const response = await withRetries((model) => getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: userPayload }] }],
    config: {
      systemInstruction: AUDITOR_SYSTEM_PROMPT,
      temperature: 0,
      responseMimeType: 'application/json',
    },
  }), turn);

  const parsed = extractJsonObject(response.text);
  const mensaje = String(parsed?.mensaje_final ?? '').trim();
  if (!mensaje) {
    throw new GeminiError('El auditor no devolvió mensaje_final', {
      kind: 'empty', retryable: false, hint: 'Auditor sin mensaje_final usable.',
    });
  }

  const aprobado = parsed?.aprobado === true;
  return {
    aprobado,
    motivo_fallo: aprobado ? null : (parsed?.motivo_fallo ? String(parsed.motivo_fallo) : 'Rechazado por el auditor'),
    mensaje_final: mensaje,
    model: turn.model,
  };
}

const OPERATOR_DRAFT_PROMPT =
  'Eres Bárbara, vendedora de Abasto Los Cuchos en Venezuela. ' +
  'Redacta UN mensaje corto de WhatsApp para el cliente, en español de usted, tono humano y cercano. ' +
  'Usa solo datos_bd e instrucción_operador. No digas que eres IA ni bot. Solo el mensaje final, sin JSON.';

/**
 * Redacta el mensaje al cliente a partir de una instrucción del operador (edición / sin stock).
 * @param {{ instruccion: string, ticket: object, datos_bd?: string }} args
 */
export async function draftFromOperatorInstruction({ instruccion, ticket, datos_bd = '' }) {
  const payload = JSON.stringify({
    cliente: ticket?.clienteNombre || ticket?.clienteTelefono,
    borrador_previo: ticket?.borradorRespuesta || '',
    items: ticket?.items || [],
    instruccion_operador: instruccion,
    datos_bd,
  });
  const turn = { model: config.gemini.model };
  const response = await withRetries((model) => getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: payload }] }],
    config: { systemInstruction: OPERATOR_DRAFT_PROMPT, temperature: 0.4 },
  }), turn);
  const text = (response.text || '').trim();
  if (!text) {
    throw new GeminiError('No se pudo redactar el mensaje del operador', {
      kind: 'empty', retryable: false, hint: 'Gemini no devolvió texto para el ajuste del operador.',
    });
  }
  return text.replace(/\*\*(.+?)\*\*/g, '*$1*');
}
