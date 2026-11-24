/**
 * Decide en código si el turno pasa a un especialista.
 * El modelo propone confianza y un motivo; estas reglas no se las deja solo a él.
 */

import { isGeneralCatalogAsk, isOnlyGreetingOrControl } from './customerText.js';

const HUMAN_RE = /hablar con (un |una )?(persona|asesor|humano|encargad)|asesor humano|persona real|quiero (un |una )?(asesor|persona|humano)|atenci[oó]n humana|comun[ií]queme con/i;
const COMPLAINT_RE = /\b(queja|reclamo|reclamaci[oó]n|estafa|p[eé]sim[oa]|indignad[oa]|muy molest[oa]|no sirve|me enga[nñ]|timaron)\b/i;
const WHOLESALE_RE = /\b(al mayor|al por mayor|por mayor|mayoreo|mayorista|cotizaci[oó]n especial)\b/i;
const QUOTE_RE = /\b(precio|cuesta|cu[aá]nto|cotiz|quiero|necesito|tienen|hay|vende[ns]?|compro|d[oó]lar|bol[ií]var)\b/i;
const PRICE_IN_REPLY_RE = /\$\s*\d|\bBs\.?\s*\d/i;

export const HANDOFF_REPLY =
  'Gracias por su mensaje. Un asesor de *Abasto Los Cuchos* revisará su caso y le responderá por aquí en breve.';

export function forcedHandoffReason(text) {
  const value = String(text || '');
  if (HUMAN_RE.test(value)) return 'El cliente pidió un asesor';
  if (COMPLAINT_RE.test(value)) return 'Queja o reclamo';
  if (WHOLESALE_RE.test(value)) return 'Cotización al mayor';
  return null;
}

/**
 * @param {{
 *   confianza?: number,
 *   requiereEspecialista?: boolean,
 *   motivoEscalado?: string|null,
 *   customerText?: string,
 *   catalogType?: string,
 *   catalogTerms?: string[],
 *   threshold?: number,
 *   cartCommitted?: boolean,
 * }} input
 */
export function decideEscalation(input = {}) {
  const threshold = Number(input.threshold ?? 85);
  const confianza = Number(input.confianza);
  const confianzaNum = Number.isFinite(confianza) ? confianza : 0;
  const motivo = input.motivoEscalado == null ? null : String(input.motivoEscalado);

  if (String(motivo || '').toLowerCase() === 'ajeno') {
    return { escalate: false, ignore: true, reason: null, confianza: confianzaNum };
  }
  if (input.cartCommitted) {
    return { escalate: false, ignore: false, reason: null, confianza: confianzaNum };
  }

  const text = String(input.customerText || '');
  const human = HUMAN_RE.test(text);
  const complaint = COMPLAINT_RE.test(text);
  const wholesale = WHOLESALE_RE.test(text);
  const general = isGeneralCatalogAsk(text) || input.generalCatalog === true;
  if ((isOnlyGreetingOrControl(text) || general) && !(human || complaint || wholesale)) {
    return { escalate: false, ignore: false, reason: null, confianza: confianzaNum };
  }
  const outOfCatalog = !general && input.catalogType === 'none'
    && Array.isArray(input.catalogTerms)
    && input.catalogTerms.length > 0
    && QUOTE_RE.test(text);
  const retrievalPct = input.retrievalScore == null ? null : Math.round(Number(input.retrievalScore) * 100);
  const retrievalLow = !general && retrievalPct != null
    && Array.isArray(input.catalogTerms)
    && input.catalogTerms.length > 0
    && retrievalPct <= threshold;
  const low = confianzaNum <= threshold || retrievalLow;
  const modelAsked = input.requiereEspecialista === true;

  if (!(human || complaint || wholesale || outOfCatalog || low || modelAsked)) {
    return { escalate: false, ignore: false, reason: null, confianza: confianzaNum };
  }

  const shown = retrievalLow && retrievalPct != null ? retrievalPct : confianzaNum;
  const reason = motivo
    || (human && 'El cliente pidió un asesor')
    || (complaint && 'Queja o reclamo')
    || (wholesale && 'Cotización al mayor')
    || (outOfCatalog && 'Consulta fuera de catálogo')
    || (retrievalLow && `La búsqueda del catálogo quedó en ${retrievalPct}%, por debajo del ${threshold}%`)
    || (low && `Confianza ${confianzaNum}% ≤ ${threshold}%`)
    || 'El modelo pidió especialista';

  return { escalate: true, ignore: false, reason, confianza: shown };
}

/** Al escalar, no se reenvía una cotización con montos. */
export function replyForEscalation(modelReply) {
  const text = String(modelReply || '').trim();
  if (text && !PRICE_IN_REPLY_RE.test(text)) return text;
  return HANDOFF_REPLY;
}
