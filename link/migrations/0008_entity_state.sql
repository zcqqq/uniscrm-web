CREATE TABLE entity_state (
  tenant_id    INTEGER NOT NULL,
  entity       TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  secondary_id TEXT NOT NULL DEFAULT '',
  source_id    TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  fingerprint  TEXT,
  is_follow    INTEGER,
  is_followed  INTEGER,
  seen_at      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity, channel_id, secondary_id, source_id)
);
CREATE INDEX idx_entity_state_entity_id ON entity_state(tenant_id, entity_id);
