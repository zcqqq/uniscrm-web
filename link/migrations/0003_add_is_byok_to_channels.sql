-- Add is_byok column to channels table
ALTER TABLE channels ADD COLUMN is_byok INTEGER NOT NULL DEFAULT 0;
