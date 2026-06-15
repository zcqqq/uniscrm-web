CREATE TABLE event_x (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_time TEXT,
  raw_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_event_x_user ON event_x(user_id);
CREATE INDEX idx_event_x_channel ON event_x(channel_id);
