-- Recreate tenants with INTEGER PRIMARY KEY AUTOINCREMENT
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS oauth_accounts;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS tenants;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  d1_database_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(tenant_id),
  email TEXT UNIQUE NOT NULL,
  preferred_location TEXT DEFAULT 'global',
  language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_tenant ON members(tenant_id);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_tenant ON oauth_accounts(tenant_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(tenant_id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
