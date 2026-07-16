import type { Env } from "../types";
import { getSkillDefinition } from "../skills/catalog";

export async function getSkillContent(env: Env, skillId: string): Promise<string | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT content FROM skill_content_cache WHERE skill_id = ?"
  ).bind(skillId).first<{ content: string }>();
  return row?.content ?? null;
}

// Manual refresh only -- never called from the generation path. Only overwrites the
// cache on a successful fetch so a GitHub outage/404 can't poison a working cache.
export async function refreshSkillContent(env: Env, skillId: string): Promise<void> {
  const def = getSkillDefinition(skillId);
  if (!def) throw new Error(`Unknown skill id: ${skillId}`);

  const res = await fetch(def.sourceUrl);
  if (!res.ok) throw new Error(`Fetch failed for skill ${skillId}: ${res.status}`);
  const content = await res.text();
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(skill_id) DO UPDATE SET
       content = excluded.content, source_url = excluded.source_url, fetched_at = excluded.fetched_at`
  ).bind(skillId, content, def.sourceUrl, now).run();
}
