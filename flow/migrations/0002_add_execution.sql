ALTER TABLE user_x ADD COLUMN point INTEGER NOT NULL DEFAULT 0;

CREATE TABLE flow_executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  event_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  matched INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_flow_exec_flow ON flow_executions(flow_id);
CREATE INDEX idx_flow_exec_user ON flow_executions(user_id);
