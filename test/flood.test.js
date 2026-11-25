import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessFlood, collapseBurst, FLOOD_WARNING } from '../src/services/floodControl.js';

const minute = 60_000;
const day = 86_400_000;

describe('anti-spam', () => {
  it('junta una ráfaga y deja pasar un mensaje normal', () => {
    assert.equal(collapseBurst('hola\nhola\n\narroz'), 'hola\narroz');
    const ok = assessFlood({ now: 1_000_000, countMinute: 2, countDay: 3, text: 'arroz' });
    assert.equal(ok.action, 'allow');
  });

  it('al pasar el tope avisa una vez, avisa al vendedor y después calla', () => {
    const now = 5_000_000;
    const first = assessFlood({ now, countMinute: 11, countDay: 11, limitPerMinute: 10, text: 'hola' });
    assert.equal(first.action, 'warn');
    assert.equal(first.reply, FLOOD_WARNING);
    assert.equal(first.notify, true);
    assert.equal(first.blockedUntil, now + 30 * minute);

    const again = assessFlood({
      now: now + 1000,
      countMinute: 12,
      countDay: 12,
      limitPerMinute: 10,
      blockedUntil: first.blockedUntil,
      warnedAt: first.warnedAt,
      notifiedAt: first.notifiedAt,
      text: 'hola otra vez',
    });
    assert.equal(again.action, 'silence');
    assert.equal(again.reply, null);
    assert.equal(again.notify, false);
  });

  it('ignora el mismo texto seguido y el bloqueo manual no llama al modelo', () => {
    const now = day;
    const same = assessFlood({
      now,
      countMinute: 2,
      countDay: 2,
      text: 'Harina PAN',
      previousText: 'harina pan',
      previousAt: now - 5000,
    });
    assert.equal(same.action, 'ignore');

    const manual = assessFlood({ now, manual: true, text: 'hola', countMinute: 1, countDay: 1 });
    assert.equal(manual.action, 'silence');
    assert.equal(manual.reply, null);
  });

  it('el tope del día también bloquea', () => {
    const hit = assessFlood({ now: day * 2, countMinute: 1, countDay: 151, limitPerDay: 150, text: 'azúcar' });
    assert.equal(hit.action, 'warn');
    assert.equal(hit.notify, true);
  });
});
