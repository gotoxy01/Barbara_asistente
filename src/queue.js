/**
 * Cola de entrada por cliente.
 *
 * Contrato (el mismo que después puede implementar Redis/BullMQ):
 *   push(key, item) acumula los ítems de esa clave durante windowMs
 *   y, al cumplirse el silencio, llama onFlush(key, items) en orden.
 *   Un mismo key no tiene dos lotes a la vez: el siguiente espera al anterior.
 *
 * `enqueue` queda para tareas inmediatas (comandos del asesor) sin debounce.
 */

const lanes = new Map();

export function enqueue(key, task) {
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error(`[${key}]`, err));
  lanes.set(key, next);
  next.finally(() => { if (lanes.get(key) === next) lanes.delete(key); });
  return next;
}

/**
 * @param {{
 *   windowMs?: number,
 *   onFlush: (key: string, items: any[]) => Promise<void>|void,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   cancel?: (timer: any) => void,
 * }} options
 */
export function createInboundQueue({
  windowMs = 3500,
  onFlush,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof onFlush !== 'function') throw new Error('createInboundQueue requiere onFlush');
  const buffers = new Map();
  const tails = new Map();

  function runSerial(key, task) {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => console.error(`[cola ${key}]`, err));
    tails.set(key, next);
    next.finally(() => { if (tails.get(key) === next) tails.delete(key); });
    return next;
  }

  function flush(key) {
    const buf = buffers.get(key);
    if (!buf?.items.length) return Promise.resolve();
    const items = buf.items.splice(0, buf.items.length);
    buf.timer = null;
    if (!buf.items.length) buffers.delete(key);
    return runSerial(key, () => onFlush(key, items));
  }

  return {
    push(key, item) {
      let buf = buffers.get(key);
      if (!buf) {
        buf = { items: [], timer: null };
        buffers.set(key, buf);
      }
      buf.items.push(item);
      if (buf.timer) cancel(buf.timer);
      buf.timer = schedule(() => { flush(key); }, windowMs);
    },
    /** Dispara ya el lote pendiente. Útil en pruebas. */
    flushNow(key) {
      const buf = buffers.get(key);
      if (buf?.timer) {
        cancel(buf.timer);
        buf.timer = null;
      }
      return flush(key);
    },
    pending(key) {
      return buffers.get(key)?.items.length ?? 0;
    },
  };
}

/**
 * Redis/BullMQ si hay REDIS_URL. Si no, la cola en memoria de este proceso.
 * El objeto que devuelve siempre tiene push(key, item).
 */
export async function openInboundQueue(options) {
  const { config } = await import('./config.js');
  if (config.redisUrl) {
    const { startRedisInboundQueue } = await import('./queue/redisInbound.js');
    console.log('Cola de mensajes: Redis/BullMQ');
    return startRedisInboundQueue({ ...options, redisUrl: config.redisUrl });
  }
  console.log('Cola de mensajes: memoria de este proceso (defina REDIS_URL para Redis)');
  return createInboundQueue(options);
}
