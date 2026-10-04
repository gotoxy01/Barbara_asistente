// Serializa las tareas de un mismo cliente para que el historial y el pedido no se desordenen
// cuando envía varios mensajes seguidos.
const queues = new Map();

export function enqueue(key, task) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => console.error(`[${key}]`, err));
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}
