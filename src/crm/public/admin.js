const $ = (id) => document.getElementById(id);
const token = () => localStorage.getItem('crmToken') || '';

function apiUrl(path) {
  const url = new URL(path, location.origin);
  if (token()) url.searchParams.set('token', token());
  return url;
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { 'x-crm-token': token() } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(view) {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('on', button.dataset.view === view);
  });
  $('view-cocina').hidden = view !== 'cocina';
  for (const name of ['probar', 'uso', 'clientes', 'productos', 'ventas']) {
    $(`view-${name}`).hidden = name !== view;
  }
  if (view === 'uso') loadUsage();
  if (view === 'clientes') loadCustomers();
  if (view === 'productos') loadProducts();
  if (view === 'ventas') loadSales('day');
  if (view === 'probar') loadSimOrder();
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) show(button.dataset.view);
});

function addBubble(role, text) {
  const log = $('simLog');
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showMenu(menu) {
  const box = $('simMenu');
  box.innerHTML = '';
  for (const option of menu?.options || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.description ? `${option.title} · ${option.description}` : option.title;
    button.addEventListener('click', () => sendSim(option.id));
    box.appendChild(button);
  }
}

async function sendSim(text, extra = {}) {
  const phone = $('simPhone').value.trim();
  const name = $('simName').value.trim();
  if (text) addBubble('user', text.startsWith('menu:') ? text : text);
  const data = await api('/api/simulator/turn', {
    method: 'POST',
    body: JSON.stringify({ phone, name, text, ...extra }),
  });
  if (data.reply) addBubble('bot', data.reply);
  showMenu(data.menu);
  await loadSimOrder();
}

$('simForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('simText').value.trim();
  if (!text) return;
  $('simText').value = '';
  try { await sendSim(text); } catch (err) { addBubble('bot', err.message); }
});

$('simPin').addEventListener('click', () => sendSim('', { location: { lat: 10.4806, lng: -66.9036 } }).catch((err) => addBubble('bot', err.message)));

$('simReset').addEventListener('click', async () => {
  await api('/api/simulator/reset', { method: 'POST', body: JSON.stringify({ phone: $('simPhone').value.trim() }) });
  $('simLog').innerHTML = '';
  $('simMenu').innerHTML = '';
  addBubble('bot', 'Listo. La prueba empieza de cero.');
  await loadSimOrder();
});

async function loadSimOrder() {
  const data = await api(`/api/simulator/pedido?phone=${encodeURIComponent($('simPhone').value.trim())}`);
  const order = data.order;
  $('simOrder').textContent = !order?.items?.length
    ? 'Todavía no hay pedido.'
    : `#${order.id} · ${order.lifecycle || order.status}\n${order.items.map((item) => `${item.cantidad} x ${item.nombre}`).join('\n')}`;
}

async function simPay(ok) {
  const data = await api('/api/simulator/pago', {
    method: 'POST',
    body: JSON.stringify({ phone: $('simPhone').value.trim(), ok }),
  });
  if (data.reply) addBubble('bot', data.reply);
  await loadSimOrder();
}

$('simPayOk').addEventListener('click', () => simPay(true).catch((err) => addBubble('bot', err.message)));
$('simPayNo').addEventListener('click', () => simPay(false).catch((err) => addBubble('bot', err.message)));

async function simStock(hay) {
  const data = await api('/api/simulator/stock', {
    method: 'POST',
    body: JSON.stringify({
      phone: $('simPhone').value.trim(),
      producto: $('simProduct').value.trim(),
      precio: $('simPrice').value.trim(),
      hay,
    }),
  });
  if (data.reply) addBubble('bot', data.reply);
  await loadSimOrder();
}

$('simHay').addEventListener('click', () => simStock(true).catch((err) => addBubble('bot', err.message)));
$('simNoHay').addEventListener('click', () => simStock(false).catch((err) => addBubble('bot', err.message)));

function monthNow() {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit' }).format(new Date());
}

async function loadUsage() {
  if (!$('usageMonth').value) $('usageMonth').value = monthNow();
  const month = $('usageMonth').value;
  $('usageCsv').href = apiUrl(`/api/usage.csv?month=${month}`).toString();
  const report = await api(`/api/usage?month=${month}`);
  const cost = report.totals.cost;
  $('usageTotal').textContent = `Total ${report.month}: $${cost.total.toFixed(4)} (WhatsApp $${cost.whatsapp.toFixed(4)} + Gemini $${cost.gemini.toFixed(4)})`;
  const rows = report.clients.map((row) => `<tr>
    <td>${escapeHtml(row.phone)}</td>
    <td>${row.inbound}</td><td>${row.outboundBot}</td><td>${row.outboundSeller}</td><td>${row.template}</td>
    <td>${row.geminiCalls}</td><td>${row.inputTokens}</td><td>${row.outputTokens}</td><td>${row.embeddingCalls}</td>
    <td>$${row.cost.total.toFixed(4)}</td>
  </tr>`).join('');
  $('usageTable').innerHTML = `<table class="table"><thead><tr>
    <th>Teléfono</th><th>Entran</th><th>Bárbara</th><th>Vendedor</th><th>Plantilla</th>
    <th>Gemini</th><th>Tokens in</th><th>Tokens out</th><th>Embeddings</th><th>Costo</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="10">Sin uso facturable este mes.</td></tr>'}</tbody></table>`;
}

$('usageLoad').addEventListener('click', () => loadUsage().catch((err) => { $('usageTotal').textContent = err.message; }));

async function loadCustomers() {
  const data = await api('/api/customers');
  const rows = data.customers.map((row) => {
    const address = (row.addresses || []).map((item) => item?.text || item?.label || item).filter(Boolean).join(' · ');
    const state = row.blocked ? (row.blocked.reason === 'manual' ? 'Bloqueado a mano' : 'Bloqueado por spam') : 'Libre';
    return `<tr>
      <td>${escapeHtml(row.name || '')}<br>+${escapeHtml(row.phone)}</td>
      <td>${row.orders}</td>
      <td>$${Number(row.spent).toFixed(2)}</td>
      <td>${escapeHtml(address || row.notes || '')}</td>
      <td>${state}</td>
      <td>
        <button type="button" data-block="${escapeHtml(row.phone)}">Bloquear</button>
        <button type="button" data-unblock="${escapeHtml(row.phone)}">Desbloquear</button>
      </td>
    </tr>`;
  }).join('');
  $('customerTable').innerHTML = `<table class="table"><thead><tr>
    <th>Cliente</th><th>Pedidos</th><th>Comprado</th><th>Dirección</th><th>Estado</th><th></th>
  </tr></thead><tbody>${rows || '<tr><td colspan="6">No hay clientes.</td></tr>'}</tbody></table>`;
}

$('customerTable').addEventListener('click', async (event) => {
  const block = event.target.dataset.block;
  const unblock = event.target.dataset.unblock;
  if (!block && !unblock) return;
  const phone = block || unblock;
  await api(`/api/customers/${phone}/${block ? 'block' : 'unblock'}`, { method: 'POST', body: '{}' });
  await loadCustomers();
});

async function loadProducts() {
  const q = $('productQuery').value.trim();
  const data = await api(`/api/products?q=${encodeURIComponent(q)}`);
  const rows = data.products.map((row) => `<tr>
    <td>${escapeHtml(row.nombre)}</td><td>${escapeHtml(row.categoria || '')}</td>
    <td>${escapeHtml(row.presentacion || '')}</td><td>$${Number(row.precio || 0).toFixed(2)}</td>
    <td>${row.stock == null ? '—' : row.stock}</td>
  </tr>`).join('');
  $('productTable').innerHTML = `<table class="table"><thead><tr>
    <th>Producto</th><th>Categoría</th><th>Presentación</th><th>Precio</th><th>Stock</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="5">Nada con ese nombre.</td></tr>'}</tbody></table>`;
  const ledger = await api('/api/stock-pendiente');
  $('ledgerNote').textContent = ledger.aviso;
  const lines = ledger.rows.map((row) => `<tr>
    <td>#${row.order_id} +${escapeHtml(row.phone)}</td>
    <td>${escapeHtml(row.action)}</td>
    <td>${escapeHtml((row.lines || []).map((line) => `${line.cantidad} ${line.nombre}`).join(', '))}</td>
  </tr>`).join('');
  $('ledgerTable').innerHTML = `<table class="table"><thead><tr><th>Pedido</th><th>Acción</th><th>Líneas</th></tr></thead><tbody>${lines || '<tr><td colspan="3">Nada pendiente.</td></tr>'}</tbody></table>`;
}

$('productLoad').addEventListener('click', () => loadProducts().catch((err) => { $('ledgerNote').textContent = err.message; }));

async function loadSales(range) {
  const data = await api(`/api/ventas?range=${range}`);
  $('salesTotal').textContent = `${data.pedidos} pedidos · ${data.pagados} pagados · ${data.cancelados} cancelados · $ ${Number(data.totalUsd).toFixed(2)} · Bs. ${Number(data.totalBs).toFixed(2)}`;
}

document.querySelector('#view-ventas').addEventListener('click', (event) => {
  const range = event.target.dataset.range;
  if (range) loadSales(range).catch((err) => { $('salesTotal').textContent = err.message; });
});
