import type { Env } from "../types";

// 上传技能的 id 前缀。预置 id 形如 "marketingskills-social"，加前缀后两个命名空间天然不撞，
// getSkillContent 也能只看前缀就知道该查哪张表。
export const UPLOAD_PREFIX = "upload:";

export function slugifySkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

export interface TenantSkillRow {
  skillId: string;
  label: string;
  source: string;
  uploadedAt: string;
  bytes: number;
}

export async function listTenantSkills(env: Env, tenantId: number): Promise<TenantSkillRow[]> {
  const rows = await env.CONTENT_DB.prepare(
    `SELECT skill_id, label, source, uploaded_at, length(content) AS bytes
     FROM tenant_skill WHERE tenant_id = ? ORDER BY uploaded_at DESC`
  ).bind(tenantId).all<{ skill_id: string; label: string; source: string; uploaded_at: string; bytes: number }>();
  return rows.results.map((r) => ({
    skillId: r.skill_id, label: r.label, source: r.source, uploadedAt: r.uploaded_at, bytes: r.bytes,
  }));
}

export async function getTenantSkillContent(
  env: Env, tenantId: number, skillId: string
): Promise<string | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT content FROM tenant_skill WHERE tenant_id = ? AND skill_id = ?"
  ).bind(tenantId, skillId).first<{ content: string }>();
  return row?.content ?? null;
}

export async function upsertTenantSkill(
  env: Env,
  tenantId: number,
  s: { skillId: string; label: string; content: string; source: string }
): Promise<void> {
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_skill (tenant_id, skill_id, label, content, source, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, skill_id) DO UPDATE SET
       label = excluded.label, content = excluded.content,
       source = excluded.source, uploaded_at = excluded.uploaded_at`
  ).bind(tenantId, s.skillId, s.label, s.content, s.source, now).run();
}

export async function deleteTenantSkill(env: Env, tenantId: number, skillId: string): Promise<void> {
  await env.CONTENT_DB.prepare(
    "DELETE FROM tenant_skill WHERE tenant_id = ? AND skill_id = ?"
  ).bind(tenantId, skillId).run();
}

// 导入前的重名检查。空数组直接短路：D1 不接受空的 IN (...)，而"没有要检查的"本来也不该查库。
export async function findExistingSkillIds(
  env: Env, tenantId: number, skillIds: string[]
): Promise<string[]> {
  if (skillIds.length === 0) return [];
  const placeholders = skillIds.map(() => "?").join(",");
  const rows = await env.CONTENT_DB.prepare(
    `SELECT skill_id FROM tenant_skill WHERE tenant_id = ? AND skill_id IN (${placeholders})`
  ).bind(tenantId, ...skillIds).all<{ skill_id: string }>();
  return rows.results.map((r) => r.skill_id);
}
