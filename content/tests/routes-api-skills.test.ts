/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";

// tenant_skill 表被 GET /api/skills（uploaded 分支）与 POST/DELETE 端点共用，vitest-pool-workers
// 不会自动跑 content/migrations，所以按同目录（tests/services/tenant-skill.test.ts）的惯例手建一次。
beforeAll(async () => {
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_skill (
       tenant_id INTEGER NOT NULL, skill_id TEXT NOT NULL, label TEXT NOT NULL,
       content TEXT NOT NULL, source TEXT NOT NULL, uploaded_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, skill_id))`
  ).run();
});

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
    await env.CONTENT_DB.prepare("DELETE FROM tenant_skill").run();
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
    const body = await res.json<{ skills: { id: string; label: string; hasCachedContent: boolean; uploaded: boolean }[] }>();
    // Catalog now carries the full marketingskills trio (see content/src/skills/catalog.ts) --
    // all share one skill pack (repo) but each keeps its own cache row. `uploaded: false` marks
    // them as preset -- no tenant_skill rows exist yet for tenant 77 in this test.
    expect(body.skills).toEqual([
      { id: "marketingskills-social", label: "Social (marketingskills)", hasCachedContent: false, uploaded: false },
      { id: "marketingskills-image", label: "Image (marketingskills)", hasCachedContent: false, uploaded: false },
      { id: "marketingskills-product-marketing", label: "Product Marketing (marketingskills)", hasCachedContent: false, uploaded: false },
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

const H = { Cookie: "session=ok", "Content-Type": "application/json" };
const call = (path: string, init: RequestInit) =>
  worker.fetch(new Request(`https://content-dev.uni-scrm.com${path}`, { headers: H, ...init }), env);

const oneSkill = (name: string, overwrite?: boolean) => ({
  name, source: `${name}.zip`, overwrite,
  files: [{ path: "SKILL.md", content: `---\nname: ${name}\n---\n\n# ${name}` }],
});

describe("POST /api/skills/import", () => {
  beforeEach(async () => {
    await seedSession(env as never, "ok", 77);
  });

  it("导入后出现在 /api/skills 里，标记为 uploaded", async () => {
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("mine")] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 1 });

    const list = await (await call("/api/skills", {})).json() as { skills: { id: string; uploaded: boolean }[] };
    expect(list.skills).toContainEqual(expect.objectContaining({ id: "upload:mine", uploaded: true }));
    // 预置项仍在，且没有被标成 uploaded
    expect(list.skills).toContainEqual(expect.objectContaining({ id: "marketingskills-social", uploaded: false }));
  });

  // 后端不信任前端的重名判断：两个标签页并发时，静默覆盖会让用户丢掉自己写的技能。
  // conflicts 带上提交时的 name（不只是 skillId）——前端判重按可编辑的 label，后端按
  // slug 后的 skillId，两者不是同一个等价关系，前端需要这个 name 才能精确映射回是哪一行
  // 提交的，而不必在前端重新实现一遍 slugify（Important 3）。
  it("重名且未授权 → 409 并回列冲突的 skillId 与提交时的 name", async () => {
    await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("dup")] }) });
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("dup")] }) });
    expect(res.status).toBe(409);
    expect((await res.json() as { conflicts: { skillId: string; name: string }[] }).conflicts)
      .toEqual([{ skillId: "upload:dup", name: "dup" }]);
  });

  // Important 1（final review）：两个名字 slugify 后撞到同一个 skillId 时，findExistingSkillIds
  // 只看 D1 里已有的行，两条都还没落库，409 判重会直接放过——upsert 的 ON CONFLICT 会让后写
  // 的一条悄悄吞掉先写的一条正文，response 却谎称两条都成功了（imported: 2）。必须在写库之前
  // 就把批内碰撞拦下来，不能只查已存在的行。
  it("批内两个名字 slugify 后撞到同一个 skillId → 拒绝，不出现 imported: 2 也不静默丢弃其中一条", async () => {
    const res = await call("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({
        skills: [
          { name: "Foo Bar", source: "a.zip", files: [{ path: "SKILL.md", content: "AAA" }] },
          { name: "foo  bar", source: "b.zip", files: [{ path: "SKILL.md", content: "BBB" }] },
        ],
      }),
    });
    expect(res.status).not.toBe(200);
    const body = await res.json() as { imported?: number };
    expect(body.imported).toBeUndefined();

    // 拒绝时两条都不落地——不能变成"后写的那条覆盖了先写的那条，只留一行在库里"。
    const list = await (await call("/api/skills", {})).json() as { skills: { id: string; label: string }[] };
    expect(list.skills.map((s) => s.id)).not.toContain("upload:foo-bar");
  });

  it("重名且带 overwrite → 覆盖那一行，不新增", async () => {
    await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("ow")] }) });
    const res = await call("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ skills: [{ ...oneSkill("ow", true), files: [{ path: "SKILL.md", content: "# 新版" }] }] }),
    });
    expect(res.status).toBe(200);
    const list = await (await call("/api/skills", {})).json() as { skills: { id: string }[] };
    expect(list.skills.filter((s) => s.id === "upload:ow")).toHaveLength(1);
  });

  it("单技能超过 256KB → 400", async () => {
    const big = { ...oneSkill("big"), files: [{ path: "SKILL.md", content: "a".repeat(256 * 1024 + 1) }] };
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [big] }) });
    expect(res.status).toBe(400);
  });

  it("单次超过 20 个技能 → 400", async () => {
    const many = Array.from({ length: 21 }, (_, i) => oneSkill(`m${i}`));
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: many }) });
    expect(res.status).toBe(400);
  });

  it("缺少 SKILL.md → 400", async () => {
    const bad = { name: "nomain", source: "x.zip", files: [{ path: "references/a.md", content: "x" }] };
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [bad] }) });
    expect(res.status).toBe(400);
  });

  // Task 1 review finding: 名字全是标点/emoji 时 slugifySkillName 返回空串，skillId 就退化成
  // 裸的 "upload:" —— 两个这样的名字会撞在同一个 (tenant_id, skill_id) 主键上、互相静默覆盖。
  it("技能名全是标点/emoji、slug 为空 → 400，不落地成裸的 upload:", async () => {
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("!!! 🎉")] }) });
    expect(res.status).toBe(400);

    const list = await (await call("/api/skills", {})).json() as { skills: { id: string }[] };
    expect(list.skills.map((s) => s.id)).not.toContain("upload:");
  });
});

describe("DELETE /api/skills/:id", () => {
  beforeEach(async () => {
    await seedSession(env as never, "ok", 77);
  });

  it("删掉上传的技能后不再出现在列表里", async () => {
    await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("gone")] }) });
    expect((await call("/api/skills/upload%3Agone", { method: "DELETE" })).status).toBe(200);
    const list = await (await call("/api/skills", {})).json() as { skills: { id: string }[] };
    expect(list.skills.map((s) => s.id)).not.toContain("upload:gone");
  });

  // 预置技能是全局共享的，一个租户删掉它等于替所有租户删。
  it("拒绝删除预置技能", async () => {
    expect((await call("/api/skills/marketingskills-social", { method: "DELETE" })).status).toBe(400);
  });
});
