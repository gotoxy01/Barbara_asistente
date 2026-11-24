import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { armDebounce, bufferKey, lockKey, runFlush } from '../src/queue/redisInbound.js';

function fakeRedis() {
  const lists = new Map();
  const locks = new Map();
  return {
    async set(key, _value, _mode, _ttl, nx) {
      if (nx === 'NX' && locks.has(key)) return null;
      locks.set(key, '1');
      return 'OK';
    },
    async del(key) {
      locks.delete(key);
      lists.delete(key);
    },
    async rpush(key, value) {
      const list = lists.get(key) || [];
      list.push(value);
      lists.set(key, list);
    },
    takeList(key) {
      const items = lists.get(key) || [];
      lists.delete(key);
      return [...items];
    },
  };
}

function fakeQueue() {
  const jobs = new Map();
  return {
    jobs,
    async getJob(id) {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        async getState() { return 'delayed'; },
        async remove() { jobs.delete(id); },
      };
    },
    async add(_name, data, opts) {
      jobs.set(opts.jobId || `auto-${jobs.size}`, { data, delay: opts.delay });
    },
  };
}

describe('cola Redis', () => {
  it('procesa el lote de un número y no deja otro worker entrar a la vez', async () => {
    const redis = fakeRedis();
    const queue = fakeQueue();
    const key = '580412000000';
    await redis.rpush(bufferKey('barbara', key), JSON.stringify({ id: 'a' }));
    await redis.rpush(bufferKey('barbara', key), JSON.stringify({ id: 'b' }));
    const seen = [];
    const first = await runFlush({
      redis,
      queue,
      prefix: 'barbara',
      key,
      onFlush: async (_key, items) => { seen.push(items.map((item) => item.id)); },
    });
    assert.equal(first, 'done');
    assert.deepEqual(seen, [['a', 'b']]);

    await redis.set(lockKey('barbara', key), '1', 'PX', 1000, 'NX');
    await redis.rpush(bufferKey('barbara', key), JSON.stringify({ id: 'c' }));
    const second = await runFlush({
      redis, queue, prefix: 'barbara', key, onFlush: async () => { seen.push(['no']); },
    });
    assert.equal(second, 'requeued');
    assert.deepEqual(seen, [['a', 'b']]);
  });

  it('reinicia la espera si llega otro mensaje del mismo número', async () => {
    const queue = fakeQueue();
    await armDebounce(queue, '580400000000', 3500);
    await armDebounce(queue, '580400000000', 3500);
    assert.equal(queue.jobs.size, 1);
    assert.equal(queue.jobs.get('flush:580400000000').delay, 3500);
  });
});
