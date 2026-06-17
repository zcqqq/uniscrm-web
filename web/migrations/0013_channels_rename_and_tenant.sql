ALTER TABLE channels RENAME COLUMN external_channel_id TO original_channel_id;
ALTER TABLE channels ADD COLUMN tenant_id TEXT;
