import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import {
  BARBARA_PROMPT,
  BUSINESS_INFO,
  CATALOG_SECTION,
  ESCALATION_TAG,
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

function greetingForNow() {
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

/**
 * Ejecuta la llamada con reintentos. Si el modelo principal está saturado (503), demora demasiado
 * o limita por ráfaga, el siguiente intento usa de inmediato el modelo de respaldo en vez de esperar.
 * @param {(model: string) => Promise<any>} fn
 * @param {{ model: string }} turn  modelo activo del turno; queda en el de respaldo si hubo que cambiar
 */
async function withRetries(fn, turn) {
  const { fallbackModel } = config.gemini;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(turn.model);
    } catch (err) {
      const error = classifyError(err);
      if (!error.retryable || attempt >= config.gemini.maxRetries) throw error;
      if (fallbackModel && turn.model !== fallbackModel) {
        console.warn(`Gemini ${turn.model} falló (${error.kind}); usando el modelo de respaldo ${fallbackModel}`);
        turn.model = fallbackModel;
      } else {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
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
        text: raw.split(ESCALATION_TAG).join('').replace(/\n{3,}/g, '\n\n').trim(),
        escalate: raw.includes(ESCALATION_TAG),
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
