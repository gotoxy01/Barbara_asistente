import * as db from '../db.js';
import { getProducts, searchProducts } from './catalogService.js';
import {
  advisorPaymentMenu,
  advisorStockMenu,
  afterAddMenu,
  boletaMenu,
  categoryMenu,
  choiceFromText,
  deliveryMenu,
  groupName,
  mainMenu,
  matchMenu,
  mergeMenuText,
  modifyMenu,
  productMenu,
  quantityMenu,
  removeMenu,
  slug,
} from '../menus.js';
import { getBcvRate } from './bcvService.js';
import { renderBoleta, renderPagoMovil } from './orderService.js';

const sessions = new Map();

export function rememberMenu(phone, session) {
  sessions.set(phone, session);
}

export function lastMenu(phone) {
  return sessions.get(phone) || null;
}

function blankOrder() {
  return { items: [], address: null, fulfillment: null, payment_reference: null, lifecycle: 'borrador' };
}

function findProduct(products, sku) {
  return (products || []).find((product) => product.sku === sku) || null;
}

function setItemQty(order, product, qty, mode) {
  const next = { ...(order || blankOrder()), items: (order?.items || []).map((item) => ({ ...item })) };
  const existing = next.items.find((item) => item.sku === product.sku || item.nombre === product.nombre);
  if (mode === 'replace') {
    if (existing) existing.cantidad = qty;
    else {
      next.items.push({
        sku: product.sku, nombre: product.nombre, presentacion: product.presentacion,
        precio: Number(product.precio), cantidad: qty,
      });
    }
    return { order: next, note: `Listo, ahora lleva ${qty} x ${product.nombre}.` };
  }
  if (existing) {
    const had = Number(existing.cantidad);
    existing.cantidad = had + qty;
    return { order: next, note: `Ya tenía ${had}, ahora lleva ${existing.cantidad} x ${product.nombre}.` };
  }
  next.items.push({
    sku: product.sku, nombre: product.nombre, presentacion: product.presentacion,
    precio: Number(product.precio), cantidad: qty,
  });
  return { order: next, note: `Anoté ${qty} x ${product.nombre}.` };
}

function orderText(order) {
  if (!order?.items?.length) return 'Todavía no tiene productos anotados.';
  const lines = order.items.map((item) => `• ${item.cantidad} x ${item.nombre} (${item.presentacion})`);
  const where = order.address ? `\n\nDirección: ${order.address}` : '';
  return `En su pedido va:\n${lines.join('\n')}${where}`;
}

function boletaText(order, rate) {
  const body = renderBoleta(order.items, rate ? { rate } : null, { pickup: order.fulfillment === 'pickup' });
  const address = order.address ? `\n\n📍 *Dirección de entrega:* ${order.address}` : '';
  const pickup = order.fulfillment === 'pickup' ? '\n\n🏪 Retiro en tienda' : '';
  return `${body}${address}${pickup}\n\n${renderPagoMovil()}`;
}

function done(session, menu, text, order, extra = {}) {
  const rendered = menu ? mergeMenuText(text, menu) : String(text || '');
  const shown = menu ? { ...menu } : null;
  return {
    handled: true,
    session: {
      ...session,
      menu: shown,
      awaiting: extra.awaiting === undefined ? null : extra.awaiting,
      sku: extra.sku !== undefined ? extra.sku : session.sku ?? null,
      mode: extra.mode !== undefined ? extra.mode : (session.mode || 'add'),
      back: extra.back !== undefined ? extra.back : session.back || null,
      group: extra.group !== undefined ? extra.group : session.group || null,
      page: extra.page !== undefined ? extra.page : session.page || 0,
    },
    menu: shown,
    text: rendered,
    order,
    escalate: Boolean(extra.escalate),
    advisor: extra.advisor || null,
  };
}

/**
 * Un toque o un número del último menú. Si no corresponde a un menú, devuelve null
 * y el texto libre sigue por el camino de siempre.
 */
export function reduceMenu(session, input, ctx = {}) {
  const products = ctx.products || [];
  const rate = Number(ctx.rate) || 0;
  let order = ctx.order?.items ? { ...ctx.order, items: ctx.order.items.map((item) => ({ ...item })) } : blankOrder();
  const current = session || { menu: null, awaiting: null, sku: null };
  const raw = String(input || '').trim();
  const id = choiceFromText(raw, current.menu);

  if (!id && current.awaiting === 'cantidad') {
    const qty = Number(raw.replace(',', '.'));
    const product = findProduct(products, current.sku);
    if (!(qty > 0) || !product) return done(current, quantityMenu(product?.nombre || 'ese producto'), 'Indique un número mayor que cero.', order, { awaiting: 'cantidad', sku: current.sku });
    const placed = setItemQty(order, product, qty, current.mode);
    return done(current, afterAddMenu(), placed.note, placed.order, { mode: 'add' });
  }

  if (!id && current.awaiting === 'buscar') {
    const matches = ctx.matches || [];
    if (!ctx.matches) return { handled: false, needsSearch: true, query: raw, session: current, order };
    if (!matches.length) return done(current, categoryMenu(products), 'No encontré ese nombre. Elija una categoría o busque de nuevo.', order, { back: 'main' });
    return done(current, matchMenu(matches, rate), '', order, { back: 'cats', mode: 'add' });
  }

  if (!id && current.awaiting === 'direccion') {
    order = { ...order, address: raw, fulfillment: 'delivery' };
    return done(current, boletaMenu(), boletaText(order, rate), order);
  }

  if (!id && current.awaiting === 'referencia') {
    order = { ...order, payment_reference: raw, lifecycle: 'pago_reportado' };
    return done(current, null, `Recibimos la referencia *${raw}*. El pago queda en verificación; un asesor lo confirma con el banco.`, order, {
      advisor: advisorPaymentMenu(ctx.orderId || order.id || ''),
    });
  }

  if (!id) return null;

  if (id === 'menu:productos' || id === 'menu:pedido' || id === 'menu:otro') {
    return done(current, categoryMenu(products), '', order, { back: 'main', mode: 'add' });
  }
  if (id === 'menu:modificar') {
    return done(current, modifyMenu(order), '', order, { back: 'boleta', mode: 'replace' });
  }
  if (id === 'menu:quitar') {
    return done(current, removeMenu(order), '', order, { back: 'modify' });
  }
  if (id.startsWith('menu:edit:')) {
    const item = order.items[Number(id.slice('menu:edit:'.length))];
    if (!item) return done(current, modifyMenu(order), 'Ese producto ya no está en el pedido.', order, { back: 'boleta' });
    return done(current, quantityMenu(item.nombre), `Ahora lleva ${item.cantidad}. La cantidad nueva reemplaza la anterior.`, order, {
      sku: item.sku, mode: 'replace', back: 'modify',
    });
  }
  if (id.startsWith('menu:drop:')) {
    const index = Number(id.slice('menu:drop:'.length));
    const item = order.items[index];
    if (!item) return done(current, modifyMenu(order), '', order, { back: 'boleta' });
    order = { ...order, items: order.items.filter((_, itemIndex) => itemIndex !== index) };
    return done(current, modifyMenu(order), `Quité ${item.nombre}.`, order, { back: 'boleta', mode: 'replace' });
  }
  if (id === 'menu:buscar') {
    return done(current, null, 'Escriba el nombre de lo que busca.', order, { awaiting: 'buscar', back: 'cats' });
  }
  if (id === 'menu:back') {
    return goBack(current, products, rate, order);
  }
  if (id === 'menu:mipedido') {
    return done(current, order.items.length ? boletaMenu() : mainMenu(), orderText(order), order);
  }
  if (id === 'menu:asesor') {
    return done(current, null, 'Con gusto. Un asesor de *Abasto Los Cuchos* le atiende en breve.', order, { escalate: true });
  }
  if (id.startsWith('menu:cat:')) {
    const group = id.slice('menu:cat:'.length);
    const title = [...new Set(products.map(groupName))].find((name) => slug(name) === group) || group;
    return done(current, productMenu(products, title, 0, rate), '', order, { back: 'cats', group: title, page: 0, mode: 'add' });
  }
  if (id.startsWith('menu:page:')) {
    const rest = id.slice('menu:page:'.length);
    const splitAt = rest.lastIndexOf(':');
    const group = rest.slice(0, splitAt);
    const page = Number(rest.slice(splitAt + 1)) || 0;
    const title = [...new Set(products.map(groupName))].find((name) => slug(name) === group) || group;
    return done(current, productMenu(products, title, page, rate), '', order, {
      back: page > 0 ? `page:${group}:${page - 1}` : 'cats',
      group: title,
      page,
      mode: 'add',
    });
  }
  if (id.startsWith('menu:sku:')) {
    const product = findProduct(products, id.slice('menu:sku:'.length));
    if (!product) return done(current, categoryMenu(products), 'No encontré ese producto. Elija de nuevo.', order);
    return done(current, quantityMenu(product.nombre), `${product.nombre} (${product.presentacion}).`, order, {
      sku: product.sku, mode: current.mode === 'replace' ? 'replace' : 'add', back: 'products',
    });
  }
  if (id === 'menu:qty:1' || id === 'menu:qty:2') {
    const product = findProduct(products, current.sku);
    if (!product) return done(current, categoryMenu(products), 'Primero elija un producto.', order, { back: 'main' });
    const qty = id.endsWith('2') ? 2 : 1;
    const placed = setItemQty(order, product, qty, current.mode);
    return done(current, afterAddMenu(), placed.note, placed.order, { mode: 'add', back: 'cats' });
  }
  if (id === 'menu:qty:otra') {
    const product = findProduct(products, current.sku);
    return done(current, null, `¿Cuántos de ${product?.nombre || 'ese producto'} desea? Escriba el número.`, order, { awaiting: 'cantidad', sku: current.sku });
  }
  if (id === 'menu:todo') {
    const saved = order.address || ctx.savedAddress || '';
    if (!order.items.length) return done(current, categoryMenu(products), 'Todavía no anotó productos.', order, { back: 'main' });
    return done(current, deliveryMenu(saved), '', order, { back: 'after' });
  }
  if (id === 'menu:delivery' || id === 'menu:dir:otra') {
    return done(current, null, 'Indíqueme la dirección con número de casa o apartamento, o envíe su ubicación de WhatsApp.', order, { awaiting: 'direccion' });
  }
  if (id === 'menu:dir:usar') {
    const saved = order.address || ctx.savedAddress;
    if (!saved) return done(current, deliveryMenu(''), 'No tengo una dirección guardada. Escríbala, por favor.', order, { awaiting: 'direccion' });
    order = { ...order, address: saved, fulfillment: 'delivery' };
    return done(current, boletaMenu(), boletaText(order, rate), order);
  }
  if (id === 'menu:retiro') {
    order = { ...order, address: '🏪 Retiro en tienda', fulfillment: 'pickup' };
    return done(current, boletaMenu(), boletaText(order, rate), order);
  }
  if (id === 'menu:pague') {
    return done(current, null, 'Envíe el número de referencia o la captura del Pago Móvil. Todavía no está confirmado.', order, { awaiting: 'referencia' });
  }
  if (id === 'menu:cancelar') {
    order = blankOrder();
    return done(current, mainMenu(), 'Listo, cancelé el pedido. ¿Le armo otro?', order);
  }
  if (id.startsWith('pago:') || id.startsWith('stock:')) {
    return { handled: true, advisorAction: parseAdvisorId(id), session: current, menu: null, text: '', order };
  }
  return null;
}

function goBack(current, products, rate, order) {
  const target = current.back || 'main';
  if (target === 'cats' || target === 'main') {
    return target === 'main'
      ? done(current, mainMenu(), '', order, { back: null, mode: 'add' })
      : done(current, categoryMenu(products), '', order, { back: 'main', mode: 'add' });
  }
  if (target === 'modify' || target === 'boleta') {
    return done(current, target === 'modify' ? modifyMenu(order) : boletaMenu(), target === 'boleta' ? '' : '', order, { back: 'after' });
  }
  if (target === 'after') return done(current, afterAddMenu(), '', order, { back: 'cats', mode: 'add' });
  if (target === 'products' || target.startsWith('page:')) {
    const page = target.startsWith('page:') ? Number(target.split(':').at(-1)) || 0 : (current.page || 0);
    const group = current.group || 'Harinas';
    return done(current, productMenu(products, group, page, rate), '', order, {
      back: page > 0 ? `page:${slug(group)}:${page - 1}` : 'cats',
      group,
      page,
      mode: 'add',
    });
  }
  return done(current, mainMenu(), '', order, { back: null });
}

export function parseAdvisorId(id) {
  const [kind, action, orderId] = String(id || '').split(':');
  if (kind === 'pago' && action === 'ok') return { command: 'pagado', orderId };
  if (kind === 'pago' && action === 'no') return { command: 'rechazar', orderId };
  if (kind === 'stock' && action === 'si') return { command: 'hay', orderId };
  if (kind === 'stock' && action === 'no') return { command: 'nohay', orderId };
  return null;
}

export function menuForMatches(products, rate) {
  return matchMenu(products, rate);
}

export function advisorMenus(orderId) {
  return { payment: advisorPaymentMenu(orderId), stock: advisorStockMenu(orderId) };
}

export function catalogForMenus() {
  return getProducts().filter((product) => product.categoria !== 'politica' && product.sku !== 'servicio-delivery');
}

export function openMainMenu(session = {}) {
  const menu = mainMenu();
  return { ...session, menu, awaiting: null };
}

async function persistMenuOrder(phone, before, after) {
  if (!after) return;
  if (!after.items?.length && before?.items?.length) {
    await db.cancelPendingOrders(phone);
    return;
  }
  if (!after.items?.length) return;
  const order = await db.getOrCreateActiveOrder(phone);
  order.items = after.items;
  order.address = after.address || order.address;
  order.fulfillment = after.fulfillment || order.fulfillment;
  if (after.payment_reference) {
    order.payment_reference = after.payment_reference;
    order.lifecycle = 'pago_reportado';
  }
  if (after.lifecycle === 'pago_reportado') order.lifecycle = 'pago_reportado';
  await db.saveOrder(order);
}

/** Si el mensaje es un menú o el número de la última lista, responde sin modelo. */
export async function takeMenuTurn(phone, text, rate = null, onWait = null) {
  const session = lastMenu(phone);
  const raw = String(text || '').trim();
  const looks = /^(menu:|pago:|stock:)/.test(raw) || Boolean(session?.awaiting) || (session?.menu && /^\d{1,2}$/.test(raw));
  if (!looks) return null;
  const resolvedRate = rate == null ? ((await getBcvRate())?.rate || 0) : rate;
  const products = catalogForMenus();
  const order = await db.getActiveOrder(phone);
  let step = reduceMenu(session, raw, { products, rate: resolvedRate, order, orderId: order?.id, savedAddress: order?.address });
  if (step?.needsSearch) {
    if (onWait) await onWait('busqueda');
    const found = await searchProducts(step.query || raw, {});
    step = reduceMenu(session, raw, {
      products, rate: resolvedRate, order, orderId: order?.id, savedAddress: order?.address, matches: found.products || [],
    });
  }
  if (!step?.handled || step.advisorAction) return step?.advisorAction ? step : null;
  rememberMenu(phone, step.session);
  await persistMenuOrder(phone, order, step.order);
  return {
    reply: step.text,
    menu: step.menu,
    escalated: step.escalate,
    advisor: step.advisor,
  };
}
