-- Global cache of externally-sourced skill documents (e.g. from public GitHub repos).
-- No tenant_id: skill content is shared across every tenant, refreshed manually.
CREATE TABLE skill_content_cache (
  skill_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
