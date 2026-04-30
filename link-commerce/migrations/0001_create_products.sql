CREATE TABLE products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  source_modified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_user ON products(user_id);
CREATE INDEX idx_products_channel_type ON products(user_id, channel_type);
CREATE UNIQUE INDEX idx_products_user_channel_source ON products(user_id, channel_type, channel_source_id);
