const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('crmToken') || '',
  phone: null,
  noteId: null,
  es: null,
  chats: [],
  notes: [],
  chatsOpen: localStorage.getItem('crmChatsOpen') === '1',
};

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

function preview(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 72) || '(sin texto)';
}

function formatWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit' });
}

function setStatus(text, ok = true) {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? '' : 'error';
}

function motivoLabel(m) {
  return ({
    pesaje: 'Pesaje', caja: 'Pesaje', flete: 'Flete', pago: 'Pago', payment: 'Pago',
    pedido: 'Pedido', order: 'Pedido',
  })[m] || m || 'Nota';
}

function kitchenLabel(s) {
  return ({ nuevo: 'Nuevo', preparado: 'Preparado', atendido: 'Atendido', cancelado: 'Cancelado' })[s] || s;
}

function syncChatsPanel() {
  $('chatsPanel').hidden = !state.chatsOpen;
  document.querySelector('.app').classList.toggle('chats-open', state.chatsOpen);
  $('btnToggleChats').textContent = state.chatsOpen ? 'Ocultar chats' : 'Chats';
  localStorage.setItem('crmChatsOpen', state.chatsOpen ? '1' : '0');
}

async function loadNotes() {
  const { notes } = await api('/api/notes');
  state.notes = notes;
  const count = $('noteCount');
  count.textContent = String(notes.length);
  count.classList.toggle('has', notes.length > 0);

  const list = $('noteList');
  if (!notes.length) {
    list.innerHTML = '<p class="empty tiny">Sin notas pendientes.</p>';
    if (state.noteId) {
      state.noteId = null;
      renderNoteDetail(null);
    }
    return;
  }

  list.innerHTML = '';
  for (const note of notes) {
    list.appendChild(buildNoteRow(note));
  }

  if (state.noteId && !notes.some((n) => n.ticketId === state.noteId)) {
    state.noteId = notes[0].ticketId;
  }
  if (!state.noteId) state.noteId = notes[0].ticketId;
  if (state.noteId) await openNote(state.noteId, false);
}

async function openNote(ticketId, refreshList = true) {
  state.noteId = ticketId;
  if (refreshList) {
    for (const el of document.querySelectorAll('.note-row')) {
      el.classList.toggle('active', el.querySelector('.note-num') && state.notes.find((n) => n.ticketId === ticketId && String(n.n) === el.querySelector('.note-num').textContent));
    }
    // simpler: reload list active state
    await loadNotesListOnly();
  }
  const data = await api(`/api/notes/${ticketId}`);
  renderNoteDetail(data.note);
  if (data.note?.phone) {
    state.phone = data.note.phone;
    if (state.chatsOpen) {
      $('replyForm').hidden = false;
      await loadMessages();
      await loadChats();
    }
  }
}

function buildNoteRow(note) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const isPedido = note.motivo === 'pedido' || note.kind === 'pedido';
  btn.className = `note-row${isPedido ? ' comanda' : ''}${note.ticketId === state.noteId ? ' active' : ''}`;
  const ask = isPedido
    ? (note.order?.address || note.items?.[0]?.detalle || `Pedido #${note.orderId}`)
    : (note.pending?.[0]?.detalle || note.items?.[0]?.detalle || note.note || motivoLabel(note.motivo));
  const badge = isPedido
    ? kitchenLabel(note.kitchenStatus || note.estado)
    : motivoLabel(note.motivo);
  const num = isPedido ? `#${note.orderId}` : String(note.n);
  btn.innerHTML =
    `<span class="note-num">${escapeHtml(num)}</span>` +
    `<div>` +
    `<div class="title"><span>${escapeHtml(note.name || ('+' + note.phone))}</span>` +
    `<span class="badge ${isPedido ? `k-${note.kitchenStatus || 'nuevo'}` : ''}">${escapeHtml(badge)}</span></div>` +
    `<div class="preview">${escapeHtml(preview(ask))} · ${formatWhen(note.createdAt)}</div>` +
    `</div>`;
  btn.addEventListener('click', () => openNote(note.ticketId));
  return btn;
}

async function loadNotesListOnly() {
  const list = $('noteList');
  list.innerHTML = '';
  for (const note of state.notes) list.appendChild(buildNoteRow(note));
}

function renderNoteDetail(note) {
  if (!note) {
    $('noteEmpty').hidden = false;
    $('noteBody').hidden = true;
    $('noteTitle').textContent = 'Seleccione una nota';
    $('noteMeta').textContent = '';
    return;
  }

  const n = state.notes.find((x) => x.ticketId === note.ticketId)?.n;
  $('noteEmpty').hidden = true;
  $('noteBody').hidden = false;
  $('noteTitle').textContent = `Nota ${n ?? ''} · ${motivoLabel(note.motivo)}`;
  $('noteMeta').textContent = `${note.name || ''} · +${note.phone} · ${note.ticketId}`;

  $('reqText').textContent = note.note || `Atender ${motivoLabel(note.motivo).toLowerCase()} para el cliente.`;
  const items = note.pending?.length ? note.pending : (note.items || []);
  $('reqItems').innerHTML = items.length
    ? items.map((i) => `<li>${escapeHtml(i.detalle || i.nombre || '')}</li>`).join('')
    : '<li>Sin detalle de ítems</li>';

  $('previewBox').textContent = note.previewMessage || 'Escriba el precio para ver el producto final.';
  $('previewTotal').textContent = note.previewTotals
    ? `Total estimado: $ ${Number(note.previewTotals.totalUsd).toFixed(2)}` +
      (note.previewTotals.totalBs != null ? ` · Bs. ${Number(note.previewTotals.totalBs).toFixed(2)}` : '')
    : '';

  const box = $('actionBlock');
  box.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'hint';

  if (note.motivo === 'pedido' || note.kind === 'pedido') {
    hint.textContent = 'Comanda del pedido cerrado. Márquela según avance en cocina/despacho (el cliente recibe un aviso breve).';
    box.append(hint);

    const track = document.createElement('div');
    track.className = 'kitchen-track';
    const steps = [
      { id: 'nuevo', label: '🆕 Nuevo' },
      { id: 'preparado', label: '🧺 Preparado' },
      { id: 'atendido', label: '🛵 Atendido' },
    ];
    const current = note.kitchenStatus || 'nuevo';
    const orderIdx = steps.findIndex((s) => s.id === current);
    track.innerHTML = steps.map((s, i) => {
      const done = i <= orderIdx;
      const active = s.id === current;
      return `<div class="k-step${done ? ' done' : ''}${active ? ' active' : ''}"><span>${s.label}</span></div>`;
    }).join('<div class="k-line"></div>');
    box.append(track);

    const row = document.createElement('div');
    row.className = 'action-row';

    const mk = (status, label, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.disabled = current === status || (status === 'preparado' && current === 'atendido');
      b.addEventListener('click', async () => {
        try {
          const r = await api(`/api/notes/${note.ticketId}/kitchen`, {
            method: 'POST',
            body: JSON.stringify({ status, notifyCustomer: true }),
          });
          setStatus(`${kitchenLabel(status)} · pedido #${note.orderId}`);
          if (r.message) $('previewBox').textContent = r.message;
          await afterNoteAction(note.phone);
        } catch (err) {
          setStatus(err.message, false);
        }
      });
      return b;
    };

    if (current === 'nuevo') row.append(mk('preparado', 'Marcar preparado', 'primary'));
    if (current === 'nuevo' || current === 'preparado') row.append(mk('atendido', 'Marcar atendido', 'primary'));
    row.append(mk('cancelado', 'Cancelar pedido', 'danger'));

    const btnChat = document.createElement('button');
    btnChat.type = 'button';
    btnChat.className = 'btn ghost';
    btnChat.textContent = 'Abrir chat';
    btnChat.addEventListener('click', async () => {
      state.chatsOpen = true;
      syncChatsPanel();
      state.phone = note.phone;
      $('replyForm').hidden = false;
      await Promise.all([loadChats(), loadMessages()]);
    });
    row.append(btnChat);
    box.append(row);

    // Sin "Descartar" genérico que confunde con cancelar cocina — el track basta.
    return;
  }

  if (note.motivo === 'pesaje' || note.motivo === 'caja') {
    hint.textContent = 'Pese en balanza e indique el monto total en USD. Abajo verá el mensaje final al cliente.';
    box.append(hint);
    const row = document.createElement('div');
    row.className = 'action-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.01';
    input.step = '0.01';
    input.placeholder = 'USD';
    input.addEventListener('input', () => debouncePreview(note.ticketId, input.value));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = 'Enviar precio';
    btn.addEventListener('click', async () => {
      try {
        const r = await api(`/api/notes/${note.ticketId}/precio`, { method: 'POST', body: JSON.stringify({ usd: input.value }) });
        setStatus('Precio enviado al cliente');
        $('previewBox').textContent = r.message || 'Enviado';
        await afterNoteAction(note.phone);
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    const btnNo = document.createElement('button');
    btnNo.type = 'button';
    btnNo.className = 'btn danger';
    btnNo.textContent = 'Sin stock';
    btnNo.addEventListener('click', async () => {
      try {
        const r = await api(`/api/notes/${note.ticketId}/nohay`, { method: 'POST', body: '{}' });
        setStatus('Cliente notificado: sin stock');
        $('previewBox').textContent = r.message || 'Enviado';
        await afterNoteAction(note.phone);
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    row.append(input, btn, btnNo);
    box.append(row);
  } else if (note.motivo === 'flete') {
    hint.textContent = 'Indique la tarifa de envío en USD para esa zona.';
    box.append(hint);
    const row = document.createElement('div');
    row.className = 'action-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.01';
    input.step = '0.01';
    input.placeholder = 'Flete USD';
    input.addEventListener('input', () => debouncePreview(note.ticketId, input.value));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = 'Confirmar flete';
    btn.addEventListener('click', async () => {
      try {
        const r = await api(`/api/notes/${note.ticketId}/flete`, { method: 'POST', body: JSON.stringify({ usd: input.value }) });
        setStatus('Flete enviado');
        $('previewBox').textContent = r.message || 'Enviado';
        await afterNoteAction(note.phone);
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    row.append(input, btn);
    box.append(row);
  } else if (note.motivo === 'pago') {
    hint.textContent = 'Revise el capture en el chat de WhatsApp y confirme o rechace el pago.';
    box.append(hint);
    const row = document.createElement('div');
    row.className = 'action-row';
    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.className = 'btn primary';
    btnOk.textContent = 'Pago OK · despachar';
    btnOk.addEventListener('click', async () => {
      try {
        const r = await api(`/api/notes/${note.ticketId}/pago`, { method: 'POST', body: JSON.stringify({ ok: true }) });
        setStatus('Pago confirmado al cliente');
        $('previewBox').textContent = r.message || 'Enviado';
        await afterNoteAction(note.phone);
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    const btnNo = document.createElement('button');
    btnNo.type = 'button';
    btnNo.className = 'btn danger';
    btnNo.textContent = 'Rechazar capture';
    btnNo.addEventListener('click', async () => {
      try {
        const r = await api(`/api/notes/${note.ticketId}/pago`, { method: 'POST', body: JSON.stringify({ ok: false }) });
        setStatus('Se pidió nuevo comprobante');
        $('previewBox').textContent = r.message || 'Enviado';
        await afterNoteAction(note.phone);
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    const btnChat = document.createElement('button');
    btnChat.type = 'button';
    btnChat.className = 'btn ghost';
    btnChat.textContent = 'Ver chat / capture';
    btnChat.addEventListener('click', async () => {
      state.chatsOpen = true;
      syncChatsPanel();
      state.phone = note.phone;
      $('replyForm').hidden = false;
      await Promise.all([loadChats(), loadMessages()]);
    });
    row.append(btnOk, btnNo, btnChat);
    box.append(row);
  } else {
    hint.textContent = 'Nota general: puede cerrarla cuando esté resuelta.';
    box.append(hint);
  }

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn ghost';
  dismiss.textContent = 'Descartar nota';
  dismiss.style.marginTop = '0.55rem';
  dismiss.addEventListener('click', async () => {
    try {
      await api(`/api/notes/${note.ticketId}/dismiss`, { method: 'POST', body: '{}' });
      setStatus('Nota cerrada');
      await afterNoteAction(note.phone);
    } catch (err) {
      setStatus(err.message, false);
    }
  });
  box.append(dismiss);
}

let previewTimer = null;
function debouncePreview(ticketId, usd) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/notes/${ticketId}?usd=${encodeURIComponent(usd || '')}`);
      $('previewBox').textContent = data.note.previewMessage || '—';
      $('previewTotal').textContent = data.note.previewTotals
        ? `Total estimado: $ ${Number(data.note.previewTotals.totalUsd).toFixed(2)}` +
          (data.note.previewTotals.totalBs != null ? ` · Bs. ${Number(data.note.previewTotals.totalBs).toFixed(2)}` : '')
        : '';
    } catch {
      // ignore while typing
    }
  }, 280);
}

async function afterNoteAction(phone) {
  await loadNotes();
  if (state.chatsOpen && phone) {
    state.phone = phone;
    await Promise.all([loadChats(), loadMessages()]);
  }
}

function needsAttention(chat) {
  return chat.lastRole === 'user' && !chat.paused;
}

async function loadChats() {
  const { chats } = await api('/api/chats');
  state.chats = chats;
  const list = $('chatList');
  if (!chats.length) {
    list.innerHTML = '<p class="empty tiny">Sin chats aún.</p>';
    return;
  }
  list.innerHTML = '';
  for (const chat of chats) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `row${chat.phone === state.phone ? ' active' : ''}`;
    const label = chat.name || `+${chat.phone}`;
    const attention = needsAttention(chat);
    btn.innerHTML =
      `<div class="title"><span>${attention ? '• ' : ''}${escapeHtml(label)}` +
      `${chat.paused ? ' <span class="badge">pausado</span>' : ''}</span>` +
      `<span class="when">${formatWhen(chat.lastAt)}</span></div>` +
      `<div class="preview">${escapeHtml(preview(chat.lastContent))}</div>`;
    btn.addEventListener('click', async () => {
      state.phone = chat.phone;
      $('replyForm').hidden = false;
      await Promise.all([loadChats(), loadMessages()]);
    });
    list.appendChild(btn);
  }
}

async function loadMessages() {
  if (!state.phone) return;
  const data = await api(`/api/chats/${state.phone}/messages`);
  $('threadName').textContent = data.name || `+${data.phone}`;
  $('threadMeta').textContent = `+${data.phone}${data.paused ? ' · pausada' : ''}`;
  const box = $('messages');
  box.innerHTML = '';
  for (const m of data.messages) {
    const div = document.createElement('div');
    div.className = `bubble ${m.role === 'user' ? 'user' : 'model'}`;
    // Capture / adjunto: resaltar
    const isCapture = /adjunt[oó]|imagen|documento|comprobante|capture|captura/i.test(m.content);
    div.innerHTML = `${isCapture ? '🧾 ' : ''}${escapeHtml(m.content)}<span class="when">${formatWhen(m.created_at)}</span>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

async function loadOrders() {
  const { orders } = await api('/api/orders/today');
  const list = $('orderList');
  if (!orders.length) {
    list.innerHTML = '<p class="empty">No hay pedidos hoy.</p>';
    return;
  }
  list.innerHTML = '';
  for (const o of orders) {
    const el = document.createElement('div');
    el.className = 'order';
    const items = (o.items || []).map((i) => `<li>${escapeHtml(i.detalle || `${i.cantidad}× ${i.nombre}`)}</li>`).join('');
    const total = o.totalBs != null ? `Bs. ${Number(o.totalBs).toFixed(2)}`
      : (o.totalUsd != null ? `$ ${Number(o.totalUsd).toFixed(2)}` : o.status);
    el.innerHTML =
      `<strong>#${o.id} · ${escapeHtml(o.name || ('+' + o.phone))}</strong>` +
      `<div class="sub">${escapeHtml(o.status)} · ${escapeHtml(total)}</div>` +
      `<ul>${items}</ul>`;
    el.addEventListener('click', async () => {
      $('ordersDialog').close();
      state.chatsOpen = true;
      syncChatsPanel();
      state.phone = o.phone;
      $('replyForm').hidden = false;
      await Promise.all([loadChats(), loadMessages()]);
    });
    list.appendChild(el);
  }
}

function connectEvents() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  state.es = new EventSource(apiUrl('/api/events'));
  state.es.onmessage = async (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === 'hello') return;
      await loadNotes();
      if (state.chatsOpen) {
        await loadChats();
        if (data.phone && data.phone === state.phone) await loadMessages();
      }
    } catch {
      // ignore
    }
  };
  state.es.onerror = () => setStatus('Reconectando…', false);
}

$('btnOrders').addEventListener('click', async () => {
  try {
    await loadOrders();
    $('ordersDialog').showModal();
  } catch (err) {
    setStatus(err.message, false);
  }
});

$('btnToggleChats').addEventListener('click', async () => {
  state.chatsOpen = !state.chatsOpen;
  syncChatsPanel();
  if (state.chatsOpen) {
    try {
      await loadChats();
      if (state.phone) {
        $('replyForm').hidden = false;
        await loadMessages();
      }
    } catch (err) {
      setStatus(err.message, false);
    }
  }
});

$('btnRefresh').addEventListener('click', async () => {
  try {
    await loadNotes();
    if (state.chatsOpen) {
      await loadChats();
      if (state.phone) await loadMessages();
    }
    setStatus(`${state.notes.length} nota(s)`);
  } catch (err) {
    setStatus(err.message, false);
  }
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
    await loadMessages();
    await loadChats();
    setStatus('Enviado · Bárbara pausada 5 min');
  } catch (err) {
    setStatus(err.message, false);
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
      setStatus('Abra el panel en esta misma PC: http://127.0.0.1:3847', false);
      return;
    }
    syncChatsPanel();
    await loadNotes();
    if (state.chatsOpen) await loadChats();
    connectEvents();
    setStatus(`${state.notes.length} nota(s) · listo`);
  } catch (err) {
    setStatus(err.message, false);
    $('noteList').innerHTML = `<p class="empty error">${escapeHtml(err.message)}<br><br>Reinicie Bárbara y abra http://127.0.0.1:3847</p>`;
  }
})();
