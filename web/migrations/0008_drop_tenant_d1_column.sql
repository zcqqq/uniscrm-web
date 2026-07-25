-- Per-tenant D1 databases are gone (tenant-db-removal task 11): user/content/event data now
-- lives in R2 Data Catalog, and onboarding no longer provisions a per-tenant D1 or writes this
-- column back. D1/SQLite has supported ALTER TABLE ... DROP COLUMN since 3.35.0, which D1 is
-- well past, so a plain DROP COLUMN is safe here (no rebuild-and-copy needed).
ALTER TABLE tenants DROP COLUMN d1_database_id;
