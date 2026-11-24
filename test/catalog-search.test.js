import './setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalize, searchProducts } from '../src/services/catalogService.js';
import { isControlCommand, replyIfInventedSku, substantiveLines } from '../src/services/customerText.js';
import { classifyError } from '../src/services/aiService.js';

describe('búsqueda de harina PAN', () => {
  it('encuentra P.A.N. aunque el lote traiga un saludo y un comando', async () => {
    assert.equal(normalize('P.A.N.'), 'pan');
    assert.equal(isControlCommand('#reanudar'), true);
    assert.equal(isControlCommand('reanudar'), true);
    const lines = substantiveLines('cuanto cuesta la harina pan\nHola\n#reanudar');
    assert.deepEqual(lines, ['cuanto cuesta la harina pan']);
    const found = await searchProducts(lines.join('\n'));
    const names = found.products.map((product) => product.nombre);
    assert.equal(found.type, 'matches');
    assert.ok(names.some((name) => /blanca/i.test(name) && /p\.a\.n/i.test(name)));
    assert.ok(names.some((name) => /amarilla/i.test(name) && /p\.a\.n/i.test(name)));
  });

  it('no dice que no hay cuando el sku fue inventado', () => {
    const reply = replyIfInventedSku('La harina pan no la tenemos disponible.', [
      { name: 'get_price', result: { ok: false, sku_desconocido: true } },
    ]);
    assert.match(reply, /verificando si lo tenemos en stock/i);
  });

  it('un 404 del modelo se puede reemplazar por el respaldo', () => {
    const error = classifyError({ status: 404, message: 'models/gemini-2.5-flash is not found' });
    assert.equal(error.retryable, true);
    assert.equal(error.kind, 'model');
  });
});
