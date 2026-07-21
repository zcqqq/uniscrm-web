-- Tracks which Video Action operation a job is running, now that add-subtitle,
-- rotate-to-vertical, and remove-face all share the same job table.
ALTER TABLE video_action_jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'add-subtitle';
