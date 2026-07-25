-- Segment membership, re-keyed on user (a per-channel account) instead of the old
-- cross-channel profile identity — profile/segment_profiles have 0 rows in production and
-- the profile worker is unreachable from any nav, so this is a deliberate downgrade rather
-- than a straight port. Lives in WEB_DB (shared) alongside `segments`, not a tenant D1,
-- because segment computation now reads uniscrm.user/uniscrm.event from R2 directly —
-- there's no per-tenant database left in the loop for insight-segment.
CREATE TABLE IF NOT EXISTS segment_users (
  tenant_id  INTEGER NOT NULL,
  segment_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_segment_users_tenant ON segment_users(tenant_id);
