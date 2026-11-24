/** Ventana de atención de WhatsApp: texto libre solo dentro de las horas posteriores al último mensaje del cliente. */

export function isWithinServiceWindow(lastUserMessageAt, now = Date.now(), windowHours = 24) {
  const ts = Number(lastUserMessageAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const windowMs = Number(windowHours) * 3600 * 1000;
  if (!(windowMs > 0)) return false;
  return now - ts < windowMs;
}
