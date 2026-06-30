CREATE TABLE IF NOT EXISTS pending_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_retry ON pending_tasks(status, next_retry_at);
