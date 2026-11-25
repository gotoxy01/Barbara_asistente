import { config } from '../config.js';
import { query } from '../db/pool.js';

export function usageRates() {
  return {
    serviceFree: Number(process.env.WA_SERVICE_FREE ?? config.usage.serviceFree),
    serviceUsd: Number(process.env.WA_SERVICE_USD ?? config.usage.serviceUsd),
    marketingUsd: Number(process.env.WA_MARKETING_USD ?? config.usage.marketingUsd),
    inputPerMillion: Number(process.env.GEMINI_INPUT_USD_PER_MILLION ?? config.usage.inputPerMillion),
    outputPerMillion: Number(process.env.GEMINI_OUTPUT_USD_PER_MILLION ?? config.usage.outputPerMillion),
  };
}

/** Medianoche del día en la zona horaria, en milisegundos UTC. */
export function zonedMidnight(year, month, day, timeZone = config.timezone) {
  const noon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', hourCycle: 'h23', minute: '2-digit',
  }).formatToParts(new Date(noon)).map((part) => [part.type, part.value]));
  const offsetMin = (Number(parts.hour) - 12) * 60 + Number(parts.minute);
  return Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMin * 60_000;
}

export function monthRange(ym, timeZone = config.timezone) {
  const match = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  const current = fmt.format(now);
  const [year, month] = (match ? match[0] : current).split('-').map(Number);
  const start = zonedMidnight(year, month, 1, timeZone);
  const end = month === 12 ? zonedMidnight(year + 1, 1, 1, timeZone) : zonedMidnight(year, month + 1, 1, timeZone);
  return { year, month, start, end, label: `${year}-${String(month).padStart(2, '0')}` };
}

export function estimateCost(counts, rates = usageRates()) {
  const service = Number(counts.outboundBot || 0) + Number(counts.outboundSeller || 0);
  const billableService = Math.max(0, service - Number(rates.serviceFree || 0));
  const whatsapp = billableService * Number(rates.serviceUsd || 0) + Number(counts.template || 0) * Number(rates.marketingUsd || 0);
  const gemini = (Number(counts.inputTokens || 0) / 1_000_000) * Number(rates.inputPerMillion || 0)
    + (Number(counts.outputTokens || 0) / 1_000_000) * Number(rates.outputPerMillion || 0);
  return {
    service,
    billableService,
    whatsapp: round6(whatsapp),
    gemini: round6(gemini),
    total: round6(whatsapp + gemini),
  };
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const KINDS = new Set(['inbound', 'outbound_bot', 'outbound_seller', 'template', 'gemini', 'embedding']);

export async function recordUsage({
  phone = null,
  kind,
  billable = true,
  calls = 1,
  inputTokens = 0,
  outputTokens = 0,
} = {}) {
  if (!KINDS.has(kind)) return;
  try {
    await query(`
      INSERT INTO usage_events (wa_id, kind, billable, calls, input_tokens, output_tokens)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [phone || null, kind, Boolean(billable), Number(calls) || 1, Number(inputTokens) || 0, Number(outputTokens) || 0]);
  } catch (err) {
    if (!/no está iniciado/i.test(err.message || '')) {
      console.warn(`No se pudo anotar el uso (${kind}): ${err.message}`);
    }
  }
}

function emptyCounts() {
  return {
    inbound: 0, outboundBot: 0, outboundSeller: 0, template: 0,
    geminiCalls: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0,
  };
}

function addRow(bucket, row) {
  const calls = Number(row.calls) || 0;
  const input = Number(row.input_tokens) || 0;
  const output = Number(row.output_tokens) || 0;
  if (row.kind === 'inbound') bucket.inbound += calls;
  if (row.kind === 'outbound_bot') bucket.outboundBot += calls;
  if (row.kind === 'outbound_seller') bucket.outboundSeller += calls;
  if (row.kind === 'template') bucket.template += calls;
  if (row.kind === 'gemini') {
    bucket.geminiCalls += calls;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
  }
  if (row.kind === 'embedding') bucket.embeddingCalls += calls;
}

export async function usageReport(ym) {
  const range = monthRange(ym);
  const { rows } = await query(`
    SELECT wa_id, kind,
           SUM(calls)::int AS calls,
           SUM(input_tokens)::int AS input_tokens,
           SUM(output_tokens)::int AS output_tokens
    FROM usage_events
    WHERE billable = TRUE
      AND created_at >= to_timestamp($1 / 1000.0)
      AND created_at < to_timestamp($2 / 1000.0)
    GROUP BY wa_id, kind
  `, [range.start, range.end]);
  const byPhone = new Map();
  const totals = emptyCounts();
  for (const row of rows) {
    const key = row.wa_id || '(sin número)';
    if (!byPhone.has(key)) byPhone.set(key, emptyCounts());
    addRow(byPhone.get(key), row);
    addRow(totals, row);
  }
  const rates = usageRates();
  const clients = [...byPhone.entries()].map(([phone, counts]) => ({
    phone,
    ...counts,
    cost: estimateCost(counts, rates),
  })).sort((a, b) => b.cost.total - a.cost.total || b.outboundBot - a.outboundBot);
  return {
    month: range.label,
    rates,
    totals: { ...totals, cost: estimateCost(totals, rates) },
    clients,
  };
}

export function usageCsv(report) {
  const header = 'telefono,entrantes,salientes_barbara,salientes_vendedor,plantillas,llamadas_gemini,tokens_entrada,tokens_salida,embeddings,costo_usd';
  const lines = report.clients.map((row) => [
    row.phone, row.inbound, row.outboundBot, row.outboundSeller, row.template,
    row.geminiCalls, row.inputTokens, row.outputTokens, row.embeddingCalls, row.cost.total.toFixed(6),
  ].join(','));
  lines.push([
    'TOTAL', report.totals.inbound, report.totals.outboundBot, report.totals.outboundSeller, report.totals.template,
    report.totals.geminiCalls, report.totals.inputTokens, report.totals.outputTokens, report.totals.embeddingCalls,
    report.totals.cost.total.toFixed(6),
  ].join(','));
  return `${header}\n${lines.join('\n')}\n`;
}
