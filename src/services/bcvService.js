import { config } from '../config.js';

/**
 * @typedef {{ rate: number, date: string, source: string }} BcvRate
 */

let cache = { value: /** @type {BcvRate|null} */ (null), fetchedAt: 0 };

function formatDate(isoDate) {
  const d = isoDate ? new Date(isoDate) : new Date();
  return new Intl.DateTimeFormat('es-VE', { timeZone: config.timezone, dateStyle: 'short' }).format(d);
}

async function fetchRate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(config.bcv.apiUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = Number(data.promedio ?? data.venta ?? data.price);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`respuesta sin tasa válida: ${JSON.stringify(data).slice(0, 120)}`);
    return { rate, date: formatDate(data.fechaActualizacion), source: 'BCV' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tasa oficial BCV (Bs por USD). Orden: BCV_RATE manual en .env > API en línea (con caché) > última tasa conocida.
 * @returns {Promise<BcvRate|null>} null si no hay ninguna tasa disponible
 */
export async function getBcvRate() {
  if (config.bcv.manualRate > 0) {
    return { rate: config.bcv.manualRate, date: formatDate(), source: 'manual' };
  }

  const maxAge = config.bcv.refreshMinutes * 60 * 1000;
  if (cache.value && Date.now() - cache.fetchedAt < maxAge) return cache.value;

  // Con una tasa ya conocida no se hace esperar al cliente: se actualiza en segundo plano.
  if (cache.value) {
    refreshRate();
    return cache.value;
  }
  await refreshRate();
  return cache.value;
}

let inFlight = null;

function refreshRate() {
  if (!inFlight) {
    inFlight = fetchRate()
      .then((value) => { cache = { value, fetchedAt: Date.now() }; })
      .catch((err) => {
        console.error('No se pudo obtener la tasa BCV:', err.message);
        // Se conserva la última tasa conocida; se reintenta en 5 minutos.
        const maxAge = config.bcv.refreshMinutes * 60 * 1000;
        if (cache.value) cache.fetchedAt = Date.now() - maxAge + 5 * 60 * 1000;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** USD → Bs redondeado a 2 decimales. */
export function toBolivares(usd, rate) {
  return Math.round(usd * rate * 100) / 100;
}
