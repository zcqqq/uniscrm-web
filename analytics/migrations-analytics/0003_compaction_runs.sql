-- The compactor runs inside a Cloudflare Container, whose stdout is not queryable, so a
-- failing nightly compaction left no trace anywhere: uniscrm.user silently grew to 980 rows
-- for 410 users before anyone noticed. Every run now records its outcome here, which is the
-- only durable evidence available (see reference: container logs are not queryable).
CREATE TABLE IF NOT EXISTS compaction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  -- 'running' is written before the container is called and updated afterwards. A row
  -- stuck at 'running' is the signature of the scheduled invocation being killed
  -- mid-compaction — the one failure mode a write-at-the-end row could never show.
  status TEXT NOT NULL,          -- 'running' | 'ok' | 'error'
  rows_before INTEGER,
  rows_after INTEGER,
  duration_ms INTEGER NOT NULL,
  error_message TEXT,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compaction_runs_started ON compaction_runs(started_at DESC);
