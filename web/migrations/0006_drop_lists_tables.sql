-- profile module's legacy /api/lists* implementation (which used these
-- tables via the shared WEB_DB binding) has been removed; link module owns
-- the real, actively-used lists feature in its own D1 database. Confirmed
-- 0 rows in both dev and production before dropping.
DROP TABLE IF EXISTS list_users;
DROP TABLE IF EXISTS lists;
