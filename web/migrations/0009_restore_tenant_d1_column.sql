-- 0008 dropped this column when user/content moved to R2. The 2026-07-26 design moves
-- them back to per-tenant D1, so the column returns. Backfill is NOT done here: the
-- database ids differ per environment and SQL cannot branch, so a documented
-- per-environment `wrangler d1 execute` (spec §2) repopulates it right after apply.
ALTER TABLE tenants ADD COLUMN d1_database_id TEXT;
