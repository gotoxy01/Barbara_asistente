import * as db from '../db.js';
import { withTransaction } from '../db/pool.js';
import { reduceOrder, renderProfileSummary } from './orderLifecycle.js';

function mapOrder(row) {
  if (!row) return null;
  const items = Array.isArray(row.items) ? row.items : JSON.parse(row.items || '[]');
  return {
    ...row,
    id: Number(row.id),
    items,
    total_usd: row.total_usd == null ? null : Number(row.total_usd),
    total_bs: row.total_bs == null ? null : Number(row.total_bs),
    bcv_rate: row.bcv_rate == null ? null : Number(row.bcv_rate),
    location_lat: row.location_lat == null ? null : Number(row.location_lat),
    location_lng: row.location_lng == null ? null : Number(row.location_lng),
    stock_deducted: row.stock_deducted === true,
    boleta_pendiente: Number(row.boleta_pendiente) || 0,
  };
}

async function loadLocked(client, phone, orderId) {
  const { rows } = await client.query(`
    SELECT *
    FROM orders
    WHERE ${orderId ? 'id = $1' : "phone = $1 AND lifecycle NOT IN ('cancelado', 'entregado')"}
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE
  `, [orderId || phone]);
  return mapOrder(rows[0]);
}

async function writeOrder(client, order) {
  const fields = [
    order.status,
    order.lifecycle,
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
    order.stock_deducted === true,
  ];
  if (!order.id) {
    const contact = await client.query('SELECT id FROM contacts WHERE wa_id = $1', [order.phone]);
    const inserted = await client.query(`
      INSERT INTO orders (
        phone, contact_id, status, lifecycle, items, address, total_usd, total_bs, bcv_rate,
        boleta_pendiente, kitchen_status, payment_reference, payment_media_id, payment_note,
        fulfillment, location_lat, location_lng, location_label, stock_deducted
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
      ) RETURNING id
    `, [order.phone, contact.rows[0]?.id || null, ...fields]);
    order.id = Number(inserted.rows[0].id);
    return;
  }
  await client.query(`
    UPDATE orders SET
      status = $2, lifecycle = $3, items = $4::jsonb, address = $5, total_usd = $6, total_bs = $7,
      bcv_rate = $8, boleta_pendiente = $9, kitchen_status = $10,
      payment_reference = $11, payment_media_id = $12, payment_note = $13, fulfillment = $14,
      location_lat = $15, location_lng = $16, location_label = $17, stock_deducted = $18,
      updated_at = NOW()
    WHERE id = $1
  `, [order.id, ...fields]);
}

async function rememberAddress(phone, order) {
  if (!order?.address && !order?.fulfillment) return;
  const profile = await db.getCustomerProfile(phone);
  const addresses = Array.isArray(profile?.addresses) ? [...profile.addresses] : [];
  if (order.address && !addresses.some((item) => item.text === order.address)) {
    addresses.unshift({ text: order.address, saved_at: new Date().toISOString() });
  }
  await db.saveCustomerProfile(phone, {
    fulfillment: order.fulfillment || null,
    addresses: addresses.slice(0, 5),
  });
}

/**
 * Cambio durable del pedido. Candado por teléfono, transacción, evento y libro de stock.
 * El descuento no se escribe en la base de la caja.
 */
export async function applyAction(phone, action) {
  const reduced = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);
    const current = await loadLocked(client, phone, action.orderId);
    const next = reduceOrder(current, { ...action, phone });
    if (next.error || !next.order) return next;
    await writeOrder(client, next.order);
    if (next.event) {
      next.event.order_id = next.order.id;
      await client.query(`
        INSERT INTO order_events (order_id, wa_id, from_state, to_state, actor, detail)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        next.order.id,
        phone,
        next.event.from_state,
        next.event.to_state,
        next.event.actor || action.actor || 'sistema',
        JSON.stringify(next.event.detail || {}),
      ]);
    }
    if (next.ledger) {
      const inserted = await client.query(`
        INSERT INTO stock_ledger (order_id, action, lines)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (order_id, action) DO NOTHING
        RETURNING id
      `, [next.order.id, next.ledger.action, JSON.stringify(next.ledger.lines || [])]);
      if (!inserted.rowCount) next.ledger = null;
    }
    if (next.logistics) {
      await client.query(`
        UPDATE conversations conv SET
          status = 'LOGISTICA',
          paused = TRUE,
          paused_at = NOW(),
          paused_until = NULL,
          handoff_reason = $2,
          updated_at = NOW()
        FROM contacts c
        WHERE conv.contact_id = c.id AND c.wa_id = $1 AND conv.status <> 'CLOSED'
      `, [phone, `Pedido #${next.order.id} listo para entrega`]);
    }
    return next;
  });
  if (!reduced.error && (action.type === 'save_address' || action.type === 'save_location')) {
    await rememberAddress(phone, reduced.order);
  }
  return reduced;
}

export async function loadProfileSummary(phone, name) {
  if (name) await db.saveCustomerProfile(phone, { display_name: name });
  const profile = await db.getCustomerProfile(phone);
  const orders = await db.listCustomerOrders(phone);
  return renderProfileSummary(profile, orders);
}

export async function reloadOpenOrders() {
  return db.listOpenOrders();
}
