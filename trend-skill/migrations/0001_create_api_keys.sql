CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  owner_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE INDEX idx_api_keys_tier ON api_keys(tier);
CREATE INDEX idx_api_keys_active ON api_keys(is_active);
