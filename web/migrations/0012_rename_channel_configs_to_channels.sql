ALTER TABLE channel_configs RENAME TO channels;
ALTER TABLE channels ADD COLUMN external_channel_id TEXT;
