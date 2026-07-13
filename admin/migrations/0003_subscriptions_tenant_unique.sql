-- SubscriptionDB.upsert() relies on `INSERT ... ON CONFLICT(tenant_id) DO UPDATE`,
-- which requires a UNIQUE index on tenant_id. This existed on dev only as an
-- undocumented manual patch (never captured in a migration), so it silently
-- drifted from prod. Adding it here as the missing migration for both.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_tenant_unique ON subscriptions(tenant_id);
