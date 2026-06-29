CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  nl_query TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  sql_query TEXT NOT NULL DEFAULT '',
  user_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_tenant ON segments(tenant_id);
