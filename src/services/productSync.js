import crypto from 'node:crypto';
import * as db from '../db.js';
import { config } from '../config.js';
import { readSourceCatalog, replaceProductCache } from './catalogService.js';
import { embedTexts, textHash } from './embeddings.js';

const POLICIES = [
  {
    sku: 'politica-horario',
    name: 'Horario de atención',
    category: 'politica',
    presentation: null,
    description: 'Abasto Los Cuchos atiende de 8:00 a 13:00 y de 15:00 a 21:00. De 13:00 a 15:00 no despacha.',
    price: 0,
    stock: null,
  },
  {
    sku: 'politica-pago',
    name: 'Formas de pago',
    category: 'politica',
    presentation: null,
    description: 'Se acepta pago móvil, transferencia en bolívares y efectivo. Los datos de pago móvil se entregan al cerrar el pedido, no durante la cotización.',
    price: 0,
    stock: null,
  },
  {
    sku: 'politica-entrega',
    name: 'Delivery y retiro',
    category: 'politica',
    presentation: null,
    description: 'Hay delivery en Lecumberry y retiro en tienda. El delivery se cobra una vez por pedido. Si la zona no tiene tarifa, se consulta el flete con el encargado.',
    price: 0,
    stock: null,
  },
];

function embedSource(product) {
  return [product.name, product.presentation, product.category, product.description].filter(Boolean).join('. ');
}

/**
 * Copia la caja (o el JSON de prueba) a products_kb y refresca los embeddings que cambiaron.
 */
export async function syncCatalog() {
  const source = readSourceCatalog();
  const rows = source.products.map((product) => ({
    sku: product.sku,
    name: product.nombre,
    category: product.categoria,
    presentation: product.presentacion,
    description: `${product.nombre} (${product.presentacion}). ${product.categoria}.`,
    technical_specs: { marca: product.marca || null, origen: source.label },
    price: product.precio,
    stock: product.stock ?? null,
    is_active: true,
  }));
  if (source.deliveryUsd != null) {
    rows.push({
      sku: 'servicio-delivery',
      name: 'Delivery',
      category: 'servicio',
      presentation: 'por pedido',
      description: 'Costo de delivery, una sola vez por pedido.',
      technical_specs: { origen: source.label },
      price: source.deliveryUsd,
      stock: null,
      is_active: true,
    });
  }
  rows.push(...POLICIES.map((policy) => ({ ...policy, technical_specs: { origen: 'negocio' }, is_active: true })));

  for (const row of rows) await db.upsertProduct(row);
  await db.deactivateMissingSkus(rows.map((row) => row.sku));

  const pending = [];
  for (const row of rows) {
    const hash = textHash(embedSource(row));
    const current = await db.productEmbedHash(row.sku);
    if (current !== hash) pending.push({ sku: row.sku, hash, text: embedSource(row) });
  }
  if (pending.length) {
    console.log(`Embeddings pendientes: ${pending.length} de ${rows.length} (el resto no cambió).`);
  }
  let vectors = [];
  try {
    vectors = await embedTexts(pending.map((item) => item.text));
  } catch (err) {
    console.warn('No se pudieron calcular embeddings. El arranque sigue; se reintentan los pendientes:', err.message);
  }
  for (let i = 0; i < pending.length; i += 1) {
    const vector = vectors[i];
    if (!vector || vector.length !== config.embedding.dimensions) continue;
    await db.saveProductEmbedding(pending[i].sku, vector, pending[i].hash);
  }

  const active = await db.listActiveProducts();
  replaceProductCache(active.filter((product) => product.category !== 'politica' && product.sku !== 'servicio-delivery'), {
    deliveryUsd: source.deliveryUsd,
    source: `postgres: products_kb (${source.label})`,
  });
  return { count: active.length, embedded: pending.length };
}

let timer = null;

export function startCatalogSync() {
  const run = () => syncCatalog().catch((err) => console.error('Sincronización de catálogo:', err.message));
  run();
  if (timer) return;
  timer = setInterval(run, config.catalog.refreshMinutes * 60 * 1000);
  timer.unref?.();
}
