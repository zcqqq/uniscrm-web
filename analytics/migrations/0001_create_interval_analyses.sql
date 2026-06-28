CREATE TABLE IF NOT EXISTS interval_analyses (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  event_type_a TEXT NOT NULL,
  event_type_b TEXT NOT NULL,
  time_range_start TEXT,
  time_range_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  total_profiles INTEGER DEFAULT 0,
  processed_profiles INTEGER DEFAULT 0,
  pair_count INTEGER DEFAULT 0,
  results_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interval_analyses_tenant ON interval_analyses(tenant_id);
