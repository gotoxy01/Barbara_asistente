import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    phone       TEXT PRIMARY KEY,
    name        TEXT,
    paused      INTEGER NOT NULL DEFAULT 0,
    paused_at   INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone, id);

  CREATE TABLE IF NOT EXISTS processed_events (
    wa_message_id TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL
  );

  -- status: abierto (armando el carrito) | boleta (boleta enviada, falta dirección) | recibido (con dirección)
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'abierto',
    items       TEXT NOT NULL DEFAULT '[]',
    address     TEXT,
    total_usd   REAL,
    total_bs    REAL,
    bcv_rate    REAL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone, status);
`);

function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// Pausa con fecha de fin (p. ej. 5 min cuando un asesor escribe a mano); NULL = usa BOT_PAUSE_HOURS.
addColumnIfMissing('chats', 'paused_until', 'INTEGER');
// El cliente pidió la boleta mientras había productos por pesar: se envía en cuanto llegue el precio.
addColumnIfMissing('orders', 'boleta_pendiente', 'INTEGER NOT NULL DEFAULT 0');

const stmts = {
  upsertChat: db.prepare(`
    INSERT INTO chats (phone, name, created_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, chats.name)
  `),
  getChat: db.prepare('SELECT * FROM chats WHERE phone = ?'),
  setPaused: db.prepare('UPDATE chats SET paused = ?, paused_at = ?, paused_until = ? WHERE phone = ?'),
  addMessage: db.prepare('INSERT INTO messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)'),
  lastModelAt: db.prepare(`SELECT MAX(created_at) AS t FROM messages WHERE phone = ? AND role = 'model'`),
  history: db.prepare(`
    SELECT role, content FROM (
      SELECT id, role, content FROM messages WHERE phone = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
  markProcessed: db.prepare('INSERT OR IGNORE INTO processed_events (wa_message_id, created_at) VALUES (?, ?)'),
  activeOrder: db.prepare(`SELECT * FROM orders WHERE phone = ? AND status IN ('abierto', 'boleta') ORDER BY id DESC LIMIT 1`),
  activeOrders: db.prepare(`SELECT * FROM orders WHERE status IN ('abierto', 'boleta') ORDER BY id DESC`),
  createOrder: db.prepare('INSERT INTO orders (phone, created_at, updated_at) VALUES (?, ?, ?)'),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  updateOrder: db.prepare(`
    UPDATE orders SET status = ?, items = ?, address = ?, total_usd = ?, total_bs = ?, bcv_rate = ?, boleta_pendiente = ?, updated_at = ?
    WHERE id = ?
  `),
};

export function upsertChat(phone, name) {
  stmts.upsertChat.run(phone, name || null, Date.now());
  return stmts.getChat.get(phone);
}

export function getChat(phone) {
  return stmts.getChat.get(phone);
}

/** @param {number|null} durationMs si se indica, la pausa termina sola a ese tiempo; si no, a las BOT_PAUSE_HOURS. */
export function pauseChat(phone, durationMs = null) {
  const now = Date.now();
  stmts.setPaused.run(1, now, durationMs ? now + durationMs : null, phone);
}

export function resumeChat(phone) {
  stmts.setPaused.run(0, null, null, phone);
}

export function addMessage(phone, role, content) {
  stmts.addMessage.run(phone, role, content, Date.now());
}

export function getHistory(phone, limit = config.historyLimit) {
  return stmts.history.all(phone, limit);
}

/** Momento (ms) de la última respuesta enviada al cliente, o null si nunca se le respondió. */
export function getLastModelMessageAt(phone) {
  return stmts.lastModelAt.get(phone)?.t ?? null;
}

function parseOrder(row) {
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

/** Pedido en curso del cliente (abierto o con boleta enviada), o null. */
export function getActiveOrder(phone) {
  return parseOrder(stmts.activeOrder.get(phone));
}

/** Pedidos en curso con productos que el encargado aún no ha pesado. */
export function getOrdersAwaitingWeight() {
  return stmts.activeOrders.all().map(parseOrder).filter((o) => o.items.some((i) => i.precio == null));
}

export function getOrCreateActiveOrder(phone) {
  const existing = getActiveOrder(phone);
  if (existing) return existing;
  const now = Date.now();
  const { lastInsertRowid } = stmts.createOrder.run(phone, now, now);
  return parseOrder(stmts.getOrder.get(lastInsertRowid));
}

export function saveOrder(order) {
  stmts.updateOrder.run(
    order.status, JSON.stringify(order.items), order.address ?? null,
    order.total_usd ?? null, order.total_bs ?? null, order.bcv_rate ?? null, order.boleta_pendiente ? 1 : 0, Date.now(), order.id,
  );
}

/** Devuelve true si el mensaje es nuevo; false si Meta lo está reenviando. */
export function markProcessed(waMessageId) {
  if (typeof waMessageId !== 'string' || !waMessageId) return true;
  return stmts.markProcessed.run(waMessageId, Date.now()).changes > 0;
}
