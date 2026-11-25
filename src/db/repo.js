import { config } from '../config.js';
import { publishCrm } from '../crm/events.js';
import { runMigrations } from './migrate.js';
import { closePool, openPool, query, withTransaction } from './pool.js';
import { isProtectedFromExpiry, legacyStatus, lifecycleFromLegacy, mergeLifecycle } from '../services/orderLifecycle.js';

export const PROCESSED_TTL_MS = 24 * 60 * 60 * 1000;

const ms = (column) => `(EXTRACT(EPOCH FROM ${column}) * 1000)::bigint`;

function num(value) {
  return value == null ? null : Number(value);
}

function parseItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value);
  return [];
}

function parseOrder(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    items: parseItems(row.items),
    total_usd: num(row.total_usd),
    total_bs: num(row.total_bs),
    bcv_rate: num(row.bcv_rate),
    boleta_pendiente: Number(row.boleta_pendiente) || 0,
    board_hidden: Number(row.board_hidden) || 0,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

const ORDER_COLUMNS = `
  id, phone, status, lifecycle, items, address, total_usd, total_bs, bcv_rate,
  boleta_pendiente, kitchen_status, board_hidden,
  payment_reference, payment_media_id, payment_note, fulfillment,
  location_lat, location_lng, location_label, stock_deducted,
  ${ms('created_at')} AS created_at,
  ${ms('updated_at')} AS updated_at
`;

function roleOf(senderType) {
  return senderType === 'USER' ? 'user' : 'model';
}

function senderOf(role) {
  return role === 'user' ? 'USER' : 'BOT';
}

export async function initDb() {
  const pool = await openPool();
  try {
    await runMigrations(pool, config.embedding.dimensions);
  } catch (err) {
    await closePool();
    throw err;
  }
  return pool;
}

export async function closeDb() {
  await closePool();
}

async function ensureContact(phone, name) {
  const { rows } = await query(`
    INSERT INTO contacts (wa_id, full_name)
    VALUES ($1, $2)
    ON CONFLICT (wa_id) DO UPDATE SET
      full_name = COALESCE(EXCLUDED.full_name, contacts.full_name),
      updated_at = NOW()
    RETURNING id, wa_id, full_name
  `, [phone, name || null]);
  return rows[0];
}

async function openConversation(contactId) {
  const found = await query(`
    SELECT id FROM conversations
    WHERE contact_id = $1 AND status <> 'CLOSED'
    ORDER BY updated_at DESC
    LIMIT 1
  `, [contactId]);
  if (found.rows[0]) return found.rows[0].id;
  const created = await query(`
    INSERT INTO conversations (contact_id, status)
    VALUES ($1, 'BOT')
    RETURNING id
  `, [contactId]);
  return created.rows[0].id;
}

const CHAT_SQL = `
  SELECT c.wa_id AS phone,
         c.full_name AS name,
         CASE WHEN conv.paused THEN 1 ELSE 0 END AS paused,
         ${ms('conv.paused_at')} AS paused_at,
         ${ms('conv.paused_until')} AS paused_until,
         conv.status,
         ${ms('conv.last_user_message_at')} AS last_user_message_at,
         ${ms('conv.created_at')} AS created_at
  FROM contacts c
  JOIN conversations conv ON conv.contact_id = c.id
  WHERE c.wa_id = $1 AND conv.status <> 'CLOSED'
  ORDER BY conv.updated_at DESC
  LIMIT 1
`;

export async function upsertChat(phone, name) {
  const contact = await ensureContact(phone, name);
  await openConversation(contact.id);
  return getChat(phone);
}

export async function getChat(phone) {
  const { rows } = await query(CHAT_SQL, [phone]);
  return rows[0] || null;
}

async function conversationFor(phone) {
  const { rows } = await query(`
    SELECT conv.id, c.id AS contact_id
    FROM contacts c
    JOIN conversations conv ON conv.contact_id = c.id
    WHERE c.wa_id = $1 AND conv.status <> 'CLOSED'
    ORDER BY conv.updated_at DESC
    LIMIT 1
  `, [phone]);
  return rows[0] || null;
}

export async function pauseChat(phone, durationMs = null) {
  const now = Date.now();
  const until = durationMs ? now + durationMs : null;
  await query(`
    UPDATE conversations conv SET
      paused = TRUE,
      paused_at = to_timestamp($2 / 1000.0),
      paused_until = CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3 / 1000.0) END,
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone, now, until]);
}

export async function resumeChat(phone) {
  await query(`
    UPDATE conversations conv SET
      status = 'BOT',
      paused = FALSE,
      paused_at = NULL,
      paused_until = NULL,
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone]);
}

export async function setSpecialist(phone, reason = null) {
  const now = Date.now();
  await query(`
    UPDATE conversations conv SET
      status = 'SPECIALIST',
      paused = TRUE,
      paused_at = to_timestamp($2 / 1000.0),
      paused_until = NULL,
      handoff_reason = COALESCE($3, conv.handoff_reason),
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone, now, reason]);
}

export async function touchCustomerWindow(phone, now = Date.now()) {
  await query(`
    UPDATE conversations conv SET
      last_user_message_at = to_timestamp($2 / 1000.0),
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone, now]);
}

export async function addMessage(phone, role, content, wamid = null, extra = {}) {
  const id = typeof wamid === 'string' && wamid.trim() ? wamid.trim() : null;
  if (id && await hasInbound(id)) return false;
  let conv = await conversationFor(phone);
  if (!conv) {
    await upsertChat(phone, null);
    conv = await conversationFor(phone);
  }
  const createdAt = Date.now();
  const inserted = await query(`
    INSERT INTO messages (wamid, conversation_id, sender_type, content, confidence_score, raw_payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, to_timestamp($7 / 1000.0))
    ON CONFLICT (wamid) DO NOTHING
    RETURNING seq
  `, [
    id,
    conv.id,
    senderOf(role),
    content,
    extra.confidence ?? null,
    extra.raw ? JSON.stringify(extra.raw) : null,
    createdAt,
  ]);
  if (id && !inserted.rowCount) return false;
  if (content !== '[sin respuesta]') {
    publishCrm({ type: 'message', phone, role, content, createdAt });
  }
  return true;
}

export async function hasInbound(wamid) {
  if (typeof wamid !== 'string' || !wamid.trim()) return false;
  const { rows } = await query(
    `SELECT 1 FROM messages WHERE wamid = $1 AND sender_type = 'USER' LIMIT 1`,
    [wamid.trim()],
  );
  return Boolean(rows[0]);
}

export async function getHistory(phone, limit = config.historyLimit, hours = config.orderMemoryHours) {
  const since = Date.now() - Number(hours) * 3600 * 1000;
  const { rows } = await query(`
    SELECT sender_type, content FROM (
      SELECT m.sender_type, m.content, m.created_at, m.seq
      FROM messages m
      JOIN conversations conv ON conv.id = m.conversation_id
      JOIN contacts c ON c.id = conv.contact_id
      WHERE c.wa_id = $1
        AND m.created_at >= to_timestamp($2 / 1000.0)
        AND m.content <> '[sin respuesta]'
        AND COALESCE(m.raw_payload->>'durante_pausa', '') <> 'si'
      ORDER BY m.created_at DESC, m.seq DESC
      LIMIT $3
    ) recent
    ORDER BY created_at ASC, seq ASC
  `, [phone, since, limit]);
  return rows.map((row) => ({ role: roleOf(row.sender_type), content: row.content }));
}

/** Borra el hilo de prueba (mensajes) y deja el chat en BOT, sin carrito abierto. */
export async function clearCustomerThread(phone) {
  const deleted = await query(`
    DELETE FROM messages
    WHERE conversation_id IN (
      SELECT conv.id
      FROM conversations conv
      JOIN contacts c ON c.id = conv.contact_id
      WHERE c.wa_id = $1
    )
  `, [phone]);
  await query(`
    UPDATE conversations conv SET
      status = 'BOT',
      paused = FALSE,
      paused_at = NULL,
      paused_until = NULL,
      handoff_reason = NULL,
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone]);
  await clearActiveCarts(phone);
  return deleted.rowCount ?? 0;
}

export async function listLatestMessagesSince(sinceMs) {
  const { rows } = await query(`
    SELECT DISTINCT ON (c.wa_id)
      c.wa_id AS phone,
      m.sender_type,
      m.content,
      ${ms('m.created_at')} AS created_at
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE m.created_at >= to_timestamp($1 / 1000.0)
      AND COALESCE(m.raw_payload->>'durante_pausa', '') <> 'si'
    ORDER BY c.wa_id, m.created_at DESC, m.seq DESC
  `, [sinceMs]);
  return rows.map((row) => ({
    phone: row.phone,
    role: roleOf(row.sender_type),
    content: row.content,
    created_at: Number(row.created_at),
  }));
}

export async function getLatestMessage(phone) {
  const { rows } = await query(`
    SELECT m.sender_type, m.content, ${ms('m.created_at')} AS created_at
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1
      AND COALESCE(m.raw_payload->>'durante_pausa', '') <> 'si'
    ORDER BY m.created_at DESC, m.seq DESC
    LIMIT 1
  `, [phone]);
  if (!rows[0]) return null;
  return { role: roleOf(rows[0].sender_type), content: rows[0].content, created_at: Number(rows[0].created_at) };
}

export async function getLastModelMessageAt(phone) {
  const { rows } = await query(`
    SELECT ${ms('MAX(m.created_at)')} AS t
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1 AND m.sender_type IN ('BOT', 'SPECIALIST')
  `, [phone]);
  return rows[0]?.t == null ? null : Number(rows[0].t);
}

export async function listRecentChats(limit = 80) {
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const { rows } = await query(`
    SELECT c.wa_id AS phone, c.full_name AS name,
           CASE WHEN conv.paused THEN 1 ELSE 0 END AS paused,
           ${ms('conv.paused_until')} AS paused_until,
           m.content AS last_content,
           m.sender_type AS last_sender,
           ${ms('m.created_at')} AS last_at
    FROM (
      SELECT DISTINCT ON (conversation_id) conversation_id, content, sender_type, created_at
      FROM messages
      WHERE content <> '[sin respuesta]' AND created_at >= to_timestamp($1 / 1000.0)
      ORDER BY conversation_id, created_at DESC, seq DESC
    ) m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [since, limit]);
  return rows.map((row) => ({
    phone: row.phone,
    name: row.name,
    paused: row.paused === 1,
    pausedUntil: row.paused_until == null ? null : Number(row.paused_until),
    lastContent: row.last_content,
    lastRole: roleOf(row.last_sender),
    lastAt: Number(row.last_at),
  }));
}

export async function getChatMessages(phone, limit = 80) {
  const { rows } = await query(`
    SELECT m.seq AS id, m.sender_type, m.content, ${ms('m.created_at')} AS created_at
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1 AND m.content <> '[sin respuesta]'
    ORDER BY m.created_at DESC, m.seq DESC
    LIMIT $2
  `, [phone, limit]);
  return rows.reverse().map((row) => ({
    id: Number(row.id),
    role: roleOf(row.sender_type),
    content: row.content,
    created_at: Number(row.created_at),
  }));
}

function memoryCutoff() {
  return Date.now() - config.orderMemoryHours * 3600 * 1000;
}

export async function expireStaleOrders() {
  const cutoff = memoryCutoff();
  const { rows } = await query(`
    WITH old AS (
      SELECT id, phone, lifecycle
      FROM orders
      WHERE status IN ('abierto', 'boleta')
        AND lifecycle IN ('borrador', 'boleta_enviada')
        AND payment_reference IS NULL
        AND payment_media_id IS NULL
        AND updated_at < to_timestamp($1 / 1000.0)
    )
    UPDATE orders SET
      status = 'cancelado',
      lifecycle = 'cancelado',
      boleta_pendiente = 0,
      updated_at = NOW()
    FROM old
    WHERE orders.id = old.id
    RETURNING orders.id, old.phone, old.lifecycle
  `, [cutoff]);
  for (const row of rows) {
    await query(`
      INSERT INTO order_events (order_id, wa_id, from_state, to_state, actor, detail)
      VALUES ($1, $2, $3, 'cancelado', 'sistema', '{"tipo":"vencido"}'::jsonb)
    `, [row.id, row.phone, row.lifecycle]);
  }
  if (rows.length) {
    console.log(`Pedidos sin pago y sin actividad por más de ${config.orderMemoryHours} h cancelados: ${rows.length}.`);
  }
  return cutoff;
}

async function ordersWhere(sql, params) {
  const { rows } = await query(`SELECT ${ORDER_COLUMNS} FROM orders ${sql}`, params);
  return rows.map(parseOrder);
}

export async function getActiveOrder(phone) {
  await expireStaleOrders();
  const rows = await ordersWhere(
    `WHERE phone = $1 AND status IN ('abierto', 'boleta') ORDER BY id DESC LIMIT 1`,
    [phone],
  );
  return rows[0] || null;
}

export async function getOrdersAwaitingWeight() {
  await expireStaleOrders();
  const rows = await ordersWhere(`WHERE status IN ('abierto', 'boleta') ORDER BY id DESC`, []);
  return rows.filter((order) => order.items.some((item) => item.precio == null));
}

export async function getPendingOrders() {
  const cutoff = await expireStaleOrders();
  return ordersWhere(
    `WHERE items <> '[]'::jsonb
       AND lifecycle <> 'cancelado'
       AND (
         lifecycle IN ('pago_reportado', 'pago_verificado', 'en_logistica')
         OR (status IN ('abierto', 'boleta', 'recibido') AND updated_at >= to_timestamp($1 / 1000.0))
       )
     ORDER BY id`,
    [cutoff],
  );
}

export async function cancelPendingOrders(phone) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);
    const { rows } = await client.query(`
      SELECT id, phone, lifecycle, items, stock_deducted
      FROM orders
      WHERE phone = $1 AND lifecycle NOT IN ('cancelado', 'entregado')
      ORDER BY id
      FOR UPDATE
    `, [phone]);
    for (const row of rows) {
      if (row.stock_deducted) {
        await client.query(`
          INSERT INTO stock_ledger (order_id, action, lines)
          VALUES ($1, 'restore', $2::jsonb)
          ON CONFLICT (order_id, action) DO NOTHING
        `, [row.id, JSON.stringify(row.items || [])]);
      }
      await client.query(`
        UPDATE orders SET
          status = 'cancelado', lifecycle = 'cancelado', boleta_pendiente = 0,
          kitchen_status = 'cancelado', stock_deducted = FALSE, updated_at = NOW()
        WHERE id = $1
      `, [row.id]);
      await client.query(`
        INSERT INTO order_events (order_id, wa_id, from_state, to_state, actor, detail)
        VALUES ($1, $2, $3, 'cancelado', 'barbara', '{"tipo":"cancelado"}'::jsonb)
      `, [row.id, row.phone, row.lifecycle]);
    }
    return rows.map((row) => ({ id: Number(row.id), phone: row.phone, status: 'cancelado', items: row.items || [] }));
  });
}

export async function clearActiveCarts(phone) {
  const orders = await ordersWhere(
    `WHERE phone = $1 AND status IN ('abierto', 'boleta') ORDER BY id DESC`,
    [phone],
  );
  for (const order of orders) {
    await query(`
      UPDATE orders SET status = 'cancelado', lifecycle = 'cancelado', boleta_pendiente = 0, kitchen_status = 'cancelado', updated_at = NOW()
      WHERE id = $1
    `, [order.id]);
  }
  return orders;
}

async function insertOrder(phone) {
  const contact = await query('SELECT id FROM contacts WHERE wa_id = $1', [phone]);
  const { rows } = await query(`
    INSERT INTO orders (phone, contact_id) VALUES ($1, $2) RETURNING ${ORDER_COLUMNS}
  `, [phone, contact.rows[0]?.id || null]);
  return parseOrder(rows[0]);
}

export async function getOrCreateActiveOrder(phone) {
  const existing = await getActiveOrder(phone);
  if (existing) return existing;
  return insertOrder(phone);
}

export async function startFreshActiveOrder(phone) {
  await clearActiveCarts(phone);
  return insertOrder(phone);
}

export async function saveOrder(order, client = null) {
  const work = async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [order.phone]);
    const prev = await c.query('SELECT lifecycle FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
    const incoming = order.lifecycle || lifecycleFromLegacy(order.status);
    const lifecycle = mergeLifecycle(prev.rows[0]?.lifecycle, incoming);
    const status = order.status === 'cancelado' ? 'cancelado' : legacyStatus(lifecycle);
    order.lifecycle = lifecycle;
    order.status = status;
    await c.query(`
      UPDATE orders SET
        status = $1, lifecycle = $2, items = $3::jsonb, address = $4, total_usd = $5, total_bs = $6,
        bcv_rate = $7, boleta_pendiente = $8, kitchen_status = $9,
        payment_reference = COALESCE($10, payment_reference),
        payment_media_id = COALESCE($11, payment_media_id),
        payment_note = COALESCE($12, payment_note),
        fulfillment = COALESCE($13, fulfillment),
        location_lat = COALESCE($14, location_lat),
        location_lng = COALESCE($15, location_lng),
        location_label = COALESCE($16, location_label),
        stock_deducted = COALESCE($17, stock_deducted),
        updated_at = NOW()
      WHERE id = $18
    `, [
      status,
      lifecycle,
      JSON.stringify(order.items || []),
      order.address ?? null,
      order.total_usd ?? null,
      order.total_bs ?? null,
      order.bcv_rate ?? null,
      order.boleta_pendiente ? 1 : 0,
      order.kitchen_status || 'nuevo',
      order.payment_reference ?? null,
      order.payment_media_id ?? null,
      order.payment_note ?? null,
      order.fulfillment ?? null,
      order.location_lat ?? null,
      order.location_lng ?? null,
      order.location_label ?? null,
      order.stock_deducted ?? null,
      order.id,
    ]);
    if (prev.rows[0]?.lifecycle !== lifecycle) {
      await c.query(`
        INSERT INTO order_events (order_id, wa_id, from_state, to_state, actor, detail)
        VALUES ($1, $2, $3, $4, 'barbara', $5::jsonb)
      `, [order.id, order.phone, prev.rows[0]?.lifecycle || null, lifecycle, JSON.stringify({ tipo: 'estado' })]);
    }
  };
  if (client) return work(client);
  return withTransaction(work);
}

export async function listOpenOrders() {
  return ordersWhere(`
    WHERE lifecycle NOT IN ('cancelado', 'entregado')
      AND items <> '[]'::jsonb
    ORDER BY updated_at DESC
  `, []);
}

export async function getCommercialOrder(phone) {
  const rows = await ordersWhere(`
    WHERE phone = $1 AND lifecycle NOT IN ('cancelado', 'entregado')
    ORDER BY id DESC LIMIT 1
  `, [phone]);
  return rows[0] || null;
}

export async function listCustomerOrders(phone, limit = 8) {
  return ordersWhere(`
    WHERE phone = $1 AND lifecycle <> 'cancelado'
    ORDER BY id DESC LIMIT $2
  `, [phone, limit]);
}

export async function listOrderEvents(orderId) {
  const { rows } = await query(`
    SELECT id, from_state, to_state, actor, detail, ${ms('created_at')} AS created_at
    FROM order_events WHERE order_id = $1 ORDER BY id
  `, [orderId]);
  return rows;
}

export async function ledgerActions(orderId) {
  const { rows } = await query('SELECT action, lines FROM stock_ledger WHERE order_id = $1 ORDER BY id', [orderId]);
  return rows.map((row) => ({ action: row.action, lines: row.lines }));
}

export function orderIsProtected(order) {
  return isProtectedFromExpiry(order);
}

export async function setLogistics(phone, reason = null) {
  const now = Date.now();
  await query(`
    UPDATE conversations conv SET
      status = 'LOGISTICA',
      paused = TRUE,
      paused_at = to_timestamp($2 / 1000.0),
      paused_until = NULL,
      handoff_reason = COALESCE($3, conv.handoff_reason),
      updated_at = NOW()
    FROM contacts c
    WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
  `, [phone, now, reason]);
}

export async function getCustomerProfile(phone) {
  const { rows } = await query('SELECT wa_id, display_name, fulfillment, notes, addresses FROM customer_profiles WHERE wa_id = $1', [phone]);
  return rows[0] || null;
}

export async function saveCustomerProfile(phone, patch = {}) {
  const current = await getCustomerProfile(phone);
  const addresses = Array.isArray(patch.addresses) ? patch.addresses : (current?.addresses || []);
  await query(`
    INSERT INTO customer_profiles (wa_id, display_name, fulfillment, notes, addresses, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
    ON CONFLICT (wa_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, customer_profiles.display_name),
      fulfillment = COALESCE(EXCLUDED.fulfillment, customer_profiles.fulfillment),
      notes = COALESCE(EXCLUDED.notes, customer_profiles.notes),
      addresses = EXCLUDED.addresses,
      updated_at = NOW()
  `, [
    phone,
    patch.display_name ?? current?.display_name ?? null,
    patch.fulfillment ?? current?.fulfillment ?? null,
    patch.notes ?? current?.notes ?? null,
    JSON.stringify(addresses),
  ]);
  return getCustomerProfile(phone);
}

export async function getOrderById(id) {
  const rows = await ordersWhere('WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getOrdersToday() {
  const rows = await ordersWhere(
    `WHERE status IN ('abierto', 'boleta', 'recibido') AND items <> '[]'::jsonb AND updated_at >= to_timestamp($1 / 1000.0) ORDER BY updated_at DESC`,
    [startOfDayMs()],
  );
  return rows;
}

function startOfDayMs() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return Date.parse(`${get('year')}-${get('month')}-${get('day')}T04:00:00.000Z`);
}

export async function listKitchenOrders(limit = 40, withinHours = 24) {
  const since = Date.now() - withinHours * 3600 * 1000;
  return ordersWhere(`
    WHERE status = 'recibido'
      AND kitchen_status IN ('nuevo', 'preparado')
      AND items <> '[]'::jsonb
      AND COALESCE(board_hidden, 0) = 0
      AND updated_at >= to_timestamp($1 / 1000.0)
    ORDER BY updated_at DESC
    LIMIT $2
  `, [since, limit]);
}

export async function listOrdersLastHours(withinHours = 24, limit = 50) {
  const since = Date.now() - withinHours * 3600 * 1000;
  return ordersWhere(`
    WHERE status IN ('recibido', 'cancelado')
      AND items <> '[]'::jsonb
      AND COALESCE(board_hidden, 0) = 0
      AND updated_at >= to_timestamp($1 / 1000.0)
    ORDER BY updated_at DESC
    LIMIT $2
  `, [since, limit]);
}

export async function setKitchenStatus(orderId, status) {
  const allowed = new Set(['nuevo', 'preparado', 'atendido', 'cancelado']);
  if (!allowed.has(status)) return null;
  const current = await getOrderById(orderId);
  if (!current) return null;
  if (status === 'cancelado') {
    await query(`
      UPDATE orders SET status = 'cancelado', boleta_pendiente = 0, kitchen_status = 'cancelado', updated_at = NOW()
      WHERE id = $1
    `, [orderId]);
  } else if (current.status === 'cancelado') {
    await query(`
      UPDATE orders SET status = 'recibido', kitchen_status = $2, boleta_pendiente = 0, updated_at = NOW()
      WHERE id = $1
    `, [orderId, status]);
  } else {
    await query(`
      UPDATE orders SET kitchen_status = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'recibido'
    `, [orderId, status]);
  }
  const order = await getOrderById(orderId);
  if (order) publishCrm({ type: 'kitchen', orderId: order.id, kitchenStatus: status, phone: order.phone });
  return order;
}

export async function hideFinishedOrderFromBoard(orderId) {
  const order = await getOrderById(orderId);
  if (!order) return null;
  const done = order.kitchen_status === 'atendido'
    || order.kitchen_status === 'cancelado'
    || order.status === 'cancelado';
  if (!done) return null;
  await query(`
    UPDATE orders SET board_hidden = 1, updated_at = NOW()
    WHERE id = $1 AND (status = 'cancelado' OR kitchen_status IN ('cancelado', 'atendido'))
  `, [orderId]);
  const updated = await getOrderById(orderId);
  if (updated) publishCrm({ type: 'order_hidden', orderId: updated.id, phone: updated.phone });
  return updated;
}

export async function hideCanceledOrderFromBoard(orderId) {
  return hideFinishedOrderFromBoard(orderId);
}

export async function addAdvisorAlert({ kind, phone = null, title, body }) {
  const { rows } = await query(`
    INSERT INTO advisor_alerts (kind, phone, title, body)
    VALUES ($1, $2, $3, $4)
    RETURNING id, ${ms('created_at')} AS created_at
  `, [kind, phone, title, body]);
  const alert = {
    id: Number(rows[0].id),
    kind,
    phone,
    title,
    body,
    created_at: Number(rows[0].created_at),
    done: 0,
  };
  publishCrm({ type: 'alert', alert });
  return alert;
}

export async function listOpenAlerts(limit = 40) {
  const { rows } = await query(`
    SELECT id, kind, phone, title, body, ${ms('created_at')} AS created_at, done
    FROM advisor_alerts WHERE done = 0 ORDER BY id DESC LIMIT $1
  `, [limit]);
  return rows.map((row) => ({ ...row, id: Number(row.id), created_at: Number(row.created_at) }));
}

export async function resolveAlert(id) {
  await query('UPDATE advisor_alerts SET done = 1 WHERE id = $1', [id]);
  publishCrm({ type: 'alert_done', id });
}

export async function resolveAlertsByPhoneKind(phone, kind) {
  await query('UPDATE advisor_alerts SET done = 1 WHERE phone = $1 AND kind = $2 AND done = 0', [phone, kind]);
  publishCrm({ type: 'alert_done', phone, kind });
}

export async function isDuplicateEvent(waMessageId, now = Date.now()) {
  if (typeof waMessageId !== 'string' || !waMessageId.trim()) return false;
  const id = waMessageId.trim();
  const { rows } = await query(
    `SELECT ${ms('created_at')} AS created_at FROM processed_events WHERE wa_message_id = $1`,
    [id],
  );
  if (!rows[0]) return false;
  if (now - Number(rows[0].created_at) >= PROCESSED_TTL_MS) {
    await query('DELETE FROM processed_events WHERE wa_message_id = $1', [id]);
    return false;
  }
  return true;
}

export async function markProcessed(waMessageId, now = Date.now()) {
  if (typeof waMessageId !== 'string' || !waMessageId.trim()) return false;
  await query(`
    INSERT INTO processed_events (wa_message_id, created_at)
    VALUES ($1, to_timestamp($2 / 1000.0))
    ON CONFLICT (wa_message_id) DO UPDATE SET created_at = EXCLUDED.created_at
  `, [waMessageId.trim(), now]);
  return true;
}

export async function getProductBySku(sku) {
  const { rows } = await query(`
    SELECT sku, name, category, presentation, description, price, stock, is_active, technical_specs
    FROM products_kb WHERE sku = $1
  `, [sku]);
  if (!rows[0]) return null;
  return {
    ...rows[0],
    price: Number(rows[0].price),
    stock: rows[0].stock == null ? null : Number(rows[0].stock),
  };
}

export async function listActiveProducts() {
  const { rows } = await query(`
    SELECT sku, name, category, presentation, description, price, stock, is_active
    FROM products_kb WHERE is_active = TRUE
    ORDER BY name
  `);
  return rows.map((row) => ({
    sku: row.sku,
    nombre: row.name,
    name: row.name,
    categoria: row.category,
    category: row.category,
    presentacion: row.presentation || 'unidad',
    presentation: row.presentation || 'unidad',
    descripcion: row.description,
    precio: Number(row.price),
    price: Number(row.price),
    stock: row.stock == null ? null : Number(row.stock),
    is_active: row.is_active,
  }));
}

export async function upsertProduct(product) {
  await query(`
    INSERT INTO products_kb (sku, name, category, presentation, description, technical_specs, price, stock, is_active)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
    ON CONFLICT (sku) DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      presentation = EXCLUDED.presentation,
      description = EXCLUDED.description,
      technical_specs = products_kb.technical_specs || EXCLUDED.technical_specs,
      price = EXCLUDED.price,
      stock = EXCLUDED.stock,
      is_active = EXCLUDED.is_active,
      updated_at = NOW()
  `, [
    product.sku,
    product.name,
    product.category || null,
    product.presentation || null,
    product.description,
    JSON.stringify(product.technical_specs || {}),
    product.price,
    product.stock ?? null,
    product.is_active !== false,
  ]);
}

export async function productEmbedHash(sku) {
  const { rows } = await query(
    `SELECT technical_specs->>'embed_hash' AS hash FROM products_kb WHERE sku = $1`,
    [sku],
  );
  return rows[0]?.hash || null;
}

export async function saveProductEmbedding(sku, vector, hash) {
  const literal = `[${vector.join(',')}]`;
  await query(`
    UPDATE products_kb SET
      embedding = $2::vector,
      technical_specs = jsonb_set(COALESCE(technical_specs, '{}'::jsonb), '{embed_hash}', to_jsonb($3::text), true),
      updated_at = NOW()
    WHERE sku = $1
  `, [sku, literal, hash]);
}

export async function searchByVector(vector, limit = 30) {
  const literal = `[${vector.join(',')}]`;
  const { rows } = await query(`
    SELECT sku, 1 - (embedding <=> $1::vector) AS similarity
    FROM products_kb
    WHERE is_active = TRUE AND embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [literal, limit]);
  return rows.map((row) => ({ sku: row.sku, vector: Number(row.similarity) }));
}

export async function countUserMessagesSince(phone, sinceMs) {
  const { rows } = await query(`
    SELECT COUNT(*)::int AS n
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1 AND m.sender_type = 'USER' AND m.created_at >= to_timestamp($2 / 1000.0)
  `, [phone, sinceMs]);
  return Number(rows[0]?.n || 0);
}

export async function recentUserMessages(phone, limit = 2) {
  const { rows } = await query(`
    SELECT m.content, ${ms('m.created_at')} AS created_at
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1 AND m.sender_type = 'USER'
    ORDER BY m.created_at DESC, m.seq DESC
    LIMIT $2
  `, [phone, limit]);
  return rows.map((row) => ({ content: row.content, created_at: Number(row.created_at) }));
}

export async function getChatBlock(phone) {
  const { rows } = await query(`
    SELECT reason,
           ${ms('blocked_until')} AS blocked_until,
           ${ms('warned_at')} AS warned_at,
           ${ms('notified_at')} AS notified_at
    FROM chat_blocks WHERE wa_id = $1
  `, [phone]);
  const row = rows[0];
  if (!row) return null;
  return {
    reason: row.reason,
    blockedUntil: row.blocked_until == null ? null : Number(row.blocked_until),
    warnedAt: row.warned_at == null ? null : Number(row.warned_at),
    notifiedAt: row.notified_at == null ? null : Number(row.notified_at),
  };
}

export async function saveChatBlock(phone, { blockedUntil = null, warnedAt = null, notifiedAt = null, reason = null } = {}) {
  await query(`
    INSERT INTO chat_blocks (wa_id, blocked_until, warned_at, notified_at, reason, updated_at)
    VALUES (
      $1,
      CASE WHEN $2::bigint IS NULL THEN NULL ELSE to_timestamp($2 / 1000.0) END,
      CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3 / 1000.0) END,
      CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4 / 1000.0) END,
      $5,
      NOW()
    )
    ON CONFLICT (wa_id) DO UPDATE SET
      blocked_until = EXCLUDED.blocked_until,
      warned_at = COALESCE(EXCLUDED.warned_at, chat_blocks.warned_at),
      notified_at = COALESCE(EXCLUDED.notified_at, chat_blocks.notified_at),
      reason = EXCLUDED.reason,
      updated_at = NOW()
  `, [phone, blockedUntil, warnedAt, notifiedAt, reason]);
}

export async function clearChatBlock(phone) {
  await query('DELETE FROM chat_blocks WHERE wa_id = $1', [phone]);
}

export async function listChatBlocks(now = Date.now()) {
  const { rows } = await query(`
    SELECT wa_id, reason, ${ms('blocked_until')} AS blocked_until
    FROM chat_blocks
    WHERE reason = 'manual' OR blocked_until > to_timestamp($1 / 1000.0)
    ORDER BY updated_at DESC
  `, [now]);
  return rows.map((row) => ({
    phone: row.wa_id,
    reason: row.reason,
    blockedUntil: row.blocked_until == null ? null : Number(row.blocked_until),
  }));
}

export async function deactivateMissingSkus(skus) {
  if (!skus.length) return;
  await query(`
    UPDATE products_kb SET is_active = FALSE, updated_at = NOW()
    WHERE is_active = TRUE
      AND category IS DISTINCT FROM 'politica'
      AND sku <> 'servicio-delivery'
      AND NOT (sku = ANY($1::text[]))
  `, [skus]);
}
