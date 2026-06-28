CREATE TABLE IF NOT EXISTS analytics_reports (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  results_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_tenant ON analytics_reports(tenant_id, type, created_at DESC);
