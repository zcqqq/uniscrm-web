CREATE TABLE flows_new (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Untitled Flow',
  description TEXT DEFAULT '',
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO flows_new SELECT id, tenant_id, member_id, name, description, graph_json, status, created_at, updated_at FROM flows;
DROP TABLE flows;
ALTER TABLE flows_new RENAME TO flows;
CREATE INDEX idx_flows_tenant ON flows(tenant_id);
CREATE INDEX idx_flows_status ON flows(tenant_id, status);
