import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPriceResult, buildStockResult, formatCatalogLine } from '../src/services/priceTools.js';

describe('precio y stock por herramienta', () => {
  it('devuelve el precio de la base y los bolívares con la tasa', () => {
    const result = buildPriceResult({
      sku: 'harina-pan-1-kg',
      name: 'Harina PAN',
      presentation: '1 kg',
      price: 1.8,
      stock: 12,
    }, 40);
    assert.equal(result.ok, true);
    assert.equal(result.precio_usd, 1.8);
    assert.equal(result.precio_bs, 72);
    assert.equal(result.stock, 12);
  });

  it('dice que no hay cuando el stock es cero', () => {
    const result = buildStockResult({ sku: 'x', name: 'Azúcar', stock: 0, category: 'víveres' });
    assert.equal(result.stock, 0);
    assert.match(result.instruccion, /no lo venda/i);
  });

  it('la línea del catálogo no incluye montos', () => {
    const line = formatCatalogLine({ nombre: 'Harina PAN', presentacion: '1 kg', sku: 'harina-pan-1-kg', precio: 9.5 });
    assert.match(line, /sku=harina-pan-1-kg/);
    assert.doesNotMatch(line, /\$|Bs\.|9\.5|USD/);
  });
});
