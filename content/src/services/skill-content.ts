import type { Env } from "../types";
import { getSkillDefinition } from "../skills/catalog";
import { UPLOAD_PREFIX, getTenantSkillContent } from "./tenant-skill";

// 两个来源：预置技能在全局的 skill_content_cache（跨租户共享，无 tenant_id），租户上传的在
// tenant_skill（租户私有）。只看 id 前缀分派，且 upload: 一律不回退查预置表——两张表若碰巧
// 有同名 id，回退就意味着 A 租户能读到一份本不属于它的正文。
export async function getSkillContent(
  env: Env,
  tenantId: number,
  skillId: string
): Promise<string | null> {
  if (skillId.startsWith(UPLOAD_PREFIX)) {
    return getTenantSkillContent(env, tenantId, skillId);
  }
  const row = await env.CONTENT_DB.prepare(
    "SELECT content FROM skill_content_cache WHERE skill_id = ?"
  ).bind(skillId).first<{ content: string }>();
  return row?.content ?? null;
}

// SKILL.md files push their hard requirements (e.g. X's 280-char limit) out to sibling
// reference docs like "[references/platform-limits.md](references/platform-limits.md)".
// The LLM only ever sees the cached text, so an un-inlined link is a dead end — the
// model was generating posts without ever seeing the platform limits.
const REFERENCE_LINK_RE = /\]\((references\/[\w./-]+\.md)\)/g;
const MAX_REFERENCE_FILES = 8;

export function extractReferenceLinks(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(REFERENCE_LINK_RE)) {
    seen.add(m[1]);
    if (seen.size >= MAX_REFERENCE_FILES) break;
  }
  return [...seen];
}

// Manual refresh only -- never called from the generation path. Only overwrites the
// cache when the main document AND every referenced file fetch successfully, so a
// GitHub outage/404 can't poison a working cache — not even with a partial version.
export async function refreshSkillContent(env: Env, skillId: string): Promise<void> {
  const def = getSkillDefinition(skillId);
  if (!def) throw new Error(`Unknown skill id: ${skillId}`);

  const res = await fetch(def.sourceUrl);
  if (!res.ok) throw new Error(`Fetch failed for skill ${skillId}: ${res.status}`);
  const mainContent = await res.text();

  const baseUrl = def.sourceUrl.slice(0, def.sourceUrl.lastIndexOf("/") + 1);
  const sections = [mainContent];
  for (const ref of extractReferenceLinks(mainContent)) {
    const refRes = await fetch(baseUrl + ref);
    if (!refRes.ok) throw new Error(`Fetch failed for skill ${skillId} reference ${ref}: ${refRes.status}`);
    sections.push(`\n\n---\n\n# Referenced file: ${ref}\n\n${await refRes.text()}`);
  }
  const content = sections.join("");
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       content = excluded.content, source_url = excluded.source_url, fetched_at = excluded.fetched_at`
  ).bind(skillId, content, def.sourceUrl, now).run();
}
