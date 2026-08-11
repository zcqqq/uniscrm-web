import type { Env } from "../types";

export interface SkillContextRow {
  content: string;
  version: number;
  updatedAt: string;
}

export async function getSkillContextRow(
  env: Env,
  tenantId: number,
  skillRepo: string
): Promise<SkillContextRow | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT content, version, updated_at FROM skill_context WHERE tenant_id = ? AND skill_repo = ?"
  ).bind(tenantId, skillRepo).first<{ content: string; version: number; updated_at: string }>();
  if (!row) return null;
  return { content: row.content, version: row.version, updatedAt: row.updated_at };
}

export async function getSkillContext(env: Env, tenantId: number, skillRepo: string): Promise<string | null> {
  return (await getSkillContextRow(env, tenantId, skillRepo))?.content ?? null;
}

// 版本在服务端自增，不由调用方传入 —— 前端传来的版本号只用于乐观并发检查（见 routes），
// 真正写进去的永远是「当前 + 1」。
export async function setSkillContext(
  env: Env,
  tenantId: number,
  skillRepo: string,
  content: string
): Promise<{ version: number }> {
  const current = await getSkillContextRow(env, tenantId, skillRepo);
  const version = (current?.version ?? 0) + 1;
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `INSERT INTO skill_context (tenant_id, skill_repo, content, version, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, skill_repo) DO UPDATE SET
       content = excluded.content, version = excluded.version, updated_at = excluded.updated_at`
  ).bind(tenantId, skillRepo, content, version, now).run();
  return { version };
}
