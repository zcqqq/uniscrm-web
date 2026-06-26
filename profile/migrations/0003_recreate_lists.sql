DROP TABLE IF EXISTS list_users;
DROP TABLE IF EXISTS lists;

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
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

CREATE INDEX IF NOT EXISTS idx_lists_tenant ON lists(tenant_id);
CREATE INDEX IF NOT EXISTS idx_list_users_tenant ON list_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_list_users_list ON list_users(list_id);
