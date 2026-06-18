ALTER TABLE flow_pending ADD COLUMN awaiting_event TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_flow_pending_user_event ON flow_pending(user_id, awaiting_event);
