-- Bloqueo temporal por ráfaga y bloqueo manual del asesor.

CREATE TABLE IF NOT EXISTS chat_blocks (
  wa_id VARCHAR(32) PRIMARY KEY,
  blocked_until TIMESTAMPTZ,
  warned_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
