-- Distinguish tier-enforcement deactivation from user-initiated disconnect,
-- so upgrading a tier can safely reactivate only channels it paused.
ALTER TABLE channels ADD COLUMN deactivated_reason TEXT;
