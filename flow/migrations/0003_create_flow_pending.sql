CREATE TABLE flow_pending (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  execute_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_flow_pending_execute ON flow_pending(execute_at);
