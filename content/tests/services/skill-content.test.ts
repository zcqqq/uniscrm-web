/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getSkillContent, refreshSkillContent } from "../../src/services/skill-content";

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
  });

  afterEach(() => vi.unstubAllGlobals());

  describe("getSkillContent", () => {
    it("returns null when the skill was never fetched", async () => {
      const content = await getSkillContent(env as any, "marketingskills-social");
      expect(content).toBeNull();
    });

    it("returns the cached content when present", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "# Social skill guide", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();

      const content = await getSkillContent(env as any, "marketingskills-social");
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

      const content = await getSkillContent(env as any, "marketingskills-social");
      expect(content).toBe("# Latest guide content");
    });

    it("overwrites stale cached content with the newly fetched version", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "old content", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("new content", { status: 200 })));

      await refreshSkillContent(env as any, "marketingskills-social");

      const content = await getSkillContent(env as any, "marketingskills-social");
      expect(content).toBe("new content");
    });

    it("leaves the existing cache untouched when the fetch fails", async () => {
      await env.CONTENT_DB.prepare(
        "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
      ).bind("marketingskills-social", "still good content", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));

      await expect(refreshSkillContent(env as any, "marketingskills-social")).rejects.toThrow("Fetch failed");

      const content = await getSkillContent(env as any, "marketingskills-social");
      expect(content).toBe("still good content");
    });
  });
});
