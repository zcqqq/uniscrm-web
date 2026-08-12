/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";

describe("GET /api/skills", () => {
  beforeEach(async () => {
    // sessionAuth resolves sessions from the WEB_DB binding (shared/auth.ts), not via an
    // HTTP hop to web.
    await seedSession(env as never, "ok", 77);
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

  it("returns 401 when the session check fails", async () => {
    // "bad" has no sessions row, so shared/auth.ts's resolveSession rejects it.
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/skills", { headers: { Cookie: "session=bad" } }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("lists the catalog with hasCachedContent: false when nothing was ever refreshed", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/skills", { headers: { Cookie: "session=ok" } }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: { id: string; label: string; hasCachedContent: boolean }[] }>();
    // Catalog now carries the full marketingskills trio (see content/src/skills/catalog.ts) --
    // all share one skill pack (repo) but each keeps its own cache row.
    expect(body.skills).toEqual([
      { id: "marketingskills-social", label: "Social (marketingskills)", hasCachedContent: false },
      { id: "marketingskills-image", label: "Image (marketingskills)", hasCachedContent: false },
      { id: "marketingskills-product-marketing", label: "Product Marketing (marketingskills)", hasCachedContent: false },
    ]);
  });

  it("reports hasCachedContent: true once a skill has been refreshed", async () => {
    await env.CONTENT_DB.prepare(
      "INSERT INTO skill_content_cache (skill_id, content, source_url, fetched_at) VALUES (?, ?, ?, ?)"
    ).bind("marketingskills-social", "# guide", "https://example.com/SKILL.md", "2026-01-01T00:00:00.000Z").run();

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/skills", { headers: { Cookie: "session=ok" } }),
      env
    );
    const body = await res.json<{ skills: { id: string; label: string; hasCachedContent: boolean }[] }>();
    expect(body.skills[0].hasCachedContent).toBe(true);
  });
});
