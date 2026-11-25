/** Tope de mensajes por cliente. La decisión es pura; Postgres guarda el bloqueo. */

export const FLOOD_WARNING = 'Recibimos muchos mensajes seguidos, en un momento le atendemos.';

export function collapseBurst(text) {
  const parts = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    if (kept.at(-1)?.toLowerCase() === part.toLowerCase()) continue;
    kept.push(part);
  }
  return kept.join('\n');
}

export function assessFlood({
  now,
  countMinute = 0,
  countDay = 0,
  limitPerMinute = 10,
  limitPerDay = 150,
  blockMs = 30 * 60 * 1000,
  blockedUntil = null,
  manual = false,
  warnedAt = null,
  notifiedAt = null,
  text = '',
  previousText = '',
  previousAt = 0,
  repeatMs = 30_000,
} = {}) {
  if (manual || (blockedUntil && now < blockedUntil)) {
    return { action: 'silence', reply: null, notify: false, persist: false };
  }
  const over = countMinute > limitPerMinute || countDay > limitPerDay;
  if (over) {
    const alreadyWarned = Boolean(warnedAt && now - warnedAt < blockMs);
    const alreadyNotified = Boolean(notifiedAt && now - notifiedAt < blockMs);
    return {
      action: alreadyWarned ? 'silence' : 'warn',
      reply: alreadyWarned ? null : FLOOD_WARNING,
      notify: !alreadyNotified,
      persist: true,
      blockedUntil: now + blockMs,
      warnedAt: alreadyWarned ? warnedAt : now,
      notifiedAt: alreadyNotified ? notifiedAt : now,
      reason: 'flood',
    };
  }
  const same = previousText
    && text
    && previousText.trim().toLowerCase() === String(text).trim().toLowerCase()
    && now - previousAt < repeatMs;
  if (same) return { action: 'ignore', reply: null, notify: false, persist: false };
  return { action: 'allow', reply: null, notify: false, persist: false };
}

/** Texto del panel mientras el número no puede escribir. */
export function blockNotice(block, now = Date.now()) {
  if (!block) return '';
  if (block.reason === 'manual' || !block.blockedUntil) return 'Número bloqueado a mano';
  if (Number(block.blockedUntil) <= now) return '';
  const when = new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(Number(block.blockedUntil)));
  return `Número bloqueado por exceso de mensajes hasta ${when}`;
}
