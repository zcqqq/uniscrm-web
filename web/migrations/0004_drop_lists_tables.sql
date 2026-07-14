-- lists/list_users predate the module split; the link module now owns this
-- schema (link/migrations/0001_initial_schema.sql). Unused in web/worker,
-- 0 rows in both dev and production.
DROP TABLE IF EXISTS list_users;
DROP TABLE IF EXISTS lists;
