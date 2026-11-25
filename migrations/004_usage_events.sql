-- Uso por cliente: mensajes, modelo y embeddings. Lo de prueba no entra (billable = false).

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  wa_id VARCHAR(32),
  kind TEXT NOT NULL,
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  calls INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT usage_events_kind_chk CHECK (kind IN (
    'inbound', 'outbound_bot', 'outbound_seller', 'template', 'gemini', 'embedding'
  ))
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events (created_at, kind);
CREATE INDEX IF NOT EXISTS idx_usage_events_phone ON usage_events (wa_id, created_at);
