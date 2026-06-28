CREATE TABLE IF NOT EXISTS analytics_reports (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  name TEXT,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  results_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_tenant ON analytics_reports(tenant_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboards_tenant ON dashboards(tenant_id);

CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES analytics_reports(id) ON DELETE CASCADE,
  size TEXT NOT NULL DEFAULT 'medium',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_dashboard ON dashboard_items(dashboard_id, position);
