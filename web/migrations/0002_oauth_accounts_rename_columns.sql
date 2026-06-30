CREATE TABLE oauth_accounts_new (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);

INSERT INTO oauth_accounts_new (provider, provider_user_id, member_id, tenant_id, created_at)
SELECT provider, provider_user_id, user_id, CAST(tenant_id AS INTEGER), created_at
FROM oauth_accounts;

DROP TABLE oauth_accounts;
ALTER TABLE oauth_accounts_new RENAME TO oauth_accounts;

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_tenant ON oauth_accounts(tenant_id);
