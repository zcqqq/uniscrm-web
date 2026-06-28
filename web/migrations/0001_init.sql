CREATE TABLE IF NOT EXISTS tenants (
  tenant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  d1_database_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  preferred_location TEXT DEFAULT 'global',
  language TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  trial TEXT,
  timezone TEXT
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_tenant ON oauth_accounts(tenant_id);
