-- 一份「租户 × 技能包」的上下文文档。键是包（GitHub repo id）而不是单个技能：
-- 文档由 product-marketing 技能产出，但同一个包里的所有技能都读它（技能自己写明
-- "Other marketing skills will now use this context automatically"）。
-- content 列存完整 markdown，含技能自带的 Changelog 段 —— 版本演进的真相在正文里，
-- 这里不再存一份行级历史。version 只用于界面展示与乐观并发。
CREATE TABLE skill_context (
  tenant_id  INTEGER NOT NULL,
  skill_repo TEXT NOT NULL,
  content    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, skill_repo)
);
