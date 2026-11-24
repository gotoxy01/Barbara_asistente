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

/**
 * Embedding denso. La dimensión sale de EMBEDDING_DIMENSIONS.
 * @returns {Promise<number[] | null>}
 */
export async function embedText(text) {
  const model = ai();
  if (!model) return null;
  const response = await model.models.embedContent({
    model: config.embedding.model,
    contents: String(text),
    config: { outputDimensionality: config.embedding.dimensions },
  });
  const values = response.embeddings?.[0]?.values;
  if (!values?.length) return null;
  if (values.length !== config.embedding.dimensions) {
    throw new Error(`El embedding devolvió ${values.length} números y EMBEDDING_DIMENSIONS es ${config.embedding.dimensions}.`);
  }
  return values;
}

export async function embedTexts(texts) {
  const model = ai();
  if (!model || !texts.length) return texts.map(() => null);
  const response = await model.models.embedContent({
    model: config.embedding.model,
    contents: texts,
    config: { outputDimensionality: config.embedding.dimensions },
  });
  return (response.embeddings || []).map((item) => item?.values || null);
}
