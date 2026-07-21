-- flow_executions/content_flow_executions' only reader (GET /api/flows' trigger_count) is
-- replaced by flows.trigger_count below, cached from the same R2-derived flow_counts/
-- content_flow_counts aggregation the node-analytics drawer already uses -- removing a second,
-- independently-diverging counting mechanism. See Task 5 for their write-side removal.
DROP TABLE IF EXISTS flow_executions;
DROP TABLE IF EXISTS content_flow_executions;

-- flow_counts/content_flow_counts move here from each tenant's own D1 database, where they had
-- no tenant_id column (relying on flow_id -- a UUID -- for uniqueness). Same primary key as
-- before; tenant_id added as a plain indexed column, matching the flow_executions/
-- content_flow_executions precedent this migration just dropped.
CREATE TABLE IF NOT EXISTS flow_counts (
  tenant_id INTEGER NOT NULL,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_flow_counts_tenant ON flow_counts(tenant_id);

CREATE TABLE IF NOT EXISTS content_flow_counts (
  tenant_id INTEGER NOT NULL,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (flow_id, node_id, direction)
);
CREATE INDEX IF NOT EXISTS idx_content_flow_counts_tenant ON content_flow_counts(tenant_id);

-- Cached "No. Triggered" value for the flow list page: the flow's one trigger node's
-- `direction = 'enter'` count -- the same source as the node-analytics drawer's "Entered" badge.
-- NULL until the next recomputeFlowCounts() cron tick (runs every minute) fills it in, or
-- permanently NULL if the flow has no recognized trigger node. The list page already renders
-- NULL as "-" (flow/frontend/pages/FlowsPage.tsx: `flow.trigger_count || "-"`) -- no frontend
-- change needed.
ALTER TABLE flows ADD COLUMN trigger_count INTEGER;
