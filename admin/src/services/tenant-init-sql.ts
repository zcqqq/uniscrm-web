export const TENANT_DB_INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT,
    username TEXT,
    profile_image_url TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    socials TEXT DEFAULT '{}',
    maigret_status TEXT DEFAULT 'pending'
  )`,
  `CREATE TABLE IF NOT EXISTS event (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_time TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_event_user ON event(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_event_channel ON event(channel_id)`,
  `CREATE INDEX IF NOT EXISTS idx_event_type ON event(event_type)`,
  `CREATE TABLE IF NOT EXISTS segment_users (
    segment_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (segment_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    channel_type TEXT NOT NULL,
    source_content_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    status TEXT DEFAULT 'new',
    source_url TEXT,
    source_updated_at TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_source ON content(channel_type, source_content_id)`,
  `CREATE INDEX IF NOT EXISTS idx_content_status ON content(status)`,
];
