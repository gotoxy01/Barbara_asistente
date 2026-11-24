/**
 * Una imagen o un documento solo abre ticket de pago si el contexto habla de un comprobante.
 * Una foto de producto no es un pago.
 */

const ATTACHMENT_RE = /^\[El cliente adjuntó (una imagen|un documento)/;
const PAYMENT_RE = /comprobante|captura|capture|baucher|voucher|transferenc|pago\s*m[oó]vil|ya\s+pagu[eé]|\bpagu[eé]\b|\bpagado\b|dep[oó]sito/i;

export function shouldOpenPaymentTicket({ text = '', history = [], order = null } = {}) {
  const current = String(text || '');
  if (!ATTACHMENT_RE.test(current)) return false;
  if (PAYMENT_RE.test(current)) return true;

  const recent = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((m) => String(m?.content || ''))
    .join('\n');
  if (PAYMENT_RE.test(recent)) return true;

  if (order && (order.status === 'boleta' || order.status === 'recibido')) {
    const lastModel = [...(history || [])].reverse().find((m) => m?.role === 'model');
    if (lastModel && PAYMENT_RE.test(String(lastModel.content || ''))) return true;
  }
  return false;
}
