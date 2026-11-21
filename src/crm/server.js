import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import * as db from '../db.js';
import { info, warn } from '../log.js';
import { sendMessage } from '../messenger.js';
import { getBcvRate } from '../services/bcvService.js';
import { recordAdvisorMessage } from '../services/chatService.js';
import {
  getNoteById,
  listNotes,
  listOrderNotes,
  noteDeleteFinished,
  noteDismiss,
  noteKitchenStatus,
  noteNoStock,
  notePayment,
  noteSetFreight,
  noteSetPrice,
} from '../services/notesService.js';
import { applyNotAvailable, applyWeighedPrice } from '../services/orderService.js';
import { subscribeCrm } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

let httpServer = null;

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
}

function auth(req, res, next) {
  if (isLocal(req)) return next();
  const token = req.get('x-crm-token') || req.query.token || '';
  if (token !== config.crm.token) {
    return res.status(401).json({ error: 'Token inválido. En esta PC use http://127.0.0.1:3847' });
  }
  return next();
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // En la misma PC el panel toma el token solo; no hay que pegarlo a mano.
  app.get('/api/bootstrap', (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: 'Solo desde esta PC' });
    return res.json({ token: config.crm.token });
  });

  app.use('/api', auth);

  app.get('/api/chats', (_req, res) => {
    res.json({ chats: db.listRecentChats() });
  });

  app.get('/api/chats/:phone/messages', (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    const chat = db.getChat(phone);
    res.json({
      phone,
      name: chat?.name || null,
      paused: chat?.paused === 1,
      messages: db.getChatMessages(phone),
    });
  });

  app.post('/api/chats/:phone/reply', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const text = String(req.body?.text ?? '').trim();
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    if (!text) return res.status(400).json({ error: 'Escriba un mensaje' });

    db.upsertChat(phone, null);
    try {
      await sendMessage(phone, text);
      recordAdvisorMessage(phone, text);
      db.pauseChat(phone, config.manualPauseMinutes * 60 * 1000);
      return res.json({ ok: true, pausedMinutes: config.manualPauseMinutes });
    } catch (err) {
      return res.status(502).json({ error: `No se pudo enviar: ${err.message}. ¿WhatsApp ya está conectado?` });
    }
  });

  app.get('/api/orders/today', (_req, res) => {
    const orders = db.getOrdersToday().map((o) => ({
      id: o.id,
      phone: o.phone,
      name: db.getChat(o.phone)?.name || null,
      status: o.status,
      items: o.items,
      address: o.address,
      totalUsd: o.total_usd,
      totalBs: o.total_bs,
      updatedAt: o.updated_at,
    }));
    res.json({ orders });
  });

  app.get('/api/alerts', (_req, res) => {
    res.json({ alerts: db.listOpenAlerts() });
  });

  app.post('/api/alerts/:id/done', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Id inválido' });
    db.resolveAlert(id);
    res.json({ ok: true });
  });

  // --- Bloc de notas (requerimientos físicos: pesaje, flete, pago) ---
  app.get('/api/notes', async (_req, res) => {
    try {
      res.json({ notes: await listNotes() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pedidos de las últimas 24 h (tablero principal).
  app.get('/api/orders/board', async (_req, res) => {
    try {
      res.json({ orders: await listOrderNotes() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/notes/:ticketId', async (req, res) => {
    const previewUsd = req.query.usd != null ? Number(String(req.query.usd).replace(',', '.')) : null;
    const note = await getNoteById(req.params.ticketId, { previewUsd });
    if (!note) return res.status(404).json({ error: 'Nota no encontrada' });
    res.json({ note });
  });

  app.post('/api/notes/:ticketId/kitchen', async (req, res) => {
    try {
      const result = await noteKitchenStatus(req.params.ticketId, String(req.body?.status || ''), {
        notifyCustomer: req.body?.notifyCustomer !== false,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/notes/:ticketId/precio', async (req, res) => {
    const usd = Number(String(req.body?.usd ?? '').replace(',', '.'));
    try {
      const result = await noteSetPrice(req.params.ticketId, usd);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/notes/:ticketId/nohay', async (req, res) => {
    try {
      const result = await noteNoStock(req.params.ticketId);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/notes/:ticketId/flete', async (req, res) => {
    const usd = Number(String(req.body?.usd ?? '').replace(',', '.'));
    try {
      const result = await noteSetFreight(req.params.ticketId, usd);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/notes/:ticketId/pago', async (req, res) => {
    try {
      const result = await notePayment(req.params.ticketId, {
        ok: req.body?.ok !== false,
        mensaje: req.body?.mensaje,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/notes/:ticketId/dismiss', async (req, res) => {
    const result = await noteDismiss(req.params.ticketId);
    if (result.error) return res.status(400).json({ error: result.error });
    return res.json(result);
  });

  app.post('/api/notes/:ticketId/delete', async (req, res) => {
    try {
      const result = await noteDeleteFinished(req.params.ticketId);
      if (result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/caja/:phone/precio', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    const usd = Number(String(req.body?.usd ?? '').replace(',', '.'));
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
    if (!(usd > 0)) return res.status(400).json({ error: 'Indique un monto en dólares mayor que cero' });

    const result = applyWeighedPrice(phone, usd, await getBcvRate());
    if (result.error) return res.status(400).json({ error: result.error });
    try {
      await sendMessage(phone, result.message);
      db.addMessage(phone, 'model', result.message);
      db.resolveAlertsByPhoneKind(phone, 'weigh');
      return res.json({ ok: true, message: result.message });
    } catch (err) {
      return res.status(502).json({ error: `No se pudo enviar: ${err.message}` });
    }
  });

  app.post('/api/caja/:phone/nohay', async (req, res) => {
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (phone.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });

    const result = applyNotAvailable(phone, await getBcvRate());
    if (result.error) return res.status(400).json({ error: result.error });
    try {
      await sendMessage(phone, result.message);
      db.addMessage(phone, 'model', result.message);
      db.resolveAlertsByPhoneKind(phone, 'weigh');
      return res.json({ ok: true, message: result.message });
    } catch (err) {
      return res.status(502).json({ error: `No se pudo enviar: ${err.message}` });
    }
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);

    const unsubscribe = subscribeCrm((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(express.static(publicDir));

  return app;
}

/** Arranca el panel CRM. Se puede llamar antes de conectar WhatsApp. */
export function startCrmServer() {
  if (httpServer) {
    return Promise.resolve({ host: config.crm.host, port: config.crm.port });
  }
  if (!fs.existsSync(publicDir)) {
    throw new Error(`Falta la carpeta del panel: ${publicDir}`);
  }

  const app = createApp();
  return new Promise((resolve, reject) => {
    httpServer = app.listen(config.crm.port, config.crm.host, () => {
      info(`Buzón CRM: http://${config.crm.host}:${config.crm.port}`);
      resolve({ host: config.crm.host, port: config.crm.port });
    });
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        warn(`CRM: el puerto ${config.crm.port} ya está en uso. Cierre la otra ventana de Bárbara y vuelva a iniciar.`);
      } else {
        warn('CRM no pudo abrir el puerto:', err.message);
      }
      reject(err);
    });
  });
}
