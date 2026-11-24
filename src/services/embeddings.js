import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

let client;

function ai() {
  if (!config.gemini.apiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

export function textHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** Lote máximo de batchEmbedContents y tope por debajo de las 100 RPM del plan gratis. */
export const EMBED_BATCH_SIZE = 100;
export const EMBED_RPM = 90;

export function embedPace(count, batchSize = EMBED_BATCH_SIZE, rpm = EMBED_RPM) {
  const batches = Math.max(1, Math.ceil(Math.max(count, 1) / batchSize));
  const gapMs = Math.ceil(60_000 / rpm);
  return { batches, gapMs, batchSize };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastBatchAt = 0;

async function throttle(gapMs, sleepFn) {
  const wait = lastBatchAt ? gapMs - (Date.now() - lastBatchAt) : 0;
  if (wait > 0) await sleepFn(wait);
  lastBatchAt = Date.now();
}

/**
 * Un lote contra :batchEmbedContents. Ante 429 espera y reintenta; no tumba el arranque.
 * @returns {Promise<(number[]|null)[]>}
 */
export async function requestBatchEmbeddings(texts, {
  fetchImpl = fetch,
  sleepFn = sleep,
  gapMs = embedPace(texts.length).gapMs,
  apiKey = config.gemini.apiKey,
  model = config.embedding.model,
  dimensions = config.embedding.dimensions,
  attempts = 5,
} = {}) {
  if (!texts.length) return [];
  if (!apiKey) return texts.map(() => null);
  await throttle(gapMs, sleepFn);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
  const body = {
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text: String(text) }] },
      outputDimensionality: dimensions,
    })),
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn(`Embeddings: falló la red (${err.message}). Sigo con el resto.`);
      return texts.map(() => null);
    }
    if (Number(response.status) === 429) {
      const header = Number(response.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : Math.min(2000 * (2 ** attempt), 60_000);
      console.warn(`Embeddings 429: espero ${Math.round(waitMs / 1000)} s y reintento el mismo lote (${texts.length}).`);
      await sleepFn(waitMs);
      continue;
    }
    if (Number(response.status) >= 400) {
      const detail = await response.text?.().catch(() => '') || '';
      console.warn(`Embeddings ${response.status}: ${detail.slice(0, 180)}`);
      return texts.map(() => null);
    }
    const data = await response.json();
    const rows = data.embeddings || [];
    return texts.map((_, index) => rows[index]?.values || null);
  }
  if (texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const left = await requestBatchEmbeddings(texts.slice(0, mid), { fetchImpl, sleepFn, gapMs, apiKey, model, dimensions, attempts });
    const right = await requestBatchEmbeddings(texts.slice(mid), { fetchImpl, sleepFn, gapMs, apiKey, model, dimensions, attempts });
    return [...left, ...right];
  }
  console.warn('Embeddings 429 persistente en un solo texto. Queda pendiente para el próximo arranque.');
  return [null];
}

export async function embedTexts(texts, options = {}) {
  if (!texts.length) return [];
  if (!options.apiKey && !config.gemini.apiKey && !options.fetchImpl) return texts.map(() => null);
  const { batchSize, gapMs } = embedPace(texts.length);
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const batch = Math.floor(i / batchSize) + 1;
    const total = Math.ceil(texts.length / batchSize);
    if (texts.length > batchSize) console.log(`Embeddings lote ${batch}/${total} (${slice.length} productos).`);
    const vectors = await requestBatchEmbeddings(slice, { ...options, gapMs });
    out.push(...vectors);
  }
  return out;
}

/** Un solo texto. Usa el mismo lote, por si el plan mide cada llamada. */
export async function embedText(text) {
  const model = ai();
  if (!model && !config.gemini.apiKey) return null;
  const [vector] = await embedTexts([text]);
  if (!vector?.length) return null;
  if (vector.length !== config.embedding.dimensions) {
    throw new Error(`El embedding devolvió ${vector.length} números y EMBEDDING_DIMENSIONS es ${config.embedding.dimensions}.`);
  }
  return vector;
}
