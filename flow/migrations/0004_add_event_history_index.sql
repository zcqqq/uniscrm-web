CREATE INDEX IF NOT EXISTS idx_event_x_user_type_channel_time ON event_x(user_id, event_type, channel_id, created_at);
