import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeTotals } from '../src/services/orderService.js';

const bcv = { rate: 40, date: '24/11/2026' };

describe('totales de la boleta', () => {
  it('suma las líneas en código y cobra el delivery una sola vez', () => {
    const totals = computeTotals([
      { nombre: 'Harina', presentacion: '1 kg', precio: 2, cantidad: 3 },
    ], bcv);
    assert.equal(totals.lines.length, 1);
    assert.equal(totals.lines[0].usd, 6);
    assert.equal(totals.lines[0].bs, 240);
    assert.equal(totals.fees.length, 1);
    assert.equal(totals.fees[0].usd, 1.5);
    assert.equal(totals.fees[0].bs, 60);
    assert.equal(totals.totalUsd, 7.5);
    assert.equal(totals.totalBs, 300);
  });

  it('el retiro en tienda no suma delivery', () => {
    const totals = computeTotals([
      { nombre: 'Harina', presentacion: '1 kg', precio: 2, cantidad: 3 },
    ], bcv, { pickup: true });
    assert.equal(totals.totalUsd, 6);
    assert.equal(totals.totalBs, 240);
    assert.equal(totals.fees[0].usd, 0);
    assert.equal(totals.pickup, true);
  });

  it('deja fuera del total lo que todavía no se pesó', () => {
    const totals = computeTotals([
      { nombre: 'Queso', presentacion: 'por kilo', precio: 8, cantidad: 1 },
      { nombre: 'Tomate', detalle: 'tomate (2 unidades)', precio: null, cantidad: 1, pesable: true },
    ], bcv);
    assert.equal(totals.lines.length, 1);
    assert.deepEqual(totals.pending, ['tomate (2 unidades)']);
    assert.equal(totals.totalUsd, 9.5);
  });
});
