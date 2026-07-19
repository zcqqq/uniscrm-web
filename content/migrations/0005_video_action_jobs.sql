-- Per-job tracking for the Video Action pipeline (download -> transcribe -> translate ->
-- burn-in). Exists purely for diagnosability: this pipeline runs in a background queue
-- consumer with no synchronous caller to report errors to, so job_status + failed_step +
-- error let a stuck/failed job be diagnosed without digging through Workers logs.
CREATE TABLE video_action_jobs (
  id TEXT PRIMARY KEY,
  pending_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  target_language TEXT NOT NULL,
  job_status TEXT NOT NULL,
  failed_step TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
