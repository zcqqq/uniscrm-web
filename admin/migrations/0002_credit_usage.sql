-- X-action credit usage ledger. Balance is computed on the fly (monthly_credit_micros
-- from the tenant's tier minus the sum of credit_micros in the current billing period)
-- rather than stored, to avoid drift between a cached balance and the ledger.
CREATE TABLE IF NOT EXISTS credit_usage_log (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  flow_id TEXT,
  channel_id TEXT,
  action_event_type TEXT NOT NULL,
  credit_micros INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_usage_log_tenant_created ON credit_usage_log(tenant_id, created_at);
