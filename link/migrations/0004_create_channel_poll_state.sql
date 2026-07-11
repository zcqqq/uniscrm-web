-- link/migrations/0004_create_channel_poll_state.sql
CREATE TABLE channel_poll_state (
  channel_id TEXT NOT NULL,
  poller_name TEXT NOT NULL,
  cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, poller_name)
);
