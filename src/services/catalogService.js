import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { toBolivares } from './bcvService.js';

/**
 * @typedef {{ nombre: string, presentacion: string, precio: number, categoria: string,
 *             nameTokens: string[], extraTokens: string[] }} Product
 */

export const BCV_NOTE =
  'Montos en Bs. calculados con la Tasa BCV del día. Métodos de pago: Pago Móvil, Transferencia en Bs. y Efectivo (USD o Bs.).';

// ---------------------------------------------------------------------------
// Normalización de texto
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(`
  a al algo algun alguna alguno ante aqui asi bien buen buena buenas bueno buenos cada como con cual cuales
  cuanto cuanta cuantos cuantas cuesta cuestan costo costos da dame dar de deme del dia dias disculpe donde
  el ella en es esa ese eso esta estan este esto favor gracias hay hola info informacion la las le les lo los
  me mas mi muy necesito necesitaria noches nos o otra otro para pero podria por porfa precio precios puede
  pueden que queria quiero quisiera saber se senor senora si sin sobre su sus tal tambien tardes te tendra
  tendran tenes tiene tienen tienes todo todos tu u un una uno unos unas usted ustedes vale valen vende
  venden vendes y ya buscando busco consulta pregunta cotizar cotizacion disponible disponibles
  nota voz transcrita
  kilo kilos kg medio gramos litro litros unidad unidades
`.split(/\s+/).filter(Boolean));

// Cada palabra de la consulta también se busca con sus sinónimos.
const SYNONYMS = {
  refresco: ['refresco', 'pepsi', 'coca', 'glup', 'fanta', 'frescolita', 'chinotto', 'gaseosa'],
  gaseosa: ['refresco', 'pepsi', 'coca', 'glup', 'fanta', 'frescolita', 'chinotto'],
  soda: ['refresco', 'gaseosa', 'gasificada'],
  bombillo: ['bombillo', 'foco', 'led'],
  foco: ['bombillo', 'foco', 'led'],
  destornillador: ['destornillador', 'desarmador'],
  desarmador: ['destornillador', 'desarmador'],
  detergente: ['detergente', 'jabon'],
  embutido: ['jamon', 'mortadela', 'salchicha', 'chorizo', 'pepperoni'],
  charcuteria: ['jamon', 'queso', 'mortadela', 'salchicha', 'chorizo', 'tocineta'],
};

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ.,/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stemming mínimo en español para que "quesos", "limones" o "tomates" coincidan con el singular. */
function stem(word) {
  let w = word;
  if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length >= 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function tokenize(text) {
  return normalize(text)
    .split(/[\s.,/]+/)
    .filter((t) => t.length >= 2)
    .map(stem);
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function strictMatch(queryToken, productToken) {
  return queryToken === productToken || (queryToken.length >= 4 && productToken.startsWith(queryToken));
}

function fuzzyMatch(queryToken, productToken) {
  return queryToken.length >= 5 && productToken.length >= 5 && levenshtein(queryToken, productToken) <= 1;
}

// ---------------------------------------------------------------------------
// Carga del catálogo
// ---------------------------------------------------------------------------

// Los artículos de delivery no se ofrecen como productos; "Delivery costo" se usa como tarifa (getDeliveryCost).
const IS_DELIVERY_RE = /\bdelivery\b/i;
const IS_BOTELLON_RE = /botell[oó]n/i;

export function isBotellon(product) {
  return IS_BOTELLON_RE.test(product.nombre);
}

export function productLabel(product) {
  return `${product.nombre} (${product.presentacion})`;
}

const PRESENTATION_RE =
  /\b(?:x\s?)?\d+(?:[.,]\d+)?\s?(?:kg|k|kilos?|grs?|g|mg|lts?|ltrs?|l|ml|cc|cm|oz|und|unds|unid|unidades|hojas|w)\b\.?|\bx\s?\d+\b/gi;

/** Separa la presentación ("900gr", "1KG", "x10") del nombre tal como viene en el sistema de caja. */
function splitPresentation(rawName, fallback) {
  const found = rawName.match(PRESENTATION_RE);
  if (!found) return { nombre: rawName, presentacion: fallback };
  const nombre = rawName.replace(PRESENTATION_RE, ' ').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  return { nombre: nombre || rawName, presentacion: found.map((s) => s.trim()).join(' ') };
}

function buildProduct({ nombre, presentacion, precio, categoria, marca = '' }) {
  return {
    nombre,
    presentacion: presentacion || 'unidad',
    precio: Number(precio),
    categoria,
    nameTokens: tokenize(`${nombre} ${marca}`),
    extraTokens: tokenize(`${categoria} ${presentacion}`),
  };
}

const DB_SOURCES = [
  { table: 'articulos', categoria: 'Víveres / Limpieza / Ferretería', fallback: 'unidad',
    sql: 'SELECT articulo AS nombre, precio FROM articulos WHERE precio > 0 AND (stock IS NULL OR stock > 0)' },
  { table: 'charcuteria_rapida', categoria: 'Charcutería', fallback: 'por kilo',
    sql: 'SELECT nombre, precio FROM charcuteria_rapida WHERE precio > 0' },
  { table: 'verduras_rapidas', categoria: 'Verduras y frutas', fallback: 'por kilo',
    sql: 'SELECT nombre, precio FROM verduras_rapidas WHERE precio > 0' },
  { table: 'limpieza_rapida', categoria: 'Limpieza a granel', fallback: 'a granel',
    sql: 'SELECT nombre, precio FROM limpieza_rapida WHERE precio > 0' },
  { table: 'mascotas_rapida', categoria: 'Mascotas', fallback: 'unidad',
    sql: 'SELECT nombre, precio FROM mascotas_rapida WHERE precio > 0' },
];

/** Lee el catálogo del sistema de caja (solo lectura). */
function loadFromDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));

    const products = [];
    const seen = new Set();
    let deliveryUsd = null;
    for (const src of DB_SOURCES) {
      if (!tables.has(src.table)) continue;
      for (const row of db.prepare(src.sql).all()) {
        const raw = String(row.nombre ?? '').replace(/\s+/g, ' ').trim();
        // Filas cuyo "nombre" es solo un código de barras no son útiles para el cliente.
        if (!raw || /^\d+$/.test(raw) || IS_DELIVERY_RE.test(raw)) continue;
        const key = `${src.table}|${raw.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const { nombre, presentacion } = src.table === 'articulos'
          ? splitPresentation(raw, src.fallback)
          : { nombre: raw, presentacion: src.fallback };

        products.push(buildProduct({ nombre, presentacion, precio: row.precio, categoria: src.categoria }));
      }
    }
    if (tables.has('articulos')) {
      const wanted = normalize(config.delivery.itemName);
      // Sin filtrar por stock: el delivery es un servicio y en la caja puede figurar con stock 0.
      const row = db.prepare("SELECT articulo AS nombre, precio FROM articulos WHERE precio > 0 AND articulo LIKE '%deliver%'").all()
        .find((r) => normalize(String(r.nombre ?? '').replace(/\s+/g, ' ').trim()) === wanted);
      if (row) deliveryUsd = Number(row.precio);
    }
    return { products, deliveryUsd };
  } finally {
    db.close();
  }
}

function loadFromJson(path) {
  const items = JSON.parse(fs.readFileSync(path, 'utf8'));
  const delivery = items.find((p) => p.nombre && normalize(p.nombre) === normalize(config.delivery.itemName));
  return {
    products: items
      .filter((p) => p.nombre && Number(p.precio) > 0 && !IS_DELIVERY_RE.test(p.nombre))
      .map((p) => buildProduct(p)),
    deliveryUsd: Number(delivery?.precio) > 0 ? Number(delivery.precio) : null,
  };
}

function resolveSource() {
  const { source, dbPath, jsonPath } = config.catalog;
  if (source === 'db') return { type: 'db', path: dbPath };
  if (source === 'json') return { type: 'json', path: jsonPath };
  return fs.existsSync(dbPath) ? { type: 'db', path: dbPath } : { type: 'json', path: jsonPath };
}

let cache = { products: [], deliveryUsd: null, loadedAt: 0, source: null };

/** Catálogo en memoria, releído de la fuente cada CATALOG_REFRESH_MINUTES. */
export function getProducts() {
  const maxAge = config.catalog.refreshMinutes * 60 * 1000;
  if (!cache.products.length || Date.now() - cache.loadedAt > maxAge) {
    const source = resolveSource();
    const { products, deliveryUsd } = source.type === 'db' ? loadFromDatabase(source.path) : loadFromJson(source.path);
    cache = { products, deliveryUsd, loadedAt: Date.now(), source };
  }
  return cache.products;
}

/**
 * Costo del delivery (uno por pedido) = precio del artículo "Delivery costo" del sistema de caja,
 * así se actualiza solo cuando cambian el precio en la caja. Si no existe, usa DELIVERY_FALLBACK_USD.
 */
export function getDeliveryCost() {
  getProducts();
  return cache.deliveryUsd ?? config.delivery.fallbackUsd;
}

export function getCatalogInfo() {
  const products = getProducts();
  return {
    count: products.length,
    source: `${cache.source.type}: ${cache.source.path}`,
    deliveryUsd: getDeliveryCost(),
    deliveryFromCatalog: cache.deliveryUsd != null,
  };
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

function queryTerms(userQuery, products) {
  return [...new Set(
    normalize(userQuery)
      .split(/[\s.,/]+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  )].map((word) => {
    const variants = [...new Set((SYNONYMS[word] ?? [word]).map(stem).concat(stem(word)))];
    // La tolerancia a errores de tipeo solo se usa si la palabra no existe tal cual en el catálogo;
    // así "jamon" no trae "jabon", pero "arina" sí encuentra "harina".
    const existsExactly = products.some((p) => variants.some((v) => p.nameTokens.some((t) => strictMatch(v, t))));
    const matcher = existsExactly ? strictMatch : (v, t) => strictMatch(v, t) || fuzzyMatch(v, t);
    return { word, variants, matcher };
  });
}

function scoreProduct(product, terms) {
  let nameHits = 0;
  let extraHits = 0;
  for (const term of terms) {
    const inName = term.variants.some((v) => product.nameTokens.some((t) => term.matcher(v, t)));
    if (inName) { nameHits++; continue; }
    if (term.variants.some((v) => product.extraTokens.some((t) => term.matcher(v, t)))) extraHits++;
  }
  // Coincidir solo en categoría/presentación no basta: debe coincidir algo del nombre o la marca.
  return nameHits === 0 ? 0 : nameHits + extraHits * 0.3;
}

/**
 * Formato exigido: "Nombre (Presentación): Bs. 65.70 (o $ 1.80 USD)".
 * Los Bs se calculan aquí (no en la IA) para que el monto siempre sea exacto.
 * @param {Product} p
 * @param {import('./bcvService.js').BcvRate|null} bcv
 */
function formatProduct(p, bcv) {
  const usd = `$ ${p.precio.toFixed(2)} USD`;
  if (!bcv) return `- ${p.nombre} (${p.presentacion}): ${usd}`;
  return `- ${p.nombre} (${p.presentacion}): Bs. ${toBolivares(p.precio, bcv.rate).toFixed(2)} (o ${usd})`;
}

function rateLine(bcv) {
  return bcv
    ? `TASA BCV DEL DÍA: Bs. ${bcv.rate.toFixed(2)} por USD (fecha: ${bcv.date}).`
    : 'TASA BCV: no disponible en este momento. Indique los precios en USD y que el monto en Bs. se calcula a la Tasa BCV del día al pagar.';
}

function rankProducts(query, products) {
  const terms = queryTerms(query, products);
  const ranked = terms.length
    ? products
        .map((p) => ({ p, score: scoreProduct(p, terms) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.p.nombre.length - b.p.nombre.length)
    : [];
  return { terms: terms.map((t) => t.word), ranked };
}

const nameHasTerm = (p, term) => term.variants.some((v) => p.nameTokens.some((t) => term.matcher(v, t)));
const nameIsTerm = (p, term) => p.nameTokens.every((t) => term.variants.some((v) => term.matcher(v, t)));

/**
 * Si el cliente pregunta por un producto genérico ("plátano", "tomate") y existe un producto que se llama
 * exactamente así, se prioriza ese y se descartan los derivados (pasta de tomate, ketchup, bocadillos...).
 * Con varios productos en un mismo mensaje, cada uno tiene su propio cupo y se reportan los que no existen.
 */
function matchQuery(query, products) {
  const max = config.catalog.maxResults;
  const terms = queryTerms(query, products);
  if (!terms.length) return { terms: [], matches: [], missing: [] };

  const ranked = products
    .map((p) => ({ p, score: scoreProduct(p, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.p.nombre.length - b.p.nombre.length);
  const byLength = (a, b) => a.nombre.length - b.nombre.length;

  const perTerm = terms.map((term) => {
    const hits = products.filter((p) => nameHasTerm(p, term)).sort(byLength);
    const exact = hits.filter((p) => nameIsTerm(p, term));
    return { term, exact, hits };
  });

  if (terms.length === 1) {
    const { exact, hits } = perTerm[0];
    const matches = exact.length
      ? [...exact, ...hits.filter((p) => !exact.includes(p)).slice(0, 3)]
      : ranked.slice(0, max).map((r) => r.p);
    return { terms: [terms[0].word], matches, missing: matches.length ? [] : [terms[0].word] };
  }

  // Palabras que forman juntas un mismo producto ("harina pan") se resuelven con el ranking normal.
  const combined = ranked.filter((r) => r.score >= 2).map((r) => r.p);
  const loose = perTerm.filter(({ term }) => !combined.some((p) => nameHasTerm(p, term)));
  const perTermLimit = Math.max(2, Math.floor(max / terms.length));
  const matches = loose.length
    ? [...new Set([
        ...combined.slice(0, max),
        ...loose.flatMap(({ exact, hits }) => (exact.length ? exact : hits.slice(0, perTermLimit))),
      ])]
    : ranked.slice(0, max).map((r) => r.p);
  const missing = loose.filter(({ hits }) => !hits.length).map(({ term }) => term.word);
  return { terms: terms.map((t) => t.word), matches, missing };
}

/**
 * Identifica UN producto a partir del nombre que usa la IA o el cliente (idealmente "Nombre (Presentación)").
 * @returns {{ product?: Product, options?: Product[] }} product si es inequívoco; options si hay varios candidatos
 */
export function findProduct(query) {
  const products = getProducts();
  const wanted = normalize(query);
  const exact = products.filter((p) => normalize(productLabel(p)) === wanted);
  const byName = exact.length ? exact : products.filter((p) => normalize(p.nombre) === wanted);
  if (byName.length === 1) return { product: byName[0] };
  if (byName.length > 1) return { options: byName.slice(0, 5) };

  const { ranked } = rankProducts(query, products);
  if (!ranked.length) return {};
  if (ranked.length === 1 || ranked[0].score > ranked[1].score) return { product: ranked[0].p };
  return { options: ranked.slice(0, 5).map((r) => r.p) };
}

/**
 * Busca en el catálogo los productos relacionados con uno o varios mensajes del cliente.
 * Con varios mensajes (p. ej. preguntas seguidas sin responder) agrupa los resultados por consulta.
 * @param {string|string[]} queries
 * @param {{ bcv?: import('./bcvService.js').BcvRate|null }} [options]
 * @returns {{ type: 'matches'|'none', terms: string[], products: Product[], text: string }}
 */
export function searchProducts(queries, { bcv = null } = {}) {
  const products = getProducts();
  const results = (Array.isArray(queries) ? queries : [queries])
    .filter((q) => q && q.trim())
    .map((q) => matchQuery(q, products))
    .filter((r) => r.terms.length);

  const terms = [...new Set(results.flatMap((r) => r.terms))];
  const found = results.filter((r) => r.matches.length);
  const missingWords = [...new Set(results.flatMap((r) => r.missing))];
  const lines = [rateLine(bcv)];

  if (found.length) {
    const shown = new Set();
    lines.push('PRODUCTOS ENCONTRADOS:');
    for (const r of found) {
      const fresh = r.matches.filter((p) => !shown.has(p));
      fresh.forEach((p) => shown.add(p));
      if (found.length > 1) lines.push(`Para "${r.terms.join(' ')}":`);
      lines.push(...fresh.map((p) => formatProduct(p, bcv)));
    }
    if (missingWords.length) {
      lines.push(
        `SIN COINCIDENCIAS EN EL CATÁLOGO: ${missingWords.map((w) => `"${w}"`).join(', ')}. ` +
        'Si alguna de estas palabras es un producto que el cliente pidió, NO lo tenemos disponible por ahora.',
      );
    }
    lines.push(BCV_NOTE);
    return { type: 'matches', terms, products: [...shown], text: lines.join('\n') };
  }

  lines.push(
    terms.length
      ? `PRODUCTOS ENCONTRADOS: Ninguno. (El producto no está en el catálogo). Búsqueda realizada: "${terms.join(' ')}".`
      : 'CONSULTA GENERAL (sin un producto específico): no menciones productos.',
  );
  return { type: 'none', terms, products: [], text: lines.join('\n') };
}
