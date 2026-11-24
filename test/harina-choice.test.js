import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { greetingForNow } from '../src/services/aiService.js';
import { searchProducts } from '../src/services/catalogService.js';
import { auditorInventedScale } from '../src/services/chatService.js';
import {
  customerExplicitlyChose,
  isSoldByWeight,
  shouldOpenScaleTicket,
} from '../src/services/orderService.js';

const ASK = 'Quiero una harina, tienen?';

describe('quiero una harina, tienen?', () => {
  it('no elige ni pesa un paquete de 1 kg', async () => {
    const found = await searchProducts(ASK);
    assert.ok(found.products.length > 1, 'hay varias harinas');
    const juana = found.products.find((product) => /juana/i.test(product.nombre));
    assert.ok(juana);
    assert.equal(juana.presentacion, '1 kg');
    assert.equal(juana.stock ?? null, null);
    assert.equal(isSoldByWeight(juana), false);
    assert.equal(isSoldByWeight({ presentacion: 'por kilo' }), true);
    for (const product of found.products) {
      assert.equal(customerExplicitlyChose(product, ASK, found.products), false);
      assert.equal(shouldOpenScaleTicket(ASK, product, found.products), false);
    }
    assert.equal(customerExplicitlyChose(juana, 'quiero la harina juana', found.products), true);
    assert.equal(shouldOpenScaleTicket('quiero la harina juana', juana, found.products), false);
    const queso = { nombre: 'Queso Blanco Duro', marca: '', presentacion: 'por kilo' };
    assert.equal(shouldOpenScaleTicket('quiero queso blanco', queso, [queso]), true);
  });

  it('el auditor no convierte una lista de opciones en un pesaje', () => {
    const draft = 'Tenemos Harina PAN blanca, Harina PAN amarilla y Harina Juana. ¿Cuál desea y cuántas?';
    const corrected = 'Ahorita le estamos pesando la Harina de Maíz Juana.';
    assert.equal(auditorInventedScale(draft, corrected, []), true);
    assert.equal(auditorInventedScale(draft, draft, []), false);
  });

  it('a las 18:00 en Caracas saluda buenas noches', () => {
    assert.match(greetingForNow(new Date('2026-11-24T21:30:00Z')), /tardes/);
    assert.match(greetingForNow(new Date('2026-11-24T22:00:00Z')), /noches/);
  });
});
