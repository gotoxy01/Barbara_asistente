-- Memoria del cliente, estados del pedido y libro de inventario.
-- No toca la base de la caja (database.db): el descuento vive aquí.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_chk;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_chk
  CHECK (status IN ('BOT', 'SPECIALIST', 'LOGISTICA', 'CLOSED'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'borrador';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_media_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_label TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE orders SET lifecycle = CASE status
  WHEN 'boleta' THEN 'boleta_enviada'
  WHEN 'recibido' THEN 'en_logistica'
  WHEN 'cancelado' THEN 'cancelado'
  ELSE 'borrador'
END
WHERE lifecycle = 'borrador' AND status IS DISTINCT FROM 'abierto';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_lifecycle_chk;
ALTER TABLE orders ADD CONSTRAINT orders_lifecycle_chk CHECK (lifecycle IN (
  'borrador', 'boleta_enviada', 'pago_reportado', 'pago_verificado', 'en_logistica', 'entregado', 'cancelado'
));

CREATE INDEX IF NOT EXISTS idx_orders_lifecycle ON orders (phone, lifecycle);

CREATE TABLE IF NOT EXISTS customer_profiles (
  wa_id VARCHAR(32) PRIMARY KEY,
  display_name VARCHAR(150),
  fulfillment TEXT,
  notes TEXT,
  addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  wa_id VARCHAR(32),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, id);

-- Un descuento y una devolución por pedido. El conflicto evita cobrar el stock dos veces.
CREATE TABLE IF NOT EXISTS stock_ledger (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stock_ledger_action_chk CHECK (action IN ('deduct', 'restore')),
  UNIQUE (order_id, action)
);
