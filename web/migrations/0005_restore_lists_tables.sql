-- Revert 0004: lists/list_users are NOT dead. The profile module binds the
-- same D1 database under WEB_DB and actively reads/writes these tables
-- (profile/src/index.ts /api/lists* routes, profile/tests/e2e/lists.spec.ts).
-- link's copy of this schema is a separate, unrelated table living in the
-- link module's own D1 database, not a replacement for this one.
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lists_tenant ON lists(tenant_id);

CREATE TABLE IF NOT EXISTS list_users (
  list_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, user_id),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_list_users_tenant ON list_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_list_users_list ON list_users(list_id);
