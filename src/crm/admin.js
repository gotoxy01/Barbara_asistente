import { query } from '../db/pool.js';
import * as db from '../db.js';
import { getProducts } from '../services/catalogService.js';
import { handleCustomerMessage } from '../services/chatService.js';
import { rememberMenu } from '../services/menuFlow.js';
import { applyConfirmedStock, applyRejectedStock } from '../services/orderService.js';
import { applyAction } from '../services/orderBook.js';
import { getBcvRate } from '../services/bcvService.js';
import { monthRange, usageCsv, usageReport, zonedMidnight } from '../services/usage.js';
import { config } from '../config.js';

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function storeTestReply(phone, text) {
  if (!text) return;
  await db.addMessage(phone, 'model', text, null, { raw: { prueba: 'si' } });
}

export function registerAdminRoutes(app) {
  app.post('/api/simulator/turn', async (req, res) => {
    const phone = digits(req.body?.phone || '580000000000');
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    let text = String(req.body?.text || '').trim();
    if (req.body?.location) {
      const lat = Number(req.body.location.lat);
      const lng = Number(req.body.location.lng);
      text = `[El cliente compartió su ubicación: prueba (lat ${lat}, lon ${lng})]`;
    }
    if (!text) return res.status(400).json({ error: 'Escriba un mensaje' });
    try {
      const result = await handleCustomerMessage(
        { phone, name: req.body?.name || 'Cliente de prueba', text },
        { notify: async () => {}, test: true },
      );
      await storeTestReply(phone, result.reply);
      return res.json({
        prueba: true,
        reply: result.reply,
        menu: result.menu || null,
        escalated: Boolean(result.escalated),
        paused: Boolean(result.paused),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/simulator/reset', async (req, res) => {
    const phone = digits(req.body?.phone || '580000000000');
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    rememberMenu(phone, { menu: null, awaiting: null, sku: null });
    const removed = await db.clearCustomerThread(phone);
    await db.cancelPendingOrders(phone);
    return res.json({ ok: true, removed });
  });

  app.get('/api/simulator/pedido', async (req, res) => {
    const phone = digits(req.query.phone || '');
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    return res.json({ order: await db.getActiveOrder(phone) });
  });

  app.post('/api/simulator/pago', async (req, res) => {
    const phone = digits(req.body?.phone || '');
    const order = req.body?.orderId ? await db.getOrderById(req.body.orderId) : await db.getActiveOrder(phone);
    if (!order) return res.status(404).json({ error: 'No hay pedido' });
    const reduced = await applyAction(order.phone, {
      type: req.body?.ok === false ? 'reject_payment' : 'verify_payment',
      orderId: order.id,
      actor: 'operador',
    });
    if (reduced.error) return res.status(400).json({ error: reduced.error });
    await storeTestReply(order.phone, reduced.customerReply);
    return res.json({ ok: true, lifecycle: reduced.order.lifecycle, reply: reduced.customerReply || null });
  });

  app.post('/api/simulator/stock', async (req, res) => {
    const phone = digits(req.body?.phone || '');
    const producto = String(req.body?.producto || '').trim();
    if (!producto) return res.status(400).json({ error: 'Indique el producto' });
    const bcv = await getBcvRate();
    const result = req.body?.hay === false
      ? await applyRejectedStock(phone, producto)
      : await applyConfirmedStock(phone, producto, Number(req.body?.precio) || 0, bcv);
    if (result.error) return res.status(400).json({ error: result.error });
    await storeTestReply(result.order.phone, result.message);
    return res.json({ ok: true, reply: result.message });
  });

  app.get('/api/usage', async (req, res) => {
    res.json(await usageReport(req.query.month));
  });

  app.get('/api/usage.csv', async (req, res) => {
    const report = await usageReport(req.query.month);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="uso-${report.month}.csv"`);
    res.send(usageCsv(report));
  });

  app.get('/api/customers', async (_req, res) => {
    const { rows } = await query(`
      SELECT c.wa_id AS phone, c.full_name AS name,
             p.fulfillment, p.addresses, p.notes,
             COUNT(o.id)::int AS orders,
             COALESCE(SUM(CASE WHEN o.lifecycle IN ('pago_verificado', 'en_logistica', 'entregado') THEN o.total_usd ELSE 0 END), 0) AS spent,
             (MAX(EXTRACT(EPOCH FROM o.updated_at)) * 1000)::bigint AS last_at
      FROM contacts c
      LEFT JOIN customer_profiles p ON p.wa_id = c.wa_id
      LEFT JOIN orders o ON o.phone = c.wa_id
      GROUP BY c.wa_id, c.full_name, p.fulfillment, p.addresses, p.notes
      ORDER BY last_at DESC NULLS LAST
      LIMIT 200
    `);
    const blocks = await db.listChatBlocks();
    const blocked = new Map(blocks.map((row) => [row.phone, row]));
    res.json({
      customers: rows.map((row) => ({
        phone: row.phone,
        name: row.name,
        fulfillment: row.fulfillment,
        addresses: row.addresses || [],
        notes: row.notes,
        orders: Number(row.orders) || 0,
        spent: Number(row.spent) || 0,
        lastAt: row.last_at == null ? null : Number(row.last_at),
        blocked: blocked.get(row.phone) || null,
      })),
    });
  });

  app.post('/api/customers/:phone/block', async (req, res) => {
    const phone = digits(req.params.phone);
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    await db.upsertChat(phone, null);
    await db.saveChatBlock(phone, { reason: 'manual', blockedUntil: null });
    res.json({ ok: true });
  });

  app.post('/api/customers/:phone/unblock', async (req, res) => {
    const phone = digits(req.params.phone);
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    await db.clearChatBlock(phone);
    res.json({ ok: true });
  });

  app.get('/api/products', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const products = getProducts()
      .filter((product) => product.categoria !== 'politica' && product.sku !== 'servicio-delivery')
      .filter((product) => !q || `${product.nombre} ${product.categoria} ${product.sku}`.toLowerCase().includes(q))
      .slice(0, 80)
      .map((product) => ({
        sku: product.sku,
        nombre: product.nombre,
        categoria: product.categoria,
        presentacion: product.presentacion,
        precio: product.precio,
        stock: product.stock,
      }));
    res.json({ products });
  });

  app.get('/api/stock-pendiente', async (_req, res) => {
    const { rows } = await query(`
      SELECT l.id, l.order_id, l.action, l.lines,
             (EXTRACT(EPOCH FROM l.created_at) * 1000)::bigint AS created_at,
             o.phone
      FROM stock_ledger l
      JOIN orders o ON o.id = l.order_id
      ORDER BY l.id DESC
      LIMIT 40
    `);
    res.json({
      aviso: 'Estos ajustes están en el libro de Bárbara. Hay que pasarlos a la caja a mano. Este panel no escribe en database.db.',
      rows: rows.map((row) => ({ ...row, id: Number(row.id), order_id: Number(row.order_id), created_at: Number(row.created_at) })),
    });
  });

  app.get('/api/ventas', async (req, res) => {
    const range = String(req.query.range || 'day');
    const now = Date.now();
    let start = now - 86_400_000;
    let end = now + 60_000;
    if (range === 'month') {
      const month = monthRange();
      start = month.start;
      end = month.end;
    } else if (range === 'week') {
      start = now - 7 * 86_400_000;
    } else {
      const today = monthRange();
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, day: '2-digit' }).format(new Date());
      const [year, month] = today.label.split('-').map(Number);
      start = zonedMidnight(year, month, Number(day));
      end = start + 86_400_000;
    }
    const { rows } = await query(`
      SELECT lifecycle, COUNT(*)::int AS n,
             COALESCE(SUM(total_usd), 0) AS usd,
             COALESCE(SUM(total_bs), 0) AS bs
      FROM orders
      WHERE updated_at >= to_timestamp($1 / 1000.0)
        AND updated_at < to_timestamp($2 / 1000.0)
      GROUP BY lifecycle
    `, [start, end]);
    const by = Object.fromEntries(rows.map((row) => [row.lifecycle, {
      n: Number(row.n), usd: Number(row.usd), bs: Number(row.bs),
    }]));
    const paid = ['pago_verificado', 'en_logistica', 'entregado'].reduce((sum, key) => sum + (by[key]?.usd || 0), 0);
    const paidBs = ['pago_verificado', 'en_logistica', 'entregado'].reduce((sum, key) => sum + (by[key]?.bs || 0), 0);
    res.json({
      range,
      pedidos: rows.reduce((sum, row) => sum + Number(row.n), 0),
      pagados: ['pago_verificado', 'en_logistica', 'entregado'].reduce((sum, key) => sum + (by[key]?.n || 0), 0),
      cancelados: by.cancelado?.n || 0,
      totalUsd: paid,
      totalBs: paidBs,
      porEstado: by,
    });
  });
}
