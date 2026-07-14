DROP TABLE IF EXISTS content_flow_executions;
CREATE TABLE content_flow_executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  event_id TEXT,
  content_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_flow_exec_flow ON content_flow_executions(flow_id);
CREATE INDEX IF NOT EXISTS idx_content_flow_exec_content ON content_flow_executions(content_id);
CREATE INDEX IF NOT EXISTS idx_content_flow_exec_tenant ON content_flow_executions(tenant_id);

DROP TABLE IF EXISTS content_flow_pending;
CREATE TABLE content_flow_pending (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  execute_at TEXT NOT NULL,
  awaiting_event TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  retry_action TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_flow_pending_execute ON content_flow_pending(execute_at);
CREATE INDEX IF NOT EXISTS idx_content_flow_pending_content_event ON content_flow_pending(content_id, awaiting_event);
