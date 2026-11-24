/**
 * Textos de los menús de WhatsApp. Cámbielos aquí; el resto del programa solo usa estos rótulos.
 * Límites de la Cloud API: botón ≤20, fila ≤24, descripción ≤72, 3 botones, 10 filas.
 */

export const LIMITS = {
  buttonTitle: 20,
  listTitle: 24,
  listDescription: 72,
  maxButtons: 3,
  maxRows: 10,
  pageSize: 7,
};

export const LABELS = {
  verProductos: 'Ver productos',
  hacerPedido: 'Hacer pedido',
  miPedido: 'Mi pedido',
  asesor: 'Hablar con un asesor',
  verMas: 'Ver más',
  cantidad1: '1',
  cantidad2: '2',
  otraCantidad: 'Otra cantidad',
  agregarOtro: 'Agregar otro',
  esTodo: 'Ya es todo',
  volver: '⬅️ Volver',
  buscar: '🔎 Buscar',
  quitar: 'Quitar uno',
  delivery: 'Delivery',
  retiro: 'Retiro en tienda',
  usarDireccion: 'Usar esta dirección',
  otraDireccion: 'Otra dirección',
  yaPague: 'Ya pagué',
  modificar: 'Modificar pedido',
  cancelar: 'Cancelar pedido',
  pagoOk: 'Pago verificado',
  pagoNo: 'Rechazar',
  hay: 'Hay',
  noHay: 'No hay',
};

export function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trim()}…`;
}

export function slug(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function moneyLine(usd, rate) {
  const dollars = `$ ${Number(usd).toFixed(2)}`;
  if (!(rate > 0)) return dollars;
  return `${dollars} · Bs. ${(Number(usd) * rate).toFixed(2)}`;
}

function option(id, title, description = '', titleMax = LIMITS.listTitle) {
  return {
    id: String(id).slice(0, 200),
    title: clip(title, titleMax),
    description: description ? clip(description, LIMITS.listDescription) : '',
  };
}

export function buttonMenu(body, buttons) {
  return {
    kind: 'buttons',
    body: String(body || '').slice(0, 1024),
    options: buttons.slice(0, LIMITS.maxButtons).map((button) => option(button.id, button.title, '', LIMITS.buttonTitle)),
  };
}

export function listMenu(body, rows) {
  return {
    kind: 'list',
    body: String(body || '').slice(0, 1024),
    options: rows.slice(0, LIMITS.maxRows).map((row) => option(row.id, row.title, row.description || '')),
  };
}

export function mainMenu() {
  return listMenu('¿En qué le puedo ayudar?', [
    { id: 'menu:productos', title: LABELS.verProductos },
    { id: 'menu:pedido', title: LABELS.hacerPedido },
    { id: 'menu:mipedido', title: LABELS.miPedido },
    { id: 'menu:asesor', title: LABELS.asesor },
  ]);
}

export function groupName(product) {
  const name = String(product?.nombre || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (name.startsWith('harina')) return 'Harinas';
  return product?.categoria || 'Otros';
}

function controls({ moreId = null, backId = 'menu:back' } = {}) {
  const rows = [];
  if (moreId) rows.push({ id: moreId, title: LABELS.verMas });
  rows.push({ id: 'menu:todo', title: LABELS.esTodo });
  rows.push({ id: backId, title: LABELS.volver });
  return rows;
}

export function categoryMenu(products) {
  const names = [...new Set((products || []).map(groupName))];
  const room = LIMITS.maxRows - 3;
  const rows = names.slice(0, room).map((name) => ({
    id: `menu:cat:${slug(name)}`,
    title: name,
  }));
  rows.push({ id: 'menu:buscar', title: LABELS.buscar });
  rows.push(...controls());
  return listMenu('Estas son las categorías. Elija una:', rows);
}

export function productMenu(products, group, page = 0, rate = 0) {
  const all = (products || []).filter((product) => slug(groupName(product)) === slug(group));
  const more = (all.length - page * LIMITS.pageSize) > LIMITS.pageSize;
  const reserved = more ? 3 : 2;
  const room = LIMITS.maxRows - reserved;
  const start = page * LIMITS.pageSize;
  const slice = all.slice(start, start + room);
  const rows = slice.map((product) => ({
    id: `menu:sku:${product.sku}`,
    title: product.nombre,
    description: `${product.presentacion} · ${moneyLine(product.precio, rate)}`,
  }));
  rows.push(...controls({
    moreId: more ? `menu:page:${slug(group)}:${page + 1}` : null,
  }));
  return listMenu(page ? `Más productos de ${group}:` : `Productos de ${group}:`, rows);
}

export function matchMenu(products, rate = 0) {
  const all = products || [];
  const rows = all.slice(0, LIMITS.maxRows - 2).map((product) => ({
    id: `menu:sku:${product.sku}`,
    title: product.nombre,
    description: `${product.presentacion} · ${moneyLine(product.precio, rate)}`,
  }));
  rows.push(...controls());
  return listMenu('Encontré varias opciones. ¿Cuál desea?', rows);
}

export function quantityMenu(productName) {
  return listMenu(`¿Cuántos de ${productName}?`, [
    { id: 'menu:qty:1', title: LABELS.cantidad1 },
    { id: 'menu:qty:2', title: LABELS.cantidad2 },
    { id: 'menu:qty:otra', title: LABELS.otraCantidad },
    { id: 'menu:back', title: LABELS.volver },
  ]);
}

export function modifyMenu(order) {
  const rows = (order?.items || []).slice(0, 6).map((item, index) => ({
    id: `menu:edit:${index}`,
    title: item.nombre,
    description: `Lleva ${item.cantidad}. Toque para cambiar la cantidad.`,
  }));
  rows.push({ id: 'menu:otro', title: LABELS.agregarOtro });
  rows.push({ id: 'menu:quitar', title: LABELS.quitar });
  rows.push({ id: 'menu:todo', title: LABELS.esTodo });
  rows.push({ id: 'menu:back', title: LABELS.volver });
  return listMenu('¿Qué desea modificar?', rows.slice(0, LIMITS.maxRows));
}

export function removeMenu(order) {
  const rows = (order?.items || []).slice(0, LIMITS.maxRows - 1).map((item, index) => ({
    id: `menu:drop:${index}`,
    title: item.nombre,
    description: `Quitar ${item.cantidad}`,
  }));
  rows.push({ id: 'menu:back', title: LABELS.volver });
  return listMenu('¿Cuál producto quito del pedido?', rows);
}

export function afterAddMenu() {
  return buttonMenu('¿Qué desea hacer ahora?', [
    { id: 'menu:otro', title: LABELS.agregarOtro },
    { id: 'menu:mipedido', title: LABELS.miPedido },
    { id: 'menu:todo', title: LABELS.esTodo },
  ]);
}

export function deliveryMenu(savedAddress) {
  if (savedAddress) {
    return listMenu('¿La enviamos a la dirección guardada?', [
      { id: 'menu:dir:usar', title: LABELS.usarDireccion, description: savedAddress },
      { id: 'menu:dir:otra', title: LABELS.otraDireccion },
      { id: 'menu:retiro', title: LABELS.retiro },
      { id: 'menu:back', title: LABELS.volver },
    ]);
  }
  return buttonMenu('¿Cómo lo entregamos?', [
    { id: 'menu:delivery', title: LABELS.delivery },
    { id: 'menu:retiro', title: LABELS.retiro },
    { id: 'menu:back', title: 'Volver' },
  ]);
}

export function boletaMenu() {
  return buttonMenu('Su boleta está lista. ¿Qué desea hacer?', [
    { id: 'menu:pague', title: LABELS.yaPague },
    { id: 'menu:modificar', title: LABELS.modificar },
    { id: 'menu:cancelar', title: LABELS.cancelar },
  ]);
}

export function advisorPaymentMenu(orderId) {
  return buttonMenu(`Pedido #${orderId}: ¿el pago está verificado?`, [
    { id: `pago:ok:${orderId}`, title: LABELS.pagoOk },
    { id: `pago:no:${orderId}`, title: LABELS.pagoNo },
  ]);
}

export function advisorStockMenu(orderId) {
  return buttonMenu(`Pedido #${orderId}: ¿hay ese producto?`, [
    { id: `stock:si:${orderId}`, title: LABELS.hay },
    { id: `stock:no:${orderId}`, title: LABELS.noHay },
  ]);
}

export function validateMenu(menu) {
  const errors = [];
  const options = menu?.options || [];
  const max = menu?.kind === 'buttons' ? LIMITS.maxButtons : LIMITS.maxRows;
  const titleMax = menu?.kind === 'buttons' ? LIMITS.buttonTitle : LIMITS.listTitle;
  if (options.length > max) errors.push(`más de ${max} opciones`);
  if (!options.length) errors.push('menú vacío');
  for (const row of options) {
    if (String(row.title || '').length > titleMax) errors.push(`título largo: ${row.title}`);
    if (String(row.description || '').length > LIMITS.listDescription) errors.push(`descripción larga: ${row.id}`);
    if (!row.id) errors.push('opción sin id');
  }
  return errors;
}

export function parseInteractive(message) {
  const button = message?.interactive?.button_reply;
  const list = message?.interactive?.list_reply;
  const id = button?.id || list?.id || null;
  if (!id) return null;
  return { id: String(id), title: String(button?.title || list?.title || '') };
}

export function choiceFromText(text, menu) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^(menu:|pago:|stock:)/.test(raw)) return raw;
  if (!menu?.options?.length || !/^\d{1,2}$/.test(raw)) return null;
  return menu.options[Number(raw) - 1]?.id || null;
}

export function renderMenuText(menu) {
  if (!menu?.options?.length) return '';
  const lines = [menu.body, ''];
  menu.options.forEach((row, index) => {
    const extra = row.description ? ` — ${row.description}` : '';
    lines.push(`${index + 1}. ${row.title}${extra}  [${row.id}]`);
  });
  lines.push('', 'Responda con el número.');
  return lines.join('\n');
}

/** Un solo texto: si la nota y el cuerpo del menú dicen lo mismo, no se repite. */
export function mergeMenuText(text, menu) {
  if (!menu?.options?.length) return String(text || '').trim();
  const note = String(text || '').trim();
  const body = String(menu.body || '').trim();
  const merged = !note
    ? body
    : (!body || note === body || note.includes(body) || body.includes(note))
      ? (note.length >= body.length ? note : body)
      : `${note}\n\n${body}`;
  return renderMenuText({ ...menu, body: merged });
}

export function withMenu(text, menu) {
  return mergeMenuText(text, menu);
}
