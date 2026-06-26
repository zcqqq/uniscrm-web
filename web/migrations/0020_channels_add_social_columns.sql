-- Add columns needed by link-social worker
ALTER TABLE channels ADD COLUMN source_channel_id TEXT;
ALTER TABLE channels ADD COLUMN access_token TEXT;
ALTER TABLE channels ADD COLUMN member_id TEXT;
ALTER TABLE channels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

-- Index for link-social queries
CREATE INDEX IF NOT EXISTS idx_channels_source ON channels(channel_type, source_channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_type_source ON channels(channel_type, source_channel_id);
