import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Misma idea que la cola en memoria: juntar mensajes de un wa_id y procesarlos
 * de a uno. Si REDIS_URL existe, BullMQ espera el silencio y un lock por número.
 */

const POP_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
redis.call('RENAME', KEYS[1], KEYS[2])
local items = redis.call('LRANGE', KEYS[2], 0, -1)
redis.call('DEL', KEYS[2])
return items
`;

export function bufferKey(prefix, waId) {
  return `${prefix}:buf:${waId}`;
}

export function lockKey(prefix, waId) {
  return `${prefix}:lock:${waId}`;
}

export async function takeBuffer(redis, key) {
  if (typeof redis.takeList === 'function') return redis.takeList(key);
  const taken = await redis.eval(POP_SCRIPT, 2, key, `${key}:taking`);
  return taken || [];
}

/**
 * Procesa el lote de un número. Si otro worker ya lo tiene, reprograma.
 * @returns {Promise<'done'|'requeued'|'empty'>}
 */
export async function runFlush({ redis, queue, prefix, key, onFlush, lockTtlMs = 120_000 }) {
  const lock = lockKey(prefix, key);
  const locked = await redis.set(lock, '1', 'PX', lockTtlMs, 'NX');
  if (locked !== 'OK') {
    await queue.add('flush', { key }, { delay: 400 });
    return 'requeued';
  }
  try {
    const raw = await takeBuffer(redis, bufferKey(prefix, key));
    const items = raw.map((entry) => JSON.parse(entry));
    if (!items.length) return 'empty';
    await onFlush(key, items);
    return 'done';
  } finally {
    await redis.del(lock);
  }
}

/** Reinicia la espera de 3,5 s cada vez que llega otro mensaje del mismo número. */
export async function armDebounce(queue, key, windowMs) {
  const jobId = `flush:${key}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting') await existing.remove();
  }
  await queue.add('flush', { key }, { delay: windowMs, jobId, removeOnComplete: true, removeOnFail: 50 });
}

/**
 * @param {{ windowMs: number, onFlush: Function, redisUrl: string, prefix?: string }} options
 */
export async function startRedisInboundQueue({ windowMs, onFlush, redisUrl, prefix = 'barbara' }) {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('barbara-inbound', { connection });
  const worker = new Worker('barbara-inbound', async (job) => {
    if (!job.data?.key) return;
    await runFlush({ redis: connection, queue, prefix, key: job.data.key, onFlush });
  }, { connection, concurrency: 8 });
  worker.on('failed', (job, err) => {
    console.error(`[cola redis ${job?.data?.key || '?'}]`, err.message);
  });

  return {
    async push(key, item) {
      await connection.rpush(bufferKey(prefix, key), JSON.stringify(item));
      await armDebounce(queue, key, windowMs);
    },
    async flushNow(key) {
      return runFlush({ redis: connection, queue, prefix, key, onFlush });
    },
    async pending(key) {
      return connection.llen(bufferKey(prefix, key));
    },
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
