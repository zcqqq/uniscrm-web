DROP TABLE IF EXISTS flows;
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Untitled Flow',
  description TEXT DEFAULT '',
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flows_tenant ON flows(tenant_id);

DROP TABLE IF EXISTS flow_executions;
CREATE TABLE flow_executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  event_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_exec_flow ON flow_executions(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_exec_user ON flow_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_flow_exec_tenant ON flow_executions(tenant_id);

DROP TABLE IF EXISTS flow_pending;
CREATE TABLE flow_pending (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  execute_at TEXT NOT NULL,
  awaiting_event TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  retry_action TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_pending_execute ON flow_pending(execute_at);
CREATE INDEX IF NOT EXISTS idx_flow_pending_user_event ON flow_pending(user_id, awaiting_event);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  remaining INTEGER NOT NULL DEFAULT 5,
  reset_at TEXT NOT NULL DEFAULT ''
);
