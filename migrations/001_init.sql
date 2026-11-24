-- Esquema local de Bárbara (PostgreSQL 16+ y pgvector).
-- La dimensión del embedding se sustituye al aplicar la migración (__EMBED_DIM__).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id VARCHAR(32) UNIQUE NOT NULL,
  bsuid VARCHAR(128) UNIQUE,
  full_name VARCHAR(150),
  lead_status VARCHAR(30) NOT NULL DEFAULT 'NEW',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'BOT',
  assigned_specialist_id VARCHAR(64),
  handoff_reason TEXT,
  last_user_message_at TIMESTAMPTZ,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at TIMESTAMPTZ,
  paused_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversations_status_chk CHECK (status IN ('BOT', 'SPECIALIST', 'CLOSED'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact_status
  ON conversations (contact_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq BIGSERIAL,
  wamid VARCHAR(128) UNIQUE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL,
  media_type VARCHAR(20) NOT NULL DEFAULT 'TEXT',
  content TEXT NOT NULL,
  confidence_score NUMERIC(5,2),
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_sender_chk CHECK (sender_type IN ('USER', 'BOT', 'SPECIALIST'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products_kb (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  presentation VARCHAR(80),
  description TEXT NOT NULL,
  technical_specs JSONB NOT NULL DEFAULT '{}'::jsonb,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  embedding vector(__EMBED_DIM__),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_embedding
  ON products_kb USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(32) NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'abierto',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  address TEXT,
  total_usd NUMERIC(12,2),
  total_bs NUMERIC(12,2),
  bcv_rate NUMERIC(14,4),
  boleta_pendiente INTEGER NOT NULL DEFAULT 0,
  kitchen_status TEXT NOT NULL DEFAULT 'nuevo',
  board_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone, status);

CREATE TABLE IF NOT EXISTS advisor_alerts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  phone VARCHAR(32),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_done ON advisor_alerts (done, id DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  wa_message_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
