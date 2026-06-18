-- Recreate flows with tenant_id as INTEGER
CREATE TABLE flows_new (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Untitled Flow',
  description TEXT DEFAULT '',
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO flows_new SELECT id, CAST(tenant_id AS INTEGER), member_id, name, description, graph_json, enabled, created_at, updated_at FROM flows;
DROP TABLE flows;
ALTER TABLE flows_new RENAME TO flows;
CREATE INDEX idx_flows_tenant ON flows(tenant_id);

-- Recreate flow_executions with tenant_id as INTEGER
CREATE TABLE flow_executions_new (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  event_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO flow_executions_new SELECT id, flow_id, event_id, user_id, CAST(tenant_id AS INTEGER), matched, created_at FROM flow_executions;
DROP TABLE flow_executions;
ALTER TABLE flow_executions_new RENAME TO flow_executions;
CREATE INDEX idx_flow_exec_flow ON flow_executions(flow_id);
CREATE INDEX idx_flow_exec_user ON flow_executions(user_id);

-- Recreate flow_pending with tenant_id as INTEGER
CREATE TABLE flow_pending_new (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  execute_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO flow_pending_new SELECT id, flow_id, node_id, user_id, CAST(tenant_id AS INTEGER), payload, execute_at, created_at FROM flow_pending;
DROP TABLE flow_pending;
ALTER TABLE flow_pending_new RENAME TO flow_pending;
CREATE INDEX idx_flow_pending_execute ON flow_pending(execute_at);
