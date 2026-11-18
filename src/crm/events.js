/** Pub/sub ligero para que el panel CRM se entere de mensajes nuevos (SSE). */

const listeners = new Set();

export function subscribeCrm(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishCrm(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error('Error notificando al CRM:', err.message);
    }
  }
}
