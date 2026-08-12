/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getSkillContent, refreshSkillContent } from "../../src/services/skill-content";
import { UPLOAD_PREFIX, upsertTenantSkill } from "../../src/services/tenant-skill";

describe("skill-content", () => {
  beforeEach(async () => {
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS skill_content_cache (
         skill_id TEXT PRIMARY KEY,
         content TEXT NOT NULL,
         source_url TEXT NOT NULL,
         fetched_at TEXT NOT NULL
       )`
    ).run();
    await env.CONTENT_DB.prepare("DELETE FROM skill_content_cache").run();
    await env.CONTENT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tenant_skill (
         tenant_id   INTEGER NOT NULL,
         skill_id    TEXT NOT NULL,
         label       TEXT NOT NULL,
         content     TEXT NOT NULL,
         source      TEXT NOT NULL,
         uploaded_at TEXT NOT NULL,
         PRIMARY KEY (tenant_id, skill_id)
       )`
    ).run();
    await env.CONTENT_DB.prepare("DELETE FROM tenant_skill").run();
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("getSkillContent", () => {
    it("returns null when the skill was never fetched", async () => {
      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBeNull();
    });

    it("returns the cached content when present", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "# Social skill guide", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBe("# Social skill guide");
    });
  });

  describe("refreshSkillContent", () => {
    it("throws for an unknown skill id without making any network call", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshSkillContent(env as any, "not-a-real-skill")).rejects.toThrow("Unknown skill id");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fetches and stores the skill content on success", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("# Latest guide content", { status: 200 })));

      await refreshSkillContent(env as any, "marketingskills-social");

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBe("# Latest guide content");
    });

    it("overwrites stale cached content with the newly fetched version", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "old content", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("new content", { status: 200 })));

      await refreshSkillContent(env as any, "marketingskills-social");

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBe("new content");
    });

    it("inlines referenced files after the main document, resolved against the source URL", async () => {
      const main = [
        "# Social Content",
        "**For detailed platform strategies**: See [references/platforms.md](references/platforms.md)",
        "**For hashtag limits and character counts**: See [references/platform-limits.md](references/platform-limits.md)",
        "Mentioned twice: [references/platform-limits.md](references/platform-limits.md)",
      ].join("\n");
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/SKILL.md")) return new Response(main, { status: 200 });
        if (String(url).endsWith("/references/platforms.md")) return new Response("## Platforms detail", { status: 200 });
        if (String(url).endsWith("/references/platform-limits.md")) return new Response("| Max tweet chars | 280 |", { status: 200 });
        return new Response("Not Found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await refreshSkillContent(env as any, "marketingskills-social");

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toContain("# Social Content");
      expect(content).toContain("# Referenced file: references/platforms.md\n\n## Platforms detail");
      expect(content).toContain("# Referenced file: references/platform-limits.md\n\n| Max tweet chars | 280 |");
      // deduped: the twice-linked file is fetched and inlined once
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/references/platform-limits.md")).length).toBe(1);
      expect(content!.split("# Referenced file: references/platform-limits.md").length).toBe(2);
      // resolved against the skill's source URL directory
      expect(fetchMock).toHaveBeenCalledWith(
        "https://raw.githubusercontent.com/coreyhaines31/marketingskills/main/skills/social/references/platform-limits.md"
      );
      // main document comes first
      expect(content!.indexOf("# Social Content")).toBeLessThan(content!.indexOf("# Referenced file:"));
    });

    it("leaves the cache untouched when a referenced file fails to fetch (no partial cache)", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "complete old content", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/SKILL.md")) {
          return new Response("main [references/platform-limits.md](references/platform-limits.md)", { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(refreshSkillContent(env as any, "marketingskills-social")).rejects.toThrow("Fetch failed");

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBe("complete old content");
    });

    it("leaves the existing cache untouched when the fetch fails", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "still good content", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));

      await expect(refreshSkillContent(env as any, "marketingskills-social")).rejects.toThrow("Fetch failed");

      const content = await getSkillContent(env as any, 1, "marketingskills-social");
      expect(content).toBe("still good content");
    });
  });

  describe("getSkillContent 的双来源分派", () => {
    it("非 upload: 前缀走全局预置表，与租户无关", async () => {
      await env.CONTENT_DB.prepare(
        `INSERT OR REPLACE INTO skill_content_cache (skill_id, content, source_url, fetched_at)
         VALUES ('preset-x', '预置正文', 'https://example/SKILL.md', '2026-01-01T00:00:00Z')`
      ).run();
      // 两个不同租户读同一个预置技能，拿到的是同一份
      expect(await getSkillContent(env as never, 8201, "preset-x")).toBe("预置正文");
      expect(await getSkillContent(env as never, 8202, "preset-x")).toBe("预置正文");
    });

    it("upload: 前缀走租户表，且绑定 tenant_id", async () => {
      await upsertTenantSkill(env as never, 8203, {
        skillId: `${UPLOAD_PREFIX}mine`, label: "Mine", content: "8203 的正文", source: "m.md",
      });
      expect(await getSkillContent(env as never, 8203, `${UPLOAD_PREFIX}mine`)).toBe("8203 的正文");
      // 另一个租户读同一个 id：读不到，不是读到别人的
      expect(await getSkillContent(env as never, 8204, `${UPLOAD_PREFIX}mine`)).toBeNull();
    });

    // 两张表都可能有同名行时不能串台：upload: 前缀永远只看租户表。
    it("upload: 前缀不会回退去查预置表", async () => {
      await env.CONTENT_DB.prepare(
        `INSERT OR REPLACE INTO skill_content_cache (skill_id, content, source_url, fetched_at)
         VALUES ('upload:trap', '不该被读到', 'https://example/SKILL.md', '2026-01-01T00:00:00Z')`
      ).run();
      expect(await getSkillContent(env as never, 8205, "upload:trap")).toBeNull();
    });
  });
});
