CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT DEFAULT 'new',
  source_url TEXT,
  source_modified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_ci_user ON content_items(user_id);
CREATE INDEX idx_ci_status ON content_items(status);
CREATE UNIQUE INDEX idx_ci_user_channel_source
  ON content_items(user_id, channel_type, channel_source_id);
