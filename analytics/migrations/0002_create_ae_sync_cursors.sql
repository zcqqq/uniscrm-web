CREATE TABLE IF NOT EXISTS ae_sync_cursors (
  tenant_id INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  last_synced_id TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  PRIMARY KEY (tenant_id, table_name)
);
