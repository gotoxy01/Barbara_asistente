const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('crmToken') || '',
  selectedId: null,
  phone: null,
  detail: null,
  orders: [],
  caja: [],
  rail: [],
  doneRail: [],
  pendingPriceNote: null,
  es: null,
};

function isFinishedNote(note) {
  if (note.motivo !== 'pedido') return false;
  const s = note.kitchenStatus || 'nuevo';
  return s === 'atendido' || s === 'cancelado' || note.order?.status === 'cancelado';
}

function isLocalHost() {
  return ['localhost', '127.0.0.1'].includes(location.hostname);
}

function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (state.token) url.searchParams.set('token', state.token);
  return url;
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-crm-token': state.token } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function money(usd, bs) {
  if (usd == null && bs == null) return '';
  if (bs != null) return `Bs. ${Number(bs).toFixed(2)}`;
  return `$ ${Number(usd).toFixed(2)}`;
}

function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function itemIcon(name = '') {
  const n = String(name).toLowerCase();
  if (/tomate|piment|cebolla|lechuga|verdura|aguacate|lim[oó]n|cilantro|ajo|papa|yuca|zanahoria|repollo/.test(n)) return '🥬';
  if (/queso|ricotta|mozzarella/.test(n)) return '🧀';
  if (/jam[oó]n|mortadela|carne|pollo|chorizo|salchicha|res|cerdo|costilla|hamburguesa/.test(n)) return '🥩';
  if (/pan|harina|arepa|empanada|galleta/.test(n)) return '🍞';
  if (/leche|yogurt|mantequilla|quesillo/.test(n)) return '🥛';
  if (/arroz|pasta|espagueti|fideo/.test(n)) return '🍚';
  if (/aceite|mayonesa|salsa|ketchup|mostaza/.test(n)) return '🫙';
  if (/huevo/.test(n)) return '🥚';
  if (/caf[eé]|t[eé]|az[uú]car|sal/.test(n)) return '☕';
  if (/cerveza|polar|refresco|malta|jugo|agua|gaseosa/.test(n)) return '🥤';
  if (/delivery|flete|env[ií]o/.test(n)) return '🛵';
  if (/pago|transfer|m[oó]vil|comprobante/.test(n)) return '💳';
  if (/consulta|\?|pregunt/.test(n)) return '❓';
  return '🛒';
}

function prepLabel(i) {
  if (i.prep) return i.prep;
  if (i.detalle && i.detalle !== i.nombre) return i.detalle;
  if (i.precio == null && i.nombre) return `${i.nombre} (pendiente)`;
  const qty = i.cantidad != null
    ? (/kilo/i.test(i.presentacion || '') ? `${i.cantidad} kg` : `${i.cantidad}×`)
    : '';
  const name = i.nombre || 'Ítem';
  const pres = i.presentacion ? ` (${i.presentacion})` : '';
  return `${qty ? `${qty} ` : ''}${name}${pres}`.trim();
}

function noteItems(note) {
  if (!note) return [];
  if (note.motivo === 'pedido') {
    // Preferir items decorados (con prep) o los del pedido guardado
    const raw = (note.items?.length ? note.items : null)
      || (note.order?.items?.length ? note.order.items : [])
      || [];
    return raw.map((i) => {
      const label = prepLabel(i);
      return {
        nombre: i.nombre || label,
        detalle: label,
        label,
        qty: i.cantidad,
        presentacion: i.presentacion,
        need: i.consulta || i.precio == null,
        consulta: !!i.consulta,
        noPrice: i.precio == null && !i.consulta,
      };
    });
  }
  if (note.motivo === 'pago') {
    return [{ nombre: 'Comprobante de pago', detalle: 'Revisar captura', label: 'Comprobante de pago', need: true, pago: true }];
  }
  if (note.motivo === 'flete') {
    return [{ nombre: 'Flete / envío', detalle: note.note || 'Indicar tarifa', label: 'Flete / envío', need: true, flete: true }];
  }
  const pending = note.pending?.length ? note.pending : (note.items || []);
  if (!pending.length) {
    return [{ nombre: 'Pesaje', detalle: 'Producto a pesar', label: 'Producto a pesar', need: true }];
  }
  return pending.map((i) => {
    const label = prepLabel(i);
    return {
      nombre: i.nombre || label,
      detalle: label,
      label,
      need: true,
      consulta: !!i.consulta,
    };
  });
}

function ticketNum(note, index) {
  if (note.motivo === 'pedido' && note.orderId) {
    return String(note.orderId).padStart(2, '0').slice(-2);
  }
  if (note.n) return String(note.n).padStart(2, '0');
  return String(index + 1).padStart(2, '0');
}

function ticketClass(note) {
  if (note.motivo !== 'pedido') return 'caja-kind';
  const s = note.kitchenStatus || 'nuevo';
  if (s === 'atendido') return 'done';
  if (s === 'cancelado') return 'canceled';
  if (s === 'preparado') return 'opened';
  return 'pending';
}

function ticketTag(note) {
  if (note.motivo === 'pedido') {
    const s = note.kitchenStatus || 'nuevo';
    return ({ nuevo: 'Pendiente', preparado: 'Abierta', atendido: 'Hecha', cancelado: 'Cancelada' })[s] || s;
  }
  return ({ pesaje: 'Balanza', caja: 'Balanza', flete: 'Flete', pago: 'Pago' })[note.motivo] || 'Caja';
}

function buildTicketHtml(note, index, { focus = false } = {}) {
  const items = noteItems(note);
  const num = ticketNum(note, index);
  const who = note.name || `+${note.phone}`;
  const cls = ['ticket', ticketClass(note)];
  if (focus) cls.push('focus');
  if (!focus && note.ticketId === state.selectedId) cls.push('selected');

  let stamp = '';
  if (note.motivo === 'pedido' && note.kitchenStatus === 'atendido') stamp = '<div class="stamp">HECHO ✓</div>';
  if (note.motivo === 'pedido' && note.kitchenStatus === 'cancelado') stamp = '<div class="stamp">CANCEL ✕</div>';

  const rows = items.slice(0, focus ? 24 : 10).map((it) => {
    const icon = itemIcon(it.nombre + ' ' + (it.detalle || ''));
    const badge = it.need
      ? (it.pago ? '💳' : it.flete ? '$' : '⏱')
      : '';
    const text = it.label || it.detalle || it.nombre || 'Ítem';
    return `<div class="row${it.need ? ' need' : ''}" data-need="${it.need ? '1' : '0'}">
      <span class="icon">${icon}</span>
      <span class="label">${escapeHtml(text)}</span>
      ${badge ? `<span class="badge">${badge}</span>` : ''}
    </div>`;
  }).join('');

  const more = !focus && items.length > 10
    ? `<div class="row"><span class="label">+${items.length - 10} más…</span></div>`
    : '';

  return `
    <div class="hole"></div>
    <div class="tag">${escapeHtml(ticketTag(note))}</div>
    <div class="num-band"><div class="num">${escapeHtml(num)}</div></div>
    <div class="who">${escapeHtml(who)}</div>
    <div class="rows">${rows}${more}</div>
    ${stamp}
  `;
}

function sortRail(notes) {
  const rank = (n) => {
    if (n.motivo !== 'pedido') return 0;
    const s = n.kitchenStatus || 'nuevo';
    if (s === 'nuevo') return 1;
    if (s === 'preparado') return 2;
    if (s === 'atendido') return 3;
    return 4;
  };
  return [...notes].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function updateStats() {
  const wait = state.orders.filter((o) => (o.kitchenStatus || 'nuevo') === 'nuevo').length;
  const open = state.orders.filter((o) => (o.kitchenStatus || 'nuevo') === 'preparado').length;
  $('statWait').textContent = String(wait);
  $('statOpen').textContent = String(open);
  $('statCaja').textContent = String(state.caja.length);
  $('statDone').textContent = String(state.doneRail.length);
}

function fillRail(containerId, emptyId, notes) {
  const rail = $(containerId);
  const empty = $(emptyId);
  rail.innerHTML = '';
  if (!notes.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  notes.forEach((note, index) => {
    const el = document.createElement('article');
    el.className = ['ticket', ticketClass(note), note.ticketId === state.selectedId ? 'selected' : '']
      .filter(Boolean).join(' ');
    el.dataset.id = note.ticketId;
    el.innerHTML = buildTicketHtml(note, index);
    el.addEventListener('click', () => openTicket(note.ticketId));
    rail.appendChild(el);
  });
}

function renderRail() {
  fillRail('ticketRail', 'railEmpty', state.rail);
  fillRail('doneRail', 'doneEmpty', state.doneRail);
}

function allVisibleNotes() {
  return [...state.rail, ...state.doneRail];
}

async function loadAll() {
  const [board, notes] = await Promise.all([
    api('/api/orders/board'),
    api('/api/notes'),
  ]);
  state.orders = board.orders || [];
  state.caja = (notes.notes || []).filter((n) => n.motivo !== 'pedido');
  const pedidos = state.orders;
  const activos = pedidos.filter((n) => !isFinishedNote(n));
  const hechos = pedidos.filter((n) => isFinishedNote(n));
  state.rail = sortRail([...activos, ...state.caja]);
  state.doneRail = sortRail(hechos);
  updateStats();
  renderRail();

  if (state.selectedId) {
    const still = allVisibleNotes().find((n) => n.ticketId === state.selectedId);
    if (still) await openTicket(state.selectedId, false);
    else showEmpty();
  }
}

function showEmpty() {
  state.selectedId = null;
  state.detail = null;
  state.phone = null;
  $('bench').hidden = true;
  $('benchEmpty').hidden = false;
  renderRail();
}

async function openTicket(id, autoOpen = true) {
  state.selectedId = id;
  renderRail();
  try {
    const { note } = await api(`/api/notes/${id}`);
    state.detail = note;
    state.phone = note.phone;

    // Pendiente → al tocarla se "abre" sola (preparado)
    if (
      autoOpen &&
      note.motivo === 'pedido' &&
      (note.kitchenStatus || 'nuevo') === 'nuevo'
    ) {
      try {
        await api(`/api/notes/${note.ticketId}/kitchen`, {
          method: 'POST',
          body: JSON.stringify({ status: 'preparado', notifyCustomer: true }),
        });
        toast(`Comanda #${note.orderId} abierta`);
        const refreshed = await api(`/api/notes/${id}`);
        state.detail = refreshed.note;
        await loadAllQuiet();
      } catch {
        // si falla, igual mostramos el detalle
      }
    }

    renderBench(state.detail);
    await loadMessages(state.detail.phone, {
      sinceMs: state.detail.order?.createdAt || state.detail.createdAt || null,
      ticketId: state.detail.ticketId,
    });
  } catch (err) {
    toast(err.message);
  }
}

async function loadAllQuiet() {
  const [board, notes] = await Promise.all([
    api('/api/orders/board'),
    api('/api/notes'),
  ]);
  state.orders = board.orders || [];
  state.caja = (notes.notes || []).filter((n) => n.motivo !== 'pedido');
  const activos = state.orders.filter((n) => !isFinishedNote(n));
  const hechos = state.orders.filter((n) => isFinishedNote(n));
  state.rail = sortRail([...activos, ...state.caja]);
  state.doneRail = sortRail(hechos);
  updateStats();
  renderRail();
}

function renderBench(note) {
  $('benchEmpty').hidden = true;
  $('bench').hidden = false;

  const focus = $('focusTicket');
  focus.className = `ticket focus ${ticketClass(note)}`;
  focus.innerHTML = buildTicketHtml(note, 0, { focus: true });

  const isPedido = note.motivo === 'pedido';
  $('panelTitle').textContent = isPedido
    ? `Pedido #${note.orderId}`
    : ticketTag(note);
  $('panelMeta').textContent = `${note.name || 'Cliente'} · +${note.phone} · ${formatWhen(note.createdAt)}`;

  const addr = note.order?.address;
  const addrEl = $('panelAddress');
  if (addr) {
    addrEl.hidden = false;
    addrEl.textContent = /retiro/i.test(addr) ? addr : `📍 ${addr}`;
  } else {
    addrEl.hidden = true;
  }

  const tot = note.previewTotals || note.order;
  $('panelTotal').textContent = tot && (tot.totalUsd != null || tot.totalBs != null)
    ? money(tot.totalUsd ?? tot.total_usd, tot.totalBs ?? tot.total_bs)
    : '';

  renderPrepList(note);
  $('chatTitle').textContent = isPedido
    ? `💬 Chat · Pedido #${note.orderId}`
    : `💬 Chat · ${ticketTag(note)}`;
  $('chatMeta').textContent = `${note.name || 'Cliente'} · +${note.phone}`;

  renderItemActions(note);
  renderBigActions(note);
}

function renderPrepList(note) {
  const list = $('prepList');
  if (!list) return;
  const items = noteItems(note);
  if (!items.length) {
    list.innerHTML = '<li class="meta">Sin productos en esta comanda.</li>';
    return;
  }
  list.innerHTML = items.map((it) => {
    const text = it.label || it.detalle || it.nombre;
    return `<li>${itemIcon(text)} <strong>${escapeHtml(text)}</strong></li>`;
  }).join('');
}

function renderItemActions(note) {
  const box = $('itemActions');
  box.innerHTML = '';

  if (note.motivo === 'pedido') {
    const needs = noteItems(note).filter((i) => i.need);
    if (needs.length) {
      const card = document.createElement('div');
      card.className = 'need-card';
      const names = needs.map((i) => i.nombre).join(', ');
      card.innerHTML =
        `<strong>⏱ Atención: ${escapeHtml(names)}</strong>` +
        `<span style="flex-basis:100%;font-size:0.9rem">Fila amarilla = falta precio o es una consulta. Responda al cliente abajo 💬</span>`;
      box.append(card);
    }
    return;
  }

  if (note.motivo === 'pesaje' || note.motivo === 'caja') {
    const items = noteItems(note);
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'need-card';
      card.innerHTML = `<strong>${itemIcon(it.nombre)} ${escapeHtml(it.nombre)}</strong>`;
      const btnPrice = document.createElement('button');
      btnPrice.type = 'button';
      btnPrice.className = 'btn-price';
      btnPrice.textContent = '💰 Poner precio';
      btnPrice.addEventListener('click', () => askPrice(note, 'precio', it.nombre));
      const btnNo = document.createElement('button');
      btnNo.type = 'button';
      btnNo.className = 'btn-no';
      btnNo.textContent = '🚫 No hay';
      btnNo.addEventListener('click', () => markNoHay(note));
      card.append(btnPrice, btnNo);
      box.append(card);
    }
    return;
  }

  if (note.motivo === 'flete') {
    const card = document.createElement('div');
    card.className = 'need-card';
    card.innerHTML = '<strong>🛵 ¿Cuánto cuesta el envío?</strong>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-price';
    btn.textContent = '💰 Poner flete';
    btn.addEventListener('click', () => askPrice(note, 'flete', 'Flete'));
    card.append(btn);
    box.append(card);
    return;
  }

  if (note.motivo === 'pago') {
    const card = document.createElement('div');
    card.className = 'need-card';
    card.innerHTML = '<strong>💳 ¿El pago está bien?</strong>';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn-price';
    ok.textContent = 'Sí, pago OK ✅';
    ok.addEventListener('click', async () => {
      try {
        await api(`/api/notes/${note.ticketId}/pago`, { method: 'POST', body: JSON.stringify({ ok: true }) });
        toast('Pago confirmado');
        await afterResolve(note.ticketId);
      } catch (err) {
        toast(err.message);
      }
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn-no';
    no.textContent = 'Rechazar ❌';
    no.addEventListener('click', async () => {
      try {
        await api(`/api/notes/${note.ticketId}/pago`, { method: 'POST', body: JSON.stringify({ ok: false }) });
        toast('Capture rechazado');
        await afterResolve(note.ticketId);
      } catch (err) {
        toast(err.message);
      }
    });
    card.append(ok, no);
    box.append(card);
  }
}

function renderBigActions(note) {
  const box = $('bigActions');
  box.innerHTML = '';
  if (note.motivo !== 'pedido') return;

  const status = note.kitchenStatus || 'nuevo';

  if (status === 'nuevo') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn-open';
    open.textContent = '👀 Abrir comanda';
    open.addEventListener('click', () => setKitchen(note, 'preparado'));
    box.append(open);
  }

  if (status === 'nuevo' || status === 'preparado') {
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn-done';
    done.textContent = '✅ Ya está hecho';
    done.addEventListener('click', () => setKitchen(note, 'atendido'));

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-cancel';
    cancel.textContent = '❌ Cancelar';
    cancel.addEventListener('click', () => {
      if (confirm('¿Cancelar este pedido? El cliente recibirá un aviso.')) {
        setKitchen(note, 'cancelado');
      }
    });
    box.append(done, cancel);
  }

  if (status === 'atendido' || status === 'cancelado' || note.order?.status === 'cancelado') {
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'btn-reopen';
    reopen.textContent = '↩ Volver a cocina';
    reopen.addEventListener('click', () => setKitchen(note, 'preparado'));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-cancel';
    del.textContent = '🗑️ Borrar';
    del.addEventListener('click', () => deleteFinished(note));
    box.append(reopen, del);
  }
}

async function deleteFinished(note) {
  if (!confirm('¿Borrar este pedido? Ya no aparecerá en el tablero.')) return;
  try {
    await api(`/api/notes/${note.ticketId}/delete`, { method: 'POST', body: '{}' });
    toast(`Pedido #${note.orderId} borrado`);
    state.selectedId = null;
    await loadAll();
    const next = state.rail[0] || state.doneRail[0];
    if (next) await openTicket(next.ticketId, false);
    else showEmpty();
  } catch (err) {
    toast(err.message);
  }
}

async function setKitchen(note, status) {
  try {
    await api(`/api/notes/${note.ticketId}/kitchen`, {
      method: 'POST',
      body: JSON.stringify({ status, notifyCustomer: true }),
    });
    const labels = { preparado: 'Abierta', atendido: '¡Hecho!', cancelado: 'Cancelado', nuevo: 'Pendiente' };
    toast(`Pedido #${note.orderId}: ${labels[status] || status}`);
    await loadAll();
    if (allVisibleNotes().some((n) => n.ticketId === note.ticketId)) {
      await openTicket(note.ticketId, false);
    } else if (state.rail[0]) {
      await openTicket(state.rail[0].ticketId, false);
    } else if (state.doneRail[0]) {
      await openTicket(state.doneRail[0].ticketId, false);
    } else {
      showEmpty();
    }
  } catch (err) {
    toast(err.message);
  }
}

function askPrice(note, kind, label) {
  state.pendingPriceNote = { note, kind };
  $('priceTitle').textContent = kind === 'flete' ? '¿Cuánto cuesta el envío?' : '¿Cuánto cuesta?';
  $('priceHint').textContent = label ? `Precio en dólares · ${label}` : 'Escriba el precio en dólares';
  $('priceInput').value = '';
  $('priceDialog').showModal();
  setTimeout(() => $('priceInput').focus(), 50);
}

$('priceDialog').addEventListener('close', async () => {
  if ($('priceDialog').returnValue !== 'ok') {
    state.pendingPriceNote = null;
    return;
  }
  const pending = state.pendingPriceNote;
  state.pendingPriceNote = null;
  if (!pending) return;
  const usd = $('priceInput').value;
  try {
    const path = pending.kind === 'flete' ? 'flete' : 'precio';
    await api(`/api/notes/${pending.note.ticketId}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ usd }),
    });
    toast('Precio enviado al cliente');
    await afterResolve(pending.note.ticketId);
  } catch (err) {
    toast(err.message);
  }
});

$('priceOk').addEventListener('click', (e) => {
  const v = Number(String($('priceInput').value).replace(',', '.'));
  if (!(v > 0)) {
    e.preventDefault();
    toast('Escriba un precio mayor que cero');
  }
});

async function markNoHay(note) {
  if (!confirm('¿Marcar como que no hay? Se avisará al cliente.')) return;
  try {
    await api(`/api/notes/${note.ticketId}/nohay`, { method: 'POST', body: '{}' });
    toast('Avisado: no hay');
    await afterResolve(note.ticketId);
  } catch (err) {
    toast(err.message);
  }
}

async function afterResolve(ticketId) {
  await loadAll();
  if (allVisibleNotes().some((n) => n.ticketId === ticketId)) {
    await openTicket(ticketId, false);
  } else if (state.rail[0]) {
    await openTicket(state.rail[0].ticketId, false);
  } else if (state.doneRail[0]) {
    await openTicket(state.doneRail[0].ticketId, false);
  } else {
    showEmpty();
  }
}

let messagesSeq = 0;

function cleanChatText(content) {
  return String(content || '')
    .replace(/\[PEDIDO_CANCELADO\]/g, '')
    .replace(/\[sin respuesta\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadMessages(phone, { sinceMs = null, ticketId = null } = {}) {
  if (!phone) return;
  const seq = ++messagesSeq;
  const expectedTicket = ticketId || state.selectedId;
  const data = await api(`/api/chats/${phone}/messages`);
  // Evitar que una respuesta vieja pinte el chat de otro pedido.
  if (seq !== messagesSeq) return;
  if (state.phone && state.phone !== phone) return;
  if (expectedTicket && state.selectedId && expectedTicket !== state.selectedId) return;

  const box = $('messages');
  box.innerHTML = '';

  // API ya viene cronológico (viejo → nuevo).
  let msgs = Array.isArray(data.messages) ? data.messages.slice() : [];

  // Cortar desde el último pedido cancelado (este chat = este pedido).
  let start = 0;
  for (let i = 0; i < msgs.length; i += 1) {
    if (msgs[i].role === 'model' && /\[PEDIDO_CANCELADO\]/.test(msgs[i].content || '')) {
      start = i + 1;
    }
  }
  msgs = msgs.slice(start);

  if (sinceMs) {
    const fromOrder = msgs.filter((m) => Number(m.created_at || 0) >= Number(sinceMs) - 60_000);
    if (fromOrder.length) msgs = fromOrder;
  }

  msgs = msgs.filter((m) => cleanChatText(m.content));

  if (!msgs.length) {
    box.innerHTML = '<p class="meta">Sin mensajes de este pedido aún.</p>';
    return;
  }

  for (const m of msgs) {
    const text = cleanChatText(m.content);
    const div = document.createElement('div');
    const capture = /adjunt|imagen|documento|comprobante|capture|captura/i.test(text);
    div.className = `bubble ${m.role === 'user' ? 'in' : 'out'}`;
    div.textContent = `${capture ? '🧾 ' : ''}${text}`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function connectEvents() {
  if (state.es) state.es.close();
  state.es = new EventSource(apiUrl('/api/events'));
  state.es.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'hello') return;
      await loadAll();
      if (state.phone && state.detail && (data.phone === state.phone || data.alert?.phone === state.phone)) {
        await loadMessages(state.phone, {
          sinceMs: state.detail.order?.createdAt || state.detail.createdAt || null,
          ticketId: state.detail.ticketId,
        });
      }
    } catch {
      // ignore
    }
  };
  state.es.onerror = () => toast('Reconectando…', 1500);
}

$('btnRefresh').addEventListener('click', () => {
  loadAll().then(() => toast('Actualizado')).catch((e) => toast(e.message));
});

$('replyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.phone) return;
  const text = $('replyText').value.trim();
  if (!text) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api(`/api/chats/${state.phone}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
    $('replyText').value = '';
    await loadMessages(state.phone, {
      sinceMs: state.detail?.order?.createdAt || state.detail?.createdAt || null,
      ticketId: state.selectedId,
    });
    toast('Mensaje enviado');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  try {
    if (isLocalHost()) {
      const boot = await fetch('/api/bootstrap').then((r) => r.json());
      if (boot.token) {
        state.token = boot.token;
        localStorage.setItem('crmToken', state.token);
      }
    } else if (!state.token) {
      toast('Abra http://127.0.0.1:3847 en esta PC');
      return;
    }
    await loadAll();
    connectEvents();
  } catch (err) {
    toast(err.message);
    $('railEmpty').hidden = false;
    $('railEmpty').textContent = `${err.message} — Reinicie Bárbara y abra http://127.0.0.1:3847`;
  }
})();
