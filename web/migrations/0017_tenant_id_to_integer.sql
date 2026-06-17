-- Recreate tables with tenant_id INTEGER

-- channels
DROP TABLE IF EXISTS channels;
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  original_channel_id TEXT,
  tenant_id INTEGER NOT NULL,
  UNIQUE(user_id, channel_type)
);

-- segments
DROP TABLE IF EXISTS segment_users;
DROP TABLE IF EXISTS segments;
CREATE TABLE segments (
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

-- flows
DROP TABLE IF EXISTS flow_pending;
DROP TABLE IF EXISTS flow_executions;
DROP TABLE IF EXISTS flows;
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'Untitled Flow',
  description TEXT DEFAULT '',
  graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE flow_executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  event_id TEXT,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  matched INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_flow_exec_tenant ON flow_executions(tenant_id);
CREATE TABLE flow_pending (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  execute_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_flow_pending_exec ON flow_pending(execute_at);

-- contents
DROP TABLE IF EXISTS contents;
CREATE TABLE contents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT DEFAULT 'new',
  file_modified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tenant_id INTEGER NOT NULL
);
CREATE INDEX idx_contents_tenant ON contents(tenant_id);

-- lists
DROP TABLE IF EXISTS list_users;
DROP TABLE IF EXISTS lists;
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE list_users (
  list_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, user_id),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);

-- Drop old user_x and event_x (moved to per-tenant DB)
DROP TABLE IF EXISTS user_x;
DROP TABLE IF EXISTS event_x;
