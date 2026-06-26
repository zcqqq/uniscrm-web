-- Recreate channels without user_id and original_channel_id
DROP INDEX IF EXISTS idx_channels_source;
DROP INDEX IF EXISTS idx_channels_type_source;

CREATE TABLE channels_new (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  config TEXT NOT NULL,
  source_channel_id TEXT,
  access_token TEXT,
  tenant_id INTEGER,
  member_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO channels_new (id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, is_active, created_at, updated_at)
  SELECT id, channel_type, config, source_channel_id, access_token, tenant_id, member_id, is_active, created_at, updated_at FROM channels;

DROP TABLE channels;
ALTER TABLE channels_new RENAME TO channels;

CREATE UNIQUE INDEX idx_channels_type_source ON channels(channel_type, source_channel_id);
CREATE INDEX idx_channels_tenant ON channels(tenant_id);
