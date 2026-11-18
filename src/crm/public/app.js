const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('crmToken') || '',
  phone: null,
  es: null,
  chats: [],
  alerts: [],
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
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 64) || '(sin texto)';
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

function needsAttention(chat) {
  return chat.lastRole === 'user' && !chat.paused;
}

async function loadChats() {
  const { chats } = await api('/api/chats');
  state.chats = chats;
  const list = $('chatList');
  if (!chats.length) {
    list.innerHTML = '<p class="empty">No hay conversaciones todavía.<br>Cuando un cliente escriba por WhatsApp, aparece aquí.</p>';
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
      `<div class="title"><span>${attention ? '<span class="dot"></span>' : ''}${escapeHtml(label)}` +
      `${chat.paused ? ' <span class="badge">pausado</span>' : ''}</span>` +
      `<span class="when">${formatWhen(chat.lastAt)}</span></div>` +
      `<div class="preview">${escapeHtml(preview(chat.lastContent))}</div>`;
    btn.addEventListener('click', () => openChat(chat.phone));
    list.appendChild(btn);
  }
}

async function loadAlerts() {
  const { alerts } = await api('/api/alerts');
  state.alerts = alerts;
  const count = $('alertCount');
  count.textContent = String(alerts.length);
  count.classList.toggle('has', alerts.length > 0);

  const list = $('alertList');
  if (!alerts.length) {
    list.innerHTML = '<p class="empty tiny">Sin pendientes de caja.</p>';
    return;
  }

  list.innerHTML = '';
  for (const a of alerts) {
    const card = document.createElement('div');
    card.className = 'alert-card';
    const isWeigh = a.kind === 'weigh' && a.phone;
    card.innerHTML =
      `<div class="kind">${escapeHtml(a.title || a.kind)} · ${formatWhen(a.created_at)}</div>` +
      `<div class="body">${escapeHtml(a.body)}</div>` +
      `<div class="alert-actions" data-id="${a.id}" data-phone="${escapeHtml(a.phone || '')}" data-kind="${escapeHtml(a.kind)}"></div>`;

    const actions = card.querySelector('.alert-actions');
    if (isWeigh) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0.01';
      input.step = '0.01';
      input.placeholder = 'USD';
      input.setAttribute('aria-label', 'Precio en dólares');

      const btnPrice = document.createElement('button');
      btnPrice.type = 'button';
      btnPrice.className = 'primary';
      btnPrice.textContent = 'Confirmar';
      btnPrice.addEventListener('click', async () => {
        try {
          await api(`/api/caja/${a.phone}/precio`, {
            method: 'POST',
            body: JSON.stringify({ usd: input.value }),
          });
          setStatus(`Precio enviado a +${a.phone}`);
          if (state.phone === a.phone) await loadMessages();
          await Promise.all([loadAlerts(), loadChats()]);
        } catch (err) {
          setStatus(err.message, false);
        }
      });

      const btnNo = document.createElement('button');
      btnNo.type = 'button';
      btnNo.textContent = 'No hay';
      btnNo.addEventListener('click', async () => {
        try {
          await api(`/api/caja/${a.phone}/nohay`, { method: 'POST', body: '{}' });
          setStatus(`Aviso enviado a +${a.phone}`);
          if (state.phone === a.phone) await loadMessages();
          await Promise.all([loadAlerts(), loadChats()]);
        } catch (err) {
          setStatus(err.message, false);
        }
      });

      actions.append(input, btnPrice, btnNo);
    }

    if (a.phone) {
      const btnOpen = document.createElement('button');
      btnOpen.type = 'button';
      btnOpen.textContent = 'Chat';
      btnOpen.addEventListener('click', () => openChat(a.phone));
      actions.append(btnOpen);
    }

    const btnDone = document.createElement('button');
    btnDone.type = 'button';
    btnDone.textContent = 'Listo';
    btnDone.addEventListener('click', async () => {
      try {
        await api(`/api/alerts/${a.id}/done`, { method: 'POST', body: '{}' });
        await loadAlerts();
      } catch (err) {
        setStatus(err.message, false);
      }
    });
    actions.append(btnDone);

    list.appendChild(card);
  }
}

async function openChat(phone) {
  state.phone = phone;
  $('replyForm').hidden = false;
  await Promise.all([loadChats(), loadMessages()]);
}

async function loadMessages() {
  if (!state.phone) return;
  const data = await api(`/api/chats/${state.phone}/messages`);
  $('threadName').textContent = data.name || `+${data.phone}`;
  $('threadMeta').textContent = `+${data.phone}${data.paused ? ' · Bárbara pausada' : ''}`;
  const box = $('messages');
  box.innerHTML = '';
  if (!data.messages.length) {
    box.innerHTML = '<p class="empty">Sin mensajes en este chat.</p>';
    return;
  }
  for (const m of data.messages) {
    const div = document.createElement('div');
    div.className = `bubble ${m.role === 'user' ? 'user' : 'model'}`;
    div.innerHTML = `${escapeHtml(m.content)}<span class="when">${formatWhen(m.created_at)}</span>`;
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
    el.addEventListener('click', () => {
      $('ordersDialog').close();
      openChat(o.phone);
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
      await Promise.all([loadChats(), loadAlerts()]);
      if (data.phone && data.phone === state.phone) await loadMessages();
      if (data.alert?.phone && data.alert.phone === state.phone) await loadMessages();
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

$('btnRefresh').addEventListener('click', async () => {
  try {
    await Promise.all([loadChats(), loadAlerts()]);
    if (state.phone) await loadMessages();
    setStatus(`${state.chats.length} chat(s) · ${state.alerts.length} alerta(s)`);
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
    await Promise.all([loadChats(), loadAlerts()]);
    connectEvents();
    setStatus(`${state.chats.length} chat(s) · ${state.alerts.length} alerta(s)`);
    const first = state.chats.find(needsAttention) || state.chats[0];
    if (first) await openChat(first.phone);
  } catch (err) {
    setStatus(err.message, false);
    $('chatList').innerHTML = `<p class="empty error">${escapeHtml(err.message)}<br><br>¿Reinició Bárbara después de instalar el CRM?<br>Abra exactamente: http://127.0.0.1:3847</p>`;
  }
})();
