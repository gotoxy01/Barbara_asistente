import { toBolivares } from './bcvService.js';

/**
 * Resultado de get_price / get_stock. El modelo copia estos números;
 * no vienen escritos en el prompt.
 */
export function buildPriceResult(product, rate = null) {
  if (!product || product.category === 'politica') {
    return { ok: false, error: 'Ese código no es un producto con precio.' };
  }
  const price = Number(product.price ?? product.precio);
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, error: 'El producto no tiene precio en la base.' };
  }
  const stock = product.stock == null ? null : Number(product.stock);
  const bs = rate ? toBolivares(price, rate) : null;
  return {
    ok: true,
    sku: product.sku,
    nombre: product.name || product.nombre,
    presentacion: product.presentation || product.presentacion || null,
    precio_usd: Number(price.toFixed(2)),
    precio_bs: bs,
    stock,
    activo: product.is_active !== false && product.isActive !== false,
    instruccion: 'Copie precio_usd y precio_bs tal cual. No los recalcule. Si stock es 0, no lo venda.',
  };
}

export function buildStockResult(product) {
  if (!product || product.category === 'politica') {
    return { ok: false, error: 'Ese código no es un producto de inventario.' };
  }
  const stock = product.stock == null ? null : Number(product.stock);
  return {
    ok: true,
    sku: product.sku,
    nombre: product.name || product.nombre,
    stock,
    activo: product.is_active !== false && product.isActive !== false,
    instruccion: stock == null
      ? 'La caja no registra unidades de este artículo. Si está activo, se puede ofrecer y el precio sale de get_price.'
      : (stock > 0 ? 'Hay existencias.' : 'Sin existencias: no lo venda.'),
  };
}

/** Línea de catálogo para el prompt: identidad, sin montos. */
export function formatCatalogLine(product) {
  const name = product.nombre || product.name;
  const presentation = product.presentacion || product.presentation || 'unidad';
  const sku = product.sku || 'sin-sku';
  return `- ${name} (${presentation}) sku=${sku}`;
}
