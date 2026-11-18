import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** @typedef {'PENDIENTE' | 'ESPERANDO_EDICION' | 'CERRADO'} TicketEstado */

/**
 * @typedef {object} OperatorTicket
 * @property {string} ticketId
 * @property {string} clienteTelefono
 * @property {string|null} clienteNombre
 * @property {object[]} items
 * @property {number|null} montoTotalUSD
 * @property {number|null} montoTotalBs
 * @property {string} borradorRespuesta
 * @property {TicketEstado} estado
 * @property {string} [motivo]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const memory = new Map();
/** ticketId que el operador activo está editando (un solo editor a la vez). */
let editingTicketId = null;
let seq = 0;
let loaded = false;

function persistPath() {
  if (config.operatorConsole.persistTickets === false) return null;
  const dir = path.dirname(path.resolve(config.dbPath));
  return path.join(dir, 'operator-tickets.json');
}

function loadIfNeeded() {
  if (loaded) return;
  loaded = true;
  const file = persistPath();
  if (!file || !fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    seq = Number(data.seq) || 0;
    editingTicketId = data.editingTicketId || null;
    for (const ticket of data.tickets || []) {
      if (ticket?.ticketId) memory.set(ticket.ticketId, ticket);
    }
  } catch {
    // archivo corrupto: se parte de cero
  }
}

function save() {
  const file = persistPath();
  if (!file) return;
  const tickets = [...memory.values()].filter((t) => t.estado !== 'CERRADO' || Date.now() - t.updatedAt < 86_400_000);
  const payload = {
    seq,
    editingTicketId,
    tickets,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

function nextTicketId() {
  seq += 1;
  return `T-${seq}`;
}

/**
 * @param {Omit<OperatorTicket, 'ticketId'|'estado'|'createdAt'|'updatedAt'> & { estado?: TicketEstado }} data
 * @returns {OperatorTicket}
 */
export function createTicket(data) {
  loadIfNeeded();
  const now = Date.now();
  /** @type {OperatorTicket} */
  const ticket = {
    ticketId: nextTicketId(),
    clienteTelefono: data.clienteTelefono,
    clienteNombre: data.clienteNombre || null,
    items: Array.isArray(data.items) ? data.items : [],
    montoTotalUSD: data.montoTotalUSD ?? null,
    montoTotalBs: data.montoTotalBs ?? null,
    borradorRespuesta: String(data.borradorRespuesta || '').trim(),
    estado: data.estado || 'PENDIENTE',
    motivo: data.motivo || 'aprobacion',
    createdAt: now,
    updatedAt: now,
  };
  memory.set(ticket.ticketId, ticket);
  save();
  return ticket;
}

/** @param {string} ticketId */
export function getTicket(ticketId) {
  loadIfNeeded();
  return memory.get(ticketId) || null;
}

/** @param {string} ticketId @param {Partial<OperatorTicket>} patch */
export function updateTicket(ticketId, patch) {
  const ticket = getTicket(ticketId);
  if (!ticket) return null;
  Object.assign(ticket, patch, { updatedAt: Date.now() });
  memory.set(ticketId, ticket);
  save();
  return ticket;
}

export function setEditingTicket(ticketId) {
  loadIfNeeded();
  editingTicketId = ticketId;
  save();
}

export function getEditingTicket() {
  loadIfNeeded();
  if (!editingTicketId) return null;
  const ticket = getTicket(editingTicketId);
  if (!ticket || ticket.estado !== 'ESPERANDO_EDICION') {
    editingTicketId = null;
    return null;
  }
  return ticket;
}

export function clearEditingTicket(ticketId) {
  loadIfNeeded();
  if (!ticketId || editingTicketId === ticketId) {
    editingTicketId = null;
    save();
  }
}

/** Tickets abiertos (no CERRADO), más recientes primero. */
export function listOpenTickets(limit = 40) {
  loadIfNeeded();
  return [...memory.values()]
    .filter((t) => t.estado !== 'CERRADO')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
