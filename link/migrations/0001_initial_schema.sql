-- Channels: OAuth connections per tenant
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  source_channel_id TEXT,
  access_token TEXT,
  tenant_id INTEGER,
  member_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_channels_type_source ON channels(channel_type, source_channel_id);
CREATE INDEX idx_channels_tenant ON channels(tenant_id);

-- Lists: user grouping per tenant
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lists_tenant ON lists(tenant_id);

-- List membership
CREATE TABLE list_users (
  list_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, user_id),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE INDEX idx_list_users_tenant ON list_users(tenant_id);
CREATE INDEX idx_list_users_list ON list_users(list_id);

-- Products: commerce items per tenant member
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  source_modified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_user ON products(user_id);
CREATE UNIQUE INDEX idx_products_user_channel_source ON products(user_id, channel_type, channel_source_id);

-- OAuth tokens for external providers (Notion, TikTok, Shopify)
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  channel_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_oauth_tokens_user_provider ON oauth_tokens(user_id, provider);
