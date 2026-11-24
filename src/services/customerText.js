/** Separa lo que el cliente quiere comprar de saludos y comandos de la consola. */

export function linesOf(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isControlCommand(text) {
  const raw = String(text || '').trim();
  if (/^#\w+/.test(raw)) return true;
  const word = raw.replace(/^[^\p{L}#]+/u, '').replace(/[^\p{L}]+$/u, '');
  return /^(reanudar|pausar|salir|ayuda)$/i.test(word);
}

export function isBareGreeting(text) {
  const clean = String(text || '')
    .replace(/^[^\p{L}]+/u, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
  return clean.length > 0 && clean.length <= 40 && /^(hola+|ola|buenos dias|buenas tardes|buenas noches|buenas|buen dia|saludos|hey|epa|que tal|bendicion|hi|hello)$/.test(clean);
}

export function isOnlyGreetingOrControl(text) {
  const lines = linesOf(text);
  return lines.length > 0 && lines.every((line) => isControlCommand(line) || isBareGreeting(line));
}

/** Líneas del lote (o del historial) que sí hablan de un producto. */
export function substantiveLines(text) {
  return linesOf(text).filter((line) => !isControlCommand(line) && !isBareGreeting(line));
}

export function historyForModel(history) {
  return (history || []).filter((message) => message?.role !== 'user' || !isControlCommand(message.content));
}

const UNAVAILABLE_RE = /no (la |lo |los |las )?tenemos|no (est[aá] disponible|hay)|no disponible|agotad/i;

/** Si el modelo inventó un sku y por eso dijo que no hay, no se reenvía esa frase. */
export function replyIfInventedSku(reply, toolCalls = []) {
  const lookups = toolCalls.filter((call) => call.name === 'get_price' || call.name === 'get_stock');
  const failedUnknown = lookups.some((call) => call.result?.sku_desconocido);
  const found = toolCalls.some((call) => call.name === 'search_catalog' && call.result?.ok && call.result.productos?.length);
  if (!failedUnknown || found) return null;
  if (!UNAVAILABLE_RE.test(String(reply || ''))) return null;
  return 'Déjeme verificar ese producto en el inventario y le confirmo en un momento.';
}
