import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInboundQueue } from '../src/queue.js';

describe('debounce por cliente', () => {
  it('junta los mensajes seguidos del mismo número en un solo turno', async () => {
    const batches = [];
    const timers = [];
    const queue = createInboundQueue({
      windowMs: 3500,
      schedule(fn, ms) {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancel(timer) { timer.cancelled = true; },
      onFlush(_key, items) {
        batches.push(items.map((item) => item.id));
      },
    });

    queue.push('580411111111', { id: 'a' });
    queue.push('580411111111', { id: 'b' });
    const live = timers.filter((timer) => !timer.cancelled);
    assert.equal(live.length, 1);
    assert.equal(live[0].ms, 3500);
    live[0].fn();
    await Promise.resolve();
    assert.deepEqual(batches, [['a', 'b']]);
  });

  it('procesa en orden los turnos de un mismo chat y no bloquea a otro cliente', async () => {
    const events = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queue = createInboundQueue({
      windowMs: 3500,
      schedule(fn) { return fn; },
      cancel() {},
      async onFlush(key, items) {
        events.push(`start:${key}:${items[0]}`);
        if (key === 'uno') await gate;
        events.push(`end:${key}:${items[0]}`);
      },
    });

    queue.push('uno', 'a');
    const first = queue.flushNow('uno');
    queue.push('uno', 'b');
    const second = queue.flushNow('uno');
    queue.push('dos', 'c');
    const other = queue.flushNow('dos');

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['start:uno:a', 'start:dos:c', 'end:dos:c']);
    release();
    await Promise.all([first, second, other]);
    assert.deepEqual(events, [
      'start:uno:a',
      'start:dos:c',
      'end:dos:c',
      'end:uno:a',
      'start:uno:b',
      'end:uno:b',
    ]);
  });
});
