-- flow_counts/content_flow_counts are tiny caches (one row per flow×node×direction combo, tens of
-- rows in dev) and every read filters `WHERE tenant_id = ?` — a full scan of tens of rows. The
-- secondary index bought nothing there, while every rebuild of the table paid for its maintenance:
-- D1 bills index writes as rows written, which is why a delete+insert of one count row cost ~4
-- rows written instead of ~2. The composite primary key's own index stays (it cannot be dropped —
-- it backs (flow_id, node_id, direction)); only this redundant one goes.
DROP INDEX IF EXISTS idx_flow_counts_tenant;
DROP INDEX IF EXISTS idx_content_flow_counts_tenant;
