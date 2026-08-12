-- 租户自己上传的技能。与 skill_content_cache（全局、跨租户共享的预置技能）刻意分表：
-- 那张表没有 tenant_id，建表注释写明内容跨租户共享，混进租户私有内容就是跨租户泄漏。
-- skill_id 带 "upload:" 前缀，与预置 id 天然不撞，存量 flow 节点里存的 skillId 不受影响。
CREATE TABLE tenant_skill (
  tenant_id   INTEGER NOT NULL,
  skill_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, skill_id)
);
