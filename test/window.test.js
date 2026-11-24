import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWithinServiceWindow } from '../src/services/window.js';

const HOUR = 60 * 60 * 1000;

describe('ventana de 24 horas', () => {
  it('permite texto libre dentro de la ventana y lo niega al cumplirse', () => {
    const start = 1_700_000_000_000;
    assert.equal(isWithinServiceWindow(start, start + 24 * HOUR - 1, 24), true);
    assert.equal(isWithinServiceWindow(start, start + 24 * HOUR, 24), false);
    assert.equal(isWithinServiceWindow(start, start + 30 * HOUR, 24), false);
  });

  it('sin mensaje previo del cliente no hay ventana abierta', () => {
    assert.equal(isWithinServiceWindow(null, Date.now(), 24), false);
    assert.equal(isWithinServiceWindow(0, Date.now(), 24), false);
    assert.equal(isWithinServiceWindow(undefined, Date.now(), 24), false);
  });
});
