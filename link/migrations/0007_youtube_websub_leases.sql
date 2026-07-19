CREATE TABLE youtube_websub_leases (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  account_channel_id TEXT NOT NULL,
  youtube_channel_id TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_youtube_leases_account_channel ON youtube_websub_leases(account_channel_id, youtube_channel_id);
CREATE INDEX idx_youtube_leases_tenant ON youtube_websub_leases(tenant_id);
