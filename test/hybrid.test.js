import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankHybrid } from '../src/search/hybrid.js';

describe('búsqueda híbrida', () => {
  it('sube al producto que coincide en palabras y en el vector', () => {
    const ranked = rankHybrid(
      [
        { sku: 'harina', keyword: 4 },
        { sku: 'aceite', keyword: 1 },
      ],
      [
        { sku: 'harina', vector: 0.2 },
        { sku: 'aceite', vector: 0.99 },
      ],
      { keywordWeight: 0.5, vectorWeight: 0.5 },
    );
    assert.equal(ranked[0].sku, 'aceite');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('no descarta un resultado que solo apareció en el vector', () => {
    const ranked = rankHybrid(
      [{ sku: 'harina', keyword: 2 }],
      [{ sku: 'azucar', vector: 0.8 }],
      { keywordWeight: 0.4, vectorWeight: 0.6 },
    );
    assert.deepEqual(ranked.map((row) => row.sku).sort(), ['azucar', 'harina']);
  });
});
