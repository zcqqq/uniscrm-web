DROP TABLE IF EXISTS tenant_llm_credentials;
CREATE TABLE tenant_llm_credentials (
  tenant_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);
