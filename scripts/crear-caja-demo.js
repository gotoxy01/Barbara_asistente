// Crea data/caja-demo/database.db con el esquema que lee Bárbara.
// Uso: npm run caja:demo
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSeed } from '../data/caja-demo/semilla.js';
import { isDirectRun, projectRootFromScript } from './lib/script-path.js';

const root = projectRootFromScript(import.meta.url);
const dir = path.join(root, 'data', 'caja-demo');
const target = path.join(dir, 'database.db');

const SCHEMA = `
CREATE TABLE articulos (
  articulo TEXT NOT NULL,
  precio REAL NOT NULL,
  stock INTEGER,
  codigo TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE charcuteria_rapida (
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  codigo TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE verduras_rapidas (
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  codigo TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE limpieza_rapida (
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  codigo TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE mascotas_rapida (
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  codigo TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
`;

function insert(db, table, columns, rows) {
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const statement = db.prepare(sql);
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

export function createDemoDatabase(file = target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const seed = buildSeed();
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  insert(db, 'articulos', ['articulo', 'precio', 'stock', 'codigo', 'activo'], seed.articulos.map((item) => ({
    articulo: item.nombre, precio: item.precio, stock: item.stock, codigo: item.codigo, activo: item.activo,
  })));
  for (const [table, rows] of [
    ['charcuteria_rapida', seed.charcuteria],
    ['verduras_rapidas', seed.verduras],
    ['limpieza_rapida', seed.limpieza],
    ['mascotas_rapida', seed.mascotas],
  ]) {
    insert(db, table, ['nombre', 'precio', 'codigo', 'activo'], rows.map((item) => ({
      nombre: item.nombre, precio: item.precio, stock: item.stock, codigo: item.codigo, activo: item.activo,
    })));
  }
  db.close();
  return { file, seed };
}

const QUERIES = [
  `SELECT articulo AS nombre, precio, stock FROM articulos WHERE precio > 0 AND (stock IS NULL OR stock > 0)`,
  'SELECT nombre, precio FROM charcuteria_rapida WHERE precio > 0',
  'SELECT nombre, precio FROM verduras_rapidas WHERE precio > 0',
  'SELECT nombre, precio FROM limpieza_rapida WHERE precio > 0',
  'SELECT nombre, precio FROM mascotas_rapida WHERE precio > 0',
];

export function summarizeDatabase(file = target) {
  const started = performance.now();
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  const stored = {
    articulos: db.prepare('SELECT COUNT(*) AS n FROM articulos').get().n,
    charcuteria_rapida: db.prepare('SELECT COUNT(*) AS n FROM charcuteria_rapida').get().n,
    verduras_rapidas: db.prepare('SELECT COUNT(*) AS n FROM verduras_rapidas').get().n,
    limpieza_rapida: db.prepare('SELECT COUNT(*) AS n FROM limpieza_rapida').get().n,
    mascotas_rapida: db.prepare('SELECT COUNT(*) AS n FROM mascotas_rapida').get().n,
  };
  const stockCero = db.prepare('SELECT COUNT(*) AS n FROM articulos WHERE stock = 0').get().n;
  const sinPrecio = db.prepare('SELECT COUNT(*) AS n FROM articulos WHERE precio <= 0').get().n;
  const soloCodigo = db.prepare("SELECT COUNT(*) AS n FROM articulos WHERE articulo GLOB '[0-9]*' AND articulo NOT GLOB '*[^0-9]*'").get().n;
  const inactivos = db.prepare('SELECT COUNT(*) AS n FROM articulos WHERE activo = 0').get().n;
  const seen = new Set();
  let imported = 0;
  for (const sql of QUERIES) {
    const table = sql.includes('articulos') ? 'articulos' : sql.match(/FROM (\w+)/)[1];
    for (const row of db.prepare(sql).all()) {
      const name = String(row.nombre ?? '').replace(/\s+/g, ' ').trim();
      if (!name || /^\d+$/.test(name) || /\bdelivery\b/i.test(name)) continue;
      const key = `${table}|${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imported += 1;
    }
  }
  const delivery = db.prepare("SELECT precio FROM articulos WHERE precio > 0 AND articulo LIKE '%deliver%'").get();
  db.close();
  return {
    file,
    ms: Math.round(performance.now() - started),
    tables,
    stored,
    stockCero,
    sinPrecio,
    soloCodigo,
    inactivos,
    imported,
    deliveryUsd: delivery ? Number(delivery.precio) : null,
  };
}

if (isDirectRun(import.meta.url, import.meta.main)) {
  const started = performance.now();
  createDemoDatabase(target);
  const summary = summarizeDatabase(target);
  const ms = Math.round(performance.now() - started);
  console.log(`Caja de prueba: ${target}`);
  console.log(`Tiempo para crearla y leerla: ${ms} ms (lectura ${summary.ms} ms).`);
  console.log(`Tablas: ${summary.tables.join(', ')}`);
  console.log(`Filas guardadas: ${JSON.stringify(summary.stored)}`);
  console.log(`Las que Bárbara importaría (precio > 0, stock > 0, nombre útil): ${summary.imported}`);
  console.log(`Quedan fuera: stock 0 = ${summary.stockCero}, sin precio = ${summary.sinPrecio}, nombre solo código = ${summary.soloCodigo}, activo = 0 en artículos = ${summary.inactivos}.`);
  console.log(`Delivery costo: $${summary.deliveryUsd ?? 'no encontrado'}`);
  if (summary.imported < 400 || summary.imported > 600) {
    console.error(`Se esperaban entre 400 y 600 productos importables y hay ${summary.imported}.`);
    process.exit(1);
  }
}
