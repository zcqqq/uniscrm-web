CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
  tenant_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
