// Lee la caja (por defecto la de prueba) e informa cuántos productos entran.
// Si hay DATABASE_URL, los copia a Postgres sin pedir embeddings a Gemini.
// Uso: npm run sync
import path from 'node:path';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
dotenv.config({ path: path.join(root, '.env') });
process.env.CATALOG_SOURCE = 'db';
process.env.CATALOG_DB_PATH ||= path.join(root, 'data', 'caja-demo', 'database.db');

const { readSourceCatalog } = await import('../src/services/catalogService.js');

const started = performance.now();
const source = readSourceCatalog();
const readMs = Math.round(performance.now() - started);
const byCategory = {};
for (const product of source.products) {
  byCategory[product.categoria] = (byCategory[product.categoria] || 0) + 1;
}
const withStock = source.products.filter((product) => product.stock > 0).length;
const untracked = source.products.filter((product) => product.stock == null).length;
console.log(`Origen: ${source.label}`);
console.log(`Lectura de la caja: ${readMs} ms.`);
console.log(`Productos que entran: ${source.products.length} (con stock ${withStock}, sin cifra de stock ${untracked}).`);
console.log(`Por tabla/categoría: ${JSON.stringify(byCategory)}`);
console.log(`Delivery: ${source.deliveryUsd == null ? 'no está' : `$${source.deliveryUsd.toFixed(2)}`}`);

if (!process.env.DATABASE_URL) {
  console.log('No hay DATABASE_URL: no se copió a Postgres. La lectura de la caja ya quedó medida.');
  process.exit(0);
}

const { initDb, closeDb, upsertProduct, deactivateMissingSkus } = await import('../src/db.js');
await initDb();
const copyStarted = performance.now();
const rows = source.products.map((product) => ({
  sku: product.sku,
  name: product.nombre,
  category: product.categoria,
  presentation: product.presentacion,
  description: `${product.nombre} (${product.presentacion}). ${product.categoria}.`,
  technical_specs: { origen: source.label },
  price: product.precio,
  stock: product.stock ?? null,
  is_active: true,
}));
for (const row of rows) await upsertProduct(row);
await deactivateMissingSkus(rows.map((row) => row.sku));
const copyMs = Math.round(performance.now() - copyStarted);
await closeDb();
console.log(`Copia a Postgres: ${copyMs} ms, ${rows.length} productos. Los embeddings se actualizan al arrancar Bárbara.`);
