-- Migrate existing data from old contents table to content_items.
-- Run this manually on remote D1 where both web/ and link-content share the same database:
-- INSERT OR IGNORE INTO content_items (id, user_id, channel_type, channel_source_id, title, summary, status, source_url, source_modified_at, created_at, updated_at)
-- SELECT id, user_id, 'LOCAL', filename, title, summary, status, NULL, file_modified_at, created_at, updated_at FROM contents;
SELECT 1;
