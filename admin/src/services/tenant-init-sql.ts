export const TENANT_DB_INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS profile (
    id TEXT PRIMARY KEY,
    socials TEXT NOT NULL DEFAULT '{}',
    maigret_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    channel_type TEXT,
    name TEXT,
    username TEXT,
    profile_image_url TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    is_follow INTEGER NOT NULL DEFAULT 0,
    is_followed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    profile_id TEXT REFERENCES profile(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel_source ON user(channel_id, source_user_id)`,
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
  `CREATE INDEX IF NOT EXISTS idx_event_user_type_time ON event(user_id, event_type, event_time)`,
  `CREATE TABLE IF NOT EXISTS segment_profiles (
    segment_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (segment_id, profile_id)
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
