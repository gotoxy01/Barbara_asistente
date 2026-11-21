import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { publishCrm } from './crm/events.js';

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

  -- status: abierto (armando el carrito) | boleta (boleta enviada, falta dirección) | recibido (con dirección) | cancelado (#b del asesor)
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
// Comanda de cocina/despacho tras cerrar el pedido: nuevo | preparado | atendido | cancelado.
addColumnIfMissing('orders', 'kitchen_status', "TEXT NOT NULL DEFAULT 'nuevo'");
// Oculto del tablero CRM (p. ej. cancelados que el encargado borró).
addColumnIfMissing('orders', 'board_hidden', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS advisor_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    phone       TEXT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_done ON advisor_alerts (done, id DESC);
`);

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
      SELECT id, role, content FROM messages
      WHERE phone = ? AND created_at >= ? AND content != '[sin respuesta]'
      ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
  latestByPhone: db.prepare(`
    SELECT m.phone, m.role, m.content, m.created_at
    FROM messages m
    JOIN (SELECT phone, MAX(id) AS id FROM messages WHERE created_at >= ? GROUP BY phone) t ON t.id = m.id
  `),
  latestMessage: db.prepare('SELECT role, content, created_at FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 1'),
  expireOrders: db.prepare(`
    UPDATE orders SET status = 'cancelado', boleta_pendiente = 0, updated_at = ?
    WHERE status IN ('abierto', 'boleta') AND updated_at < ?
  `),
  markProcessed: db.prepare('INSERT OR IGNORE INTO processed_events (wa_message_id, created_at) VALUES (?, ?)'),
  activeOrder: db.prepare(`SELECT * FROM orders WHERE phone = ? AND status IN ('abierto', 'boleta') ORDER BY id DESC LIMIT 1`),
  activeOrders: db.prepare(`SELECT * FROM orders WHERE status IN ('abierto', 'boleta') ORDER BY id DESC`),
  activeOrdersOf: db.prepare(`SELECT * FROM orders WHERE phone = ? AND status IN ('abierto', 'boleta') ORDER BY id DESC`),
  pendingOrders: db.prepare(`SELECT * FROM orders WHERE status IN ('abierto', 'boleta', 'recibido') AND items != '[]' AND updated_at >= ? ORDER BY id`),
  pendingOrdersOf: db.prepare(`SELECT * FROM orders WHERE phone = ? AND status IN ('abierto', 'boleta', 'recibido') ORDER BY id`),
  cancelOrder: db.prepare(`UPDATE orders SET status = 'cancelado', boleta_pendiente = 0, kitchen_status = 'cancelado', updated_at = ? WHERE id = ?`),
  createOrder: db.prepare('INSERT INTO orders (phone, created_at, updated_at) VALUES (?, ?, ?)'),
  getOrder: db.prepare('SELECT * FROM orders WHERE id = ?'),
  updateOrder: db.prepare(`
    UPDATE orders SET status = ?, items = ?, address = ?, total_usd = ?, total_bs = ?, bcv_rate = ?, boleta_pendiente = ?, kitchen_status = ?, updated_at = ?
    WHERE id = ?
  `),
  kitchenBoard: db.prepare(`
    SELECT * FROM orders
    WHERE status = 'recibido'
      AND kitchen_status IN ('nuevo', 'preparado')
      AND items != '[]'
      AND COALESCE(board_hidden, 0) = 0
      AND updated_at >= ?
    ORDER BY updated_at DESC
    LIMIT ?
  `),
  ordersLastHours: db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('recibido', 'cancelado')
      AND items != '[]'
      AND COALESCE(board_hidden, 0) = 0
      AND updated_at >= ?
    ORDER BY updated_at DESC
    LIMIT ?
  `),
  setKitchenStatus: db.prepare(`
    UPDATE orders SET kitchen_status = ?, updated_at = ? WHERE id = ? AND status = 'recibido'
  `),
  hideOrderFromBoard: db.prepare(`
    UPDATE orders SET board_hidden = 1, updated_at = ? WHERE id = ?
  `),
  hideFinishedOrder: db.prepare(`
    UPDATE orders SET board_hidden = 1, updated_at = ?
    WHERE id = ?
      AND (
        status = 'cancelado'
        OR kitchen_status IN ('cancelado', 'atendido')
      )
  `),
  listChats: db.prepare(`
    SELECT c.phone, c.name, c.paused, c.paused_until,
           m.content AS last_content, m.role AS last_role, m.created_at AS last_at
    FROM (
      SELECT phone, MAX(id) AS id FROM messages
      WHERE content != '[sin respuesta]' AND created_at >= ?
      GROUP BY phone
    ) t
    JOIN messages m ON m.id = t.id
    LEFT JOIN chats c ON c.phone = t.phone
    ORDER BY m.created_at DESC
    LIMIT ?
  `),
  chatMessages: db.prepare(`
    SELECT id, role, content, created_at FROM messages
    WHERE phone = ? AND content != '[sin respuesta]'
    ORDER BY id DESC LIMIT ?
  `),
  ordersToday: db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('abierto', 'boleta', 'recibido') AND items != '[]' AND updated_at >= ?
    ORDER BY updated_at DESC
  `),
  insertAlert: db.prepare(`
    INSERT INTO advisor_alerts (kind, phone, title, body, created_at, done) VALUES (?, ?, ?, ?, ?, 0)
  `),
  openAlerts: db.prepare(`
    SELECT * FROM advisor_alerts WHERE done = 0 ORDER BY id DESC LIMIT ?
  `),
  markAlertDone: db.prepare(`UPDATE advisor_alerts SET done = 1 WHERE id = ?`),
  markAlertsDoneByPhoneKind: db.prepare(`
    UPDATE advisor_alerts SET done = 1 WHERE phone = ? AND kind = ? AND done = 0
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
  const createdAt = Date.now();
  stmts.addMessage.run(phone, role, content, createdAt);
  if (content !== '[sin respuesta]') {
    publishCrm({ type: 'message', phone, role, content, createdAt });
  }
}

/** Chats con actividad reciente (buzón CRM: últimos 7 días). */
export function listRecentChats(limit = 80) {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  return stmts.listChats.all(since, limit).map((row) => ({
    phone: row.phone,
    name: row.name,
    paused: row.paused === 1,
    pausedUntil: row.paused_until,
    lastContent: row.last_content,
    lastRole: row.last_role,
    lastAt: row.last_at,
  }));
}

/** Historial del chat para el CRM (orden cronológico). */
export function getChatMessages(phone, limit = 80) {
  return stmts.chatMessages.all(phone, limit).reverse();
}

/** Pedidos tocados desde el inicio del día en Venezuela. */
export function getOrdersToday() {
  const start = startOfDayMs();
  return stmts.ordersToday.all(start).map(parseOrder);
}

function startOfDayMs() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Medianoche Caracas ≈ UTC-4.
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T04:00:00.000Z`);
}

/** Guarda una alerta para el buzón CRM y avisa por SSE. */
export function addAdvisorAlert({ kind, phone = null, title, body }) {
  const createdAt = Date.now();
  const { lastInsertRowid } = stmts.insertAlert.run(kind, phone, title, body, createdAt);
  const alert = { id: Number(lastInsertRowid), kind, phone, title, body, created_at: createdAt, done: 0 };
  publishCrm({ type: 'alert', alert });
  return alert;
}

export function listOpenAlerts(limit = 40) {
  return stmts.openAlerts.all(limit);
}

export function resolveAlert(id) {
  stmts.markAlertDone.run(id);
  publishCrm({ type: 'alert_done', id });
}

export function resolveAlertsByPhoneKind(phone, kind) {
  stmts.markAlertsDoneByPhoneKind.run(phone, kind);
  publishCrm({ type: 'alert_done', phone, kind });
}

function memoryCutoff() {
  return Date.now() - config.orderMemoryHours * 3600 * 1000;
}

/** Cancela los pedidos a medio armar o con boleta enviada que llevan más de ORDER_MEMORY_HOURS sin actividad. */
export function expireStaleOrders() {
  const cutoff = memoryCutoff();
  const { changes } = stmts.expireOrders.run(Date.now(), cutoff);
  if (changes) console.log(`Pedidos sin actividad por más de ${config.orderMemoryHours} h cancelados: ${changes}. Ya no entran en ninguna boleta.`);
  return cutoff;
}

export function getHistory(phone, limit = config.historyLimit) {
  return stmts.history.all(phone, memoryCutoff(), limit);
}

/** Último mensaje de cada chat dentro de la ventana (para retomar lo que quedó sin respuesta). */
export function listLatestMessagesSince(sinceMs) {
  return stmts.latestByPhone.all(sinceMs);
}

export function getLatestMessage(phone) {
  return stmts.latestMessage.get(phone) ?? null;
}

/** Momento (ms) de la última respuesta enviada al cliente, o null si nunca se le respondió. */
export function getLastModelMessageAt(phone) {
  return stmts.lastModelAt.get(phone)?.t ?? null;
}

function parseOrder(row) {
  return row ? { ...row, items: JSON.parse(row.items) } : null;
}

/** Pedido en curso del cliente (abierto o con boleta enviada, con actividad en las últimas ORDER_MEMORY_HOURS), o null. */
export function getActiveOrder(phone) {
  expireStaleOrders();
  return parseOrder(stmts.activeOrder.get(phone));
}

/** Pedidos en curso con productos que el encargado aún no ha pesado. */
export function getOrdersAwaitingWeight() {
  expireStaleOrders();
  return stmts.activeOrders.all().map(parseOrder).filter((o) => o.items.some((i) => i.precio == null));
}

/** Pedidos sin cerrar de todos los clientes (armando, con boleta o registrados esperando despacho). */
export function getPendingOrders() {
  const cutoff = expireStaleOrders();
  return stmts.pendingOrders.all(cutoff).map(parseOrder);
}

/** Cancela los pedidos sin cerrar del cliente y devuelve los que se cancelaron. */
export function cancelPendingOrders(phone) {
  const orders = stmts.pendingOrdersOf.all(phone).map(parseOrder);
  for (const o of orders) stmts.cancelOrder.run(Date.now(), o.id);
  return orders;
}

/**
 * Descarta carritos abiertos/boleta (ítems viejos, pesajes colgados) sin tocar comandas
 * ya recibidas en cocina. Útil al retomar chat o tras cancelar desde el negocio.
 */
export function clearActiveCarts(phone) {
  const orders = stmts.activeOrdersOf.all(phone).map(parseOrder);
  const now = Date.now();
  for (const o of orders) stmts.cancelOrder.run(now, o.id);
  return orders;
}

export function getOrCreateActiveOrder(phone) {
  const existing = getActiveOrder(phone);
  if (existing) return existing;
  const now = Date.now();
  const { lastInsertRowid } = stmts.createOrder.run(phone, now, now);
  return parseOrder(stmts.getOrder.get(lastInsertRowid));
}

/** Fuerza un carrito vacío nuevo (cancela abiertos/boleta previos de ese teléfono). */
export function startFreshActiveOrder(phone) {
  clearActiveCarts(phone);
  const now = Date.now();
  const { lastInsertRowid } = stmts.createOrder.run(phone, now, now);
  return parseOrder(stmts.getOrder.get(lastInsertRowid));
}

export function saveOrder(order) {
  const kitchen = order.kitchen_status
    || (order.status === 'recibido' ? 'nuevo' : 'nuevo');
  stmts.updateOrder.run(
    order.status, JSON.stringify(order.items), order.address ?? null,
    order.total_usd ?? null, order.total_bs ?? null, order.bcv_rate ?? null, order.boleta_pendiente ? 1 : 0,
    kitchen, Date.now(), order.id,
  );
}

const HOUR_MS = 3600 * 1000;

/** Pedidos cerrados pendientes de cocina/despacho (últimas 24 h). */
export function listKitchenOrders(limit = 40, withinHours = 24) {
  const since = Date.now() - withinHours * HOUR_MS;
  return stmts.kitchenBoard.all(since, limit).map(parseOrder);
}

/** Todos los pedidos recibidos de las últimas N horas (tablero + historial corto). */
export function listOrdersLastHours(withinHours = 24, limit = 50) {
  const since = Date.now() - withinHours * HOUR_MS;
  return stmts.ordersLastHours.all(since, limit).map(parseOrder);
}

/**
 * @param {number} orderId
 * @param {'nuevo'|'preparado'|'atendido'|'cancelado'} status
 */
export function setKitchenStatus(orderId, status) {
  const allowed = new Set(['nuevo', 'preparado', 'atendido', 'cancelado']);
  if (!allowed.has(status)) return null;
  const now = Date.now();
  const current = parseOrder(stmts.getOrder.get(orderId));
  if (!current) return null;

  if (status === 'cancelado') {
    // Cancelación completa: sigue visible en el tablero hasta que lo borren.
    stmts.cancelOrder.run(now, orderId);
  } else if (current.status === 'cancelado') {
    // Reabrir una cancelada: vuelve a "recibido" con el estado de cocina pedido.
    stmts.updateOrder.run(
      'recibido',
      JSON.stringify(current.items || []),
      current.address ?? null,
      current.total_usd ?? null,
      current.total_bs ?? null,
      current.bcv_rate ?? null,
      0,
      status,
      now,
      orderId,
    );
  } else {
    stmts.setKitchenStatus.run(status, now, orderId);
  }
  const order = parseOrder(stmts.getOrder.get(orderId));
  if (order) publishCrm({ type: 'kitchen', orderId: order.id, kitchenStatus: status, phone: order.phone });
  return order;
}

/** Quita del tablero un pedido ya hecho o cancelado (no borra el historial del chat). */
export function hideFinishedOrderFromBoard(orderId) {
  const order = parseOrder(stmts.getOrder.get(orderId));
  if (!order) return null;
  const done = order.kitchen_status === 'atendido'
    || order.kitchen_status === 'cancelado'
    || order.status === 'cancelado';
  if (!done) return null;
  stmts.hideFinishedOrder.run(Date.now(), orderId);
  const updated = parseOrder(stmts.getOrder.get(orderId));
  if (updated) publishCrm({ type: 'order_hidden', orderId: updated.id, phone: updated.phone });
  return updated;
}

/** @deprecated usar hideFinishedOrderFromBoard */
export function hideCanceledOrderFromBoard(orderId) {
  return hideFinishedOrderFromBoard(orderId);
}

export function getOrderById(id) {
  return parseOrder(stmts.getOrder.get(id));
}

/** Devuelve true si el mensaje es nuevo; false si Meta lo está reenviando. */
export function markProcessed(waMessageId) {
  if (typeof waMessageId !== 'string' || !waMessageId) return true;
  return stmts.markProcessed.run(waMessageId, Date.now()).changes > 0;
}
