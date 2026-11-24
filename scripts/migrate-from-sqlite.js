// Pasa barbara.db (SQLite) a PostgreSQL local. Se puede correr más de una vez.
// Uso: DATABASE_URL=postgresql://... node scripts/migrate-from-sqlite.js
import { DatabaseSync } from 'node:sqlite';
import { assertDatabaseConfig, config } from '../src/config.js';
import { closeDb, initDb } from '../src/db.js';
import { query } from '../src/db/pool.js';

assertDatabaseConfig();

const sqlite = new DatabaseSync(config.dbPath, { readOnly: true });

function rows(sql) {
  try {
    return sqlite.prepare(sql).all();
  } catch {
    return [];
  }
}

function msToDate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n) : null;
}

await initDb();

const chats = rows('SELECT * FROM chats');
for (const chat of chats) {
  await query(`
    INSERT INTO contacts (wa_id, full_name, created_at)
    VALUES ($1, $2, COALESCE($3, NOW()))
    ON CONFLICT (wa_id) DO UPDATE SET full_name = COALESCE(EXCLUDED.full_name, contacts.full_name)
  `, [chat.phone, chat.name || null, msToDate(chat.created_at)]);
  const contact = await query('SELECT id FROM contacts WHERE wa_id = $1', [chat.phone]);
  const status = chat.status === 'SPECIALIST' ? 'SPECIALIST' : 'BOT';
  const existing = await query(`
    SELECT id FROM conversations WHERE contact_id = $1 AND status <> 'CLOSED' ORDER BY updated_at DESC LIMIT 1
  `, [contact.rows[0].id]);
  if (!existing.rows[0]) {
    await query(`
      INSERT INTO conversations (
        contact_id, status, paused, paused_at, paused_until, last_user_message_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
    `, [
      contact.rows[0].id,
      status,
      chat.paused === 1,
      msToDate(chat.paused_at),
      msToDate(chat.paused_until),
      msToDate(chat.last_user_message_at),
      msToDate(chat.created_at),
    ]);
  }
}

const messages = rows('SELECT * FROM messages ORDER BY id');
for (const message of messages) {
  const conv = await query(`
    SELECT conv.id FROM conversations conv
    JOIN contacts c ON c.id = conv.contact_id
    WHERE c.wa_id = $1 AND conv.status <> 'CLOSED'
    ORDER BY conv.updated_at DESC LIMIT 1
  `, [message.phone]);
  if (!conv.rows[0]) continue;
  const created = msToDate(message.created_at) || new Date();
  const sender = message.role === 'user' ? 'USER' : 'BOT';
  const already = await query(`
    SELECT 1 FROM messages
    WHERE conversation_id = $1 AND sender_type = $2 AND content = $3 AND created_at = $4
    LIMIT 1
  `, [conv.rows[0].id, sender, message.content, created]);
  if (already.rows[0]) continue;
  const wamid = message.wamid || null;
  await query(`
    INSERT INTO messages (wamid, conversation_id, sender_type, content, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (wamid) DO NOTHING
  `, [
    wamid,
    conv.rows[0].id,
    sender,
    message.content,
    created,
  ]);
}

const orders = rows('SELECT * FROM orders ORDER BY id');
for (const order of orders) {
  const contact = await query('SELECT id FROM contacts WHERE wa_id = $1', [order.phone]);
  await query(`
    INSERT INTO orders (
      id, phone, contact_id, status, items, address, total_usd, total_bs, bcv_rate,
      boleta_pendiente, kitchen_status, board_hidden, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    ON CONFLICT (id) DO NOTHING
  `, [
    order.id,
    order.phone,
    contact.rows[0]?.id || null,
    order.status,
    order.items || '[]',
    order.address || null,
    order.total_usd,
    order.total_bs,
    order.bcv_rate,
    order.boleta_pendiente || 0,
    order.kitchen_status || 'nuevo',
    order.board_hidden || 0,
    msToDate(order.created_at) || new Date(),
    msToDate(order.updated_at) || new Date(),
  ]);
}
await query(`SELECT setval('orders_id_seq', COALESCE((SELECT MAX(id) FROM orders), 1))`);

const alerts = rows('SELECT * FROM advisor_alerts ORDER BY id');
for (const alert of alerts) {
  await query(`
    INSERT INTO advisor_alerts (id, kind, phone, title, body, created_at, done)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING
  `, [
    alert.id, alert.kind, alert.phone, alert.title, alert.body,
    msToDate(alert.created_at) || new Date(), alert.done || 0,
  ]);
}
if (alerts.length) {
  await query(`SELECT setval('advisor_alerts_id_seq', COALESCE((SELECT MAX(id) FROM advisor_alerts), 1))`);
}

const events = rows('SELECT * FROM processed_events');
for (const event of events) {
  await query(`
    INSERT INTO processed_events (wa_message_id, created_at)
    VALUES ($1, $2)
    ON CONFLICT (wa_message_id) DO NOTHING
  `, [event.wa_message_id, msToDate(event.created_at) || new Date()]);
}

sqlite.close();
await closeDb();
console.log(`Listo. Chats: ${chats.length}. Mensajes: ${messages.length}. Pedidos: ${orders.length}.`);
