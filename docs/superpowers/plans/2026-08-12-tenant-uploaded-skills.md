# 租户上传技能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让租户上传自己的 skill（zip 包、文件夹或单个 SKILL.md），在 flow 节点的技能下拉里选择它，与预置技能走同一条注入链路。

**Architecture:** 解包在浏览器端完成——纯函数把 zip/文件夹/单文件拆成 `{ name, files }`，后端只收干净 JSON，因此完全不碰 zip。上传的技能存进新表 `tenant_skill`（租户私有），预置的 `skill_content_cache`（全局共享）一个字节不动；`getSkillContent` 按 `upload:` 前缀分派到两张表，全仓库只有一个调用点要改。

**Tech Stack:** Cloudflare Workers（Hono）、D1、vitest + `@cloudflare/vitest-pool-workers`、React（无 DOM 测试环境）、`fflate`（浏览器端解 zip）

**Spec:** `docs/superpowers/specs/2026-08-12-tenant-uploaded-skills-design.md`

## Global Constraints

- **上传的与预置的并列，各自独立。** 不覆盖、不替换预置；下拉里同时出现。
- **上传的技能不注入租户上下文。** 这是现有代码的自然行为、**零改动**：`getSkillDefinition("upload:…")` 在 `SKILL_CATALOG` 里找不到 → `repo` 为 `undefined` → `generate.ts` 不查也不注入。不要为它写任何新代码，也不要"顺手"让它注入。
- **`skill_content_cache` 一个字节不动。** 那张表没有 `tenant_id`，建表注释写明跨租户共享；混进租户私有内容就是一次跨租户泄漏。
- **租户隔离**：`tenant_skill` 的每一次读写都必须绑定 `tenant_id`。
- **后端不信任前端的重名判断**：若某个 `skill_id` 已存在而请求没有 `overwrite: true`，整个请求以 **409** 拒绝并回列冲突的名字。
- **后端不解压。** 不引入任何解压库到 `content/src/`；`fflate` 只进前端。
- 体量上限：**单技能 256KB，单次导入 20 个技能**。
- references 内联沿用现有 `extractReferenceLinks` 的 **8 个上限**，不要新造一套。
- 只取 `SKILL.md` 与 `references/**/*.md`，其余（`evals/`、图片、脚本）丢弃。
- frontmatter 只用正则取 `name:` 一行，**不要引入 YAML 解析库**——我们不消费其余字段。
- 所有面向用户的文案必须 `{ en, zh }` 双语；品牌名不翻译。
- 前端不用 inline CSS，全部用 `shared/frontend/ui/` 下的共享组件。
- 提交只 `git add` 明确列出的路径，**禁止 `git add -A`**（本仓库有其他 session 的未提交文件）。不要 push；dev 部署一律用模块目录下的 `npm run deploy:dev`。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `content/migrations/0009_tenant_skill.sql` | `tenant_skill` 表 | 1 |
| `content/src/services/tenant-skill.ts` | 租户技能的增删查（全部绑 tenant_id）（新建） | 1 |
| `content/src/services/skill-content.ts` | `getSkillContent` 双来源分派 + 从内存文件内联 references | 2, 3 |
| `content/src/services/generate.ts:27` | 唯一调用点，多传 tenantId | 2 |
| `content/src/index.ts` | `/api/skills` 合并、`/api/skills/import`、`DELETE /api/skills/:id` | 3 |
| `content/frontend/lib/skill-package.ts` | 纯函数：文件清单 → 技能清单（新建） | 4 |
| `content/package.json` | `fflate` 依赖 | 5 |
| `content/frontend/components/SkillUploadCard.tsx` | 上传卡片（新建） | 5 |
| `content/frontend/lib/api.ts`、`pages/SettingsPage.tsx` | 客户端方法 + 挂载 | 5 |
| dev 部署 + 自测 | | 6 |

---

### Task 1: content — tenant_skill 表与服务

**Files:**
- Create: `content/migrations/0009_tenant_skill.sql`
- Create: `content/src/services/tenant-skill.ts`
- Test: `content/tests/services/tenant-skill.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `UPLOAD_PREFIX = "upload:"`
  - `slugifySkillName(name: string): string`
  - `interface TenantSkillRow { skillId: string; label: string; source: string; uploadedAt: string; bytes: number }`
  - `listTenantSkills(env: Env, tenantId: number): Promise<TenantSkillRow[]>`
  - `getTenantSkillContent(env: Env, tenantId: number, skillId: string): Promise<string | null>`
  - `upsertTenantSkill(env, tenantId, s: { skillId: string; label: string; content: string; source: string }): Promise<void>`
  - `deleteTenantSkill(env: Env, tenantId: number, skillId: string): Promise<void>`
  - `findExistingSkillIds(env: Env, tenantId: number, skillIds: string[]): Promise<string[]>`

- [ ] **Step 1: 写 migration**

创建 `content/migrations/0009_tenant_skill.sql`：

```sql
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
```

- [ ] **Step 2: 写失败测试**

创建 `content/tests/services/tenant-skill.test.ts`。**注意本仓库的测试环境事实**：vitest pool 不会自动跑 `content/migrations/*.sql`，同目录既有测试文件都是自己手写 `CREATE TABLE IF NOT EXISTS`——照抄那个写法。

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  UPLOAD_PREFIX, slugifySkillName, listTenantSkills, getTenantSkillContent,
  upsertTenantSkill, deleteTenantSkill, findExistingSkillIds,
} from "../../src/services/tenant-skill";

beforeAll(async () => {
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_skill (
       tenant_id INTEGER NOT NULL, skill_id TEXT NOT NULL, label TEXT NOT NULL,
       content TEXT NOT NULL, source TEXT NOT NULL, uploaded_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, skill_id))`
  ).run();
});

describe("slugifySkillName", () => {
  it("小写化并把非字母数字压成单个连字符", () => {
    expect(slugifySkillName("Social Media")).toBe("social-media");
    expect(slugifySkillName("公司内部/文案 规范")).toBe("公司内部-文案-规范");
    expect(slugifySkillName("  a__b  ")).toBe("a-b");
  });
});

describe("tenant skill 存取", () => {
  it("没写过就是 null / 空列表", async () => {
    expect(await getTenantSkillContent(env as never, 8101, "upload:x")).toBeNull();
    expect(await listTenantSkills(env as never, 8101)).toEqual([]);
  });

  it("写入后可读回，列表带上元信息与字节数", async () => {
    await upsertTenantSkill(env as never, 8102, {
      skillId: `${UPLOAD_PREFIX}social`, label: "Social", content: "# hi", source: "social.zip",
    });
    expect(await getTenantSkillContent(env as never, 8102, `${UPLOAD_PREFIX}social`)).toBe("# hi");
    const list = await listTenantSkills(env as never, 8102);
    expect(list).toEqual([
      expect.objectContaining({ skillId: `${UPLOAD_PREFIX}social`, label: "Social", source: "social.zip", bytes: 4 }),
    ]);
  });

  it("同 id 重写覆盖，不新增行", async () => {
    await upsertTenantSkill(env as never, 8103, { skillId: `${UPLOAD_PREFIX}a`, label: "A", content: "v1", source: "a.md" });
    await upsertTenantSkill(env as never, 8103, { skillId: `${UPLOAD_PREFIX}a`, label: "A", content: "v2", source: "a2.md" });
    expect(await getTenantSkillContent(env as never, 8103, `${UPLOAD_PREFIX}a`)).toBe("v2");
    expect(await listTenantSkills(env as never, 8103)).toHaveLength(1);
  });

  // 隔离是这张表存在的全部理由：一个租户读到另一个租户上传的正文，就等于把私有资料喂进了对方的提示词。
  it("按 tenant_id 隔离：读、列、删都不越界", async () => {
    await upsertTenantSkill(env as never, 8104, { skillId: `${UPLOAD_PREFIX}s`, label: "S", content: "A 的", source: "a.md" });
    await upsertTenantSkill(env as never, 8105, { skillId: `${UPLOAD_PREFIX}s`, label: "S", content: "B 的", source: "b.md" });

    expect(await getTenantSkillContent(env as never, 8104, `${UPLOAD_PREFIX}s`)).toBe("A 的");
    expect(await getTenantSkillContent(env as never, 8105, `${UPLOAD_PREFIX}s`)).toBe("B 的");

    await deleteTenantSkill(env as never, 8104, `${UPLOAD_PREFIX}s`);
    expect(await getTenantSkillContent(env as never, 8104, `${UPLOAD_PREFIX}s`)).toBeNull();
    expect(await getTenantSkillContent(env as never, 8105, `${UPLOAD_PREFIX}s`)).toBe("B 的");
  });

  it("findExistingSkillIds 只回本租户已存在的那些", async () => {
    await upsertTenantSkill(env as never, 8106, { skillId: `${UPLOAD_PREFIX}p`, label: "P", content: "x", source: "p.md" });
    await upsertTenantSkill(env as never, 8107, { skillId: `${UPLOAD_PREFIX}q`, label: "Q", content: "x", source: "q.md" });
    expect(await findExistingSkillIds(env as never, 8106, [`${UPLOAD_PREFIX}p`, `${UPLOAD_PREFIX}q`]))
      .toEqual([`${UPLOAD_PREFIX}p`]);
  });

  it("findExistingSkillIds 传空数组时不查库也不报错", async () => {
    expect(await findExistingSkillIds(env as never, 8106, [])).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/tenant-skill.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现**

创建 `content/src/services/tenant-skill.ts`：

```ts
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
```

- [ ] **Step 5: 跑全套 content 测试**

Run: `cd content && npx vitest run`
Expected: PASS。（绿色汇总后出现 "close timed out after 10000ms" / "something prevents Vite server from exiting" 是本仓库已知噪音。）

- [ ] **Step 6: 提交**

```bash
git add content/migrations/0009_tenant_skill.sql content/src/services/tenant-skill.ts content/tests/services/tenant-skill.test.ts
git commit -m "feat(content): store tenant-uploaded skills in a tenant-scoped table"
```

---

### Task 2: content — getSkillContent 双来源分派

**Files:**
- Modify: `content/src/services/skill-content.ts:4-9`
- Modify: `content/src/services/generate.ts:27`
- Test: `content/tests/services/skill-content.test.ts`, `content/tests/generate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `UPLOAD_PREFIX`、`getTenantSkillContent`
- Produces: `getSkillContent(env: Env, tenantId: number, skillId: string): Promise<string | null>`（**多了 tenantId 参数，位置在中间**）

- [ ] **Step 1: 写失败测试**

`content/tests/services/skill-content.test.ts` 追加（该文件已有 `skill_content_cache` 的建表与写入写法，照它加 `tenant_skill`）：

```ts
import { UPLOAD_PREFIX } from "../../src/services/tenant-skill";

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
```

`content/tests/generate.test.ts`：把所有 `getSkillContent` 的 spy 断言改为期待三个参数，并加一条：

```ts
it("把 tenantId 传给 getSkillContent，让上传技能能按租户取到", async () => {
  const spy = vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
  const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
  const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

  await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
    ...baseParams, tenantId: 4242, skillId: "upload:mine",
  });

  expect(spy).toHaveBeenCalledWith(expect.anything(), 4242, "upload:mine");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/skill-content.test.ts tests/generate.test.ts`
Expected: FAIL —— 签名不符 / upload 分支不存在。

- [ ] **Step 3: 实现**

`content/src/services/skill-content.ts` 的 `getSkillContent` 改为：

```ts
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
```

`content/src/services/generate.ts` 第 27 行改为：

```ts
  const skillContent = useSkill ? (await getSkillContent(env, params.tenantId, params.skillId!)) ?? undefined : undefined;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add content/src/services/skill-content.ts content/src/services/generate.ts content/tests/services/skill-content.test.ts content/tests/generate.test.ts
git commit -m "feat(content): dispatch skill lookup between preset and tenant-uploaded sources"
```

---

### Task 3: content — 导入、列出与删除的 HTTP 接口

**Files:**
- Modify: `content/src/services/skill-content.ts`（新增内联函数）
- Modify: `content/src/index.ts:143-149`
- Test: `content/tests/routes-api-skills.test.ts`, `content/tests/services/skill-content.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `tenant-skill.ts` 全部导出；现有 `extractReferenceLinks`
- Produces:
  - `inlineReferencesFromFiles(files: { path: string; content: string }[]): string`
  - `POST /api/skills/import` body `{ skills: { name: string; source: string; overwrite?: boolean; files: { path: string; content: string }[] }[] }` → `{ imported: number }`；重名未授权 → **409** `{ error, conflicts: string[] }`；超限 → 400
  - `GET /api/skills` → `{ skills: { id, label, hasCachedContent, uploaded: boolean }[] }`
  - `DELETE /api/skills/:id` → `{ ok: true }`（只允许删 `upload:` 开头的）

- [ ] **Step 1: 写内联函数的失败测试**

`content/tests/services/skill-content.test.ts` 追加：

```ts
import { inlineReferencesFromFiles } from "../../src/services/skill-content";

describe("inlineReferencesFromFiles", () => {
  it("把 SKILL.md 里链接到的 references 从同一批文件里内联进来", () => {
    const out = inlineReferencesFromFiles([
      { path: "SKILL.md", content: "# S\n\nSee [references/limits.md](references/limits.md)." },
      { path: "references/limits.md", content: "280 chars." },
    ]);
    expect(out).toContain("# S");
    expect(out).toContain("# Referenced file: references/limits.md");
    expect(out).toContain("280 chars.");
  });

  // 链接指向的文件没随包上传时不能整个失败——正文本身仍然有价值。
  it("链接指向的文件缺失时跳过它，其余照常", () => {
    const out = inlineReferencesFromFiles([
      { path: "SKILL.md", content: "[references/gone.md](references/gone.md) 和 [references/here.md](references/here.md)" },
      { path: "references/here.md", content: "在的" },
    ]);
    expect(out).toContain("在的");
    expect(out).not.toContain("references/gone.md\n\n");
  });

  it("没有 SKILL.md 时抛错", () => {
    expect(() => inlineReferencesFromFiles([{ path: "references/a.md", content: "x" }]))
      .toThrow(/SKILL\.md/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/skill-content.test.ts`
Expected: FAIL —— 函数不存在。

- [ ] **Step 3: 实现内联函数**

`content/src/services/skill-content.ts` 追加。**复用现有 `extractReferenceLinks`**（含它的 8 个上限），不要新造：

```ts
// 与 refreshSkillContent 内联 references 的规则完全一致，只是来源从 fetch 换成上传的这批文件
// ——同一套 extractReferenceLinks（含 8 个上限），产出的拼接格式也刻意一模一样，这样预置技能
// 与上传技能进到模型眼里的形状没有差别。
export function inlineReferencesFromFiles(files: { path: string; content: string }[]): string {
  const main = files.find((f) => f.path === "SKILL.md");
  if (!main) throw new Error("Missing SKILL.md");

  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const sections = [main.content];
  for (const ref of extractReferenceLinks(main.content)) {
    const body = byPath.get(ref);
    // 链接指向的文件没随包上传：跳过而不是整个失败 —— 正文本身仍然有价值，
    // 而缺一份参考资料并不比"技能里根本没有这个链接"更糟。
    if (body === undefined) continue;
    sections.push(`\n\n---\n\n# Referenced file: ${ref}\n\n${body}`);
  }
  return sections.join("");
}
```

- [ ] **Step 4: 写端点的失败测试**

`content/tests/routes-api-skills.test.ts` 追加（该文件已有 `seedSession` 与 worker fetch 的写法，照它写；`tenant_skill` 表按同目录惯例在 `beforeAll` 手建）：

```ts
const H = { Cookie: "session=ok", "Content-Type": "application/json" };
const call = (path: string, init: RequestInit) =>
  worker.fetch(new Request(`https://content-dev.uni-scrm.com${path}`, { headers: H, ...init }), env);

const oneSkill = (name: string, overwrite?: boolean) => ({
  name, source: `${name}.zip`, overwrite,
  files: [{ path: "SKILL.md", content: `---\nname: ${name}\n---\n\n# ${name}` }],
});

describe("POST /api/skills/import", () => {
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
  it("重名且未授权 → 409 并回列冲突名", async () => {
    await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("dup")] }) });
    const res = await call("/api/skills/import", { method: "POST", body: JSON.stringify({ skills: [oneSkill("dup")] }) });
    expect(res.status).toBe(409);
    expect((await res.json() as { conflicts: string[] }).conflicts).toEqual(["upload:dup"]);
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
});

describe("DELETE /api/skills/:id", () => {
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
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd content && npx vitest run tests/routes-api-skills.test.ts`
Expected: FAIL —— 端点 404 / 响应缺 `uploaded` 字段。

- [ ] **Step 6: 实现端点**

`content/src/index.ts`。`/api/skills/*` 的 `sessionAuth` 已注册（Hono 的 `/*` 也匹配裸路径），**不要再注册一次**——本文件 `/api/llm-credentials` 上方的注释解释了重复注册会让中间件跑两遍、二次消费其内部 fetch 的 Response body。

```ts
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILLS_PER_IMPORT = 20;

app.get("/api/skills", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const cached = await c.env.CONTENT_DB.prepare("SELECT skill_id FROM skill_content_cache").all<{ skill_id: string }>();
  const cachedIds = new Set(cached.results.map((r) => r.skill_id));
  const preset = SKILL_CATALOG.map((s) => ({
    id: s.id, label: s.label, hasCachedContent: cachedIds.has(s.id), uploaded: false,
  }));
  // 上传的技能内容随行存储，不存在"尚未抓取"这个状态，所以 hasCachedContent 恒为 true。
  const uploaded = (await listTenantSkills(c.env, tenantId)).map((s) => ({
    id: s.skillId, label: s.label, hasCachedContent: true, uploaded: true,
  }));
  return c.json({ skills: [...preset, ...uploaded] });
});

app.post("/api/skills/import", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { skills } = await c.req.json<{
    skills: { name: string; source: string; overwrite?: boolean; files: { path: string; content: string }[] }[];
  }>();

  if (!Array.isArray(skills) || skills.length === 0) return c.json({ error: "skills required" }, 400);
  if (skills.length > MAX_SKILLS_PER_IMPORT) {
    return c.json({ error: `At most ${MAX_SKILLS_PER_IMPORT} skills per import` }, 400);
  }

  const prepared: { skillId: string; label: string; content: string; source: string; overwrite: boolean }[] = [];
  for (const s of skills) {
    if (!s.name || !Array.isArray(s.files)) return c.json({ error: "each skill needs name and files" }, 400);
    let content: string;
    try {
      content = inlineReferencesFromFiles(s.files);
    } catch {
      return c.json({ error: `Skill "${s.name}" has no SKILL.md` }, 400);
    }
    if (content.length > MAX_SKILL_BYTES) {
      return c.json({ error: `Skill "${s.name}" exceeds ${MAX_SKILL_BYTES} characters` }, 400);
    }
    prepared.push({
      skillId: UPLOAD_PREFIX + slugifySkillName(s.name),
      label: s.name, content, source: s.source || s.name, overwrite: !!s.overwrite,
    });
  }

  // 后端自己查重名，不信前端传来的判断：两个标签页并发、或列表过期时，静默覆盖会让用户
  // 丢掉自己写的技能。只有显式带 overwrite 的才放行。
  const existing = new Set(await findExistingSkillIds(c.env, tenantId, prepared.map((p) => p.skillId)));
  const conflicts = prepared.filter((p) => existing.has(p.skillId) && !p.overwrite).map((p) => p.skillId);
  if (conflicts.length > 0) {
    return c.json({ error: "Some skills already exist", conflicts }, 409);
  }

  for (const p of prepared) {
    await upsertTenantSkill(c.env, tenantId, { skillId: p.skillId, label: p.label, content: p.content, source: p.source });
  }
  return c.json({ imported: prepared.length });
});

app.delete("/api/skills/:id", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const skillId = decodeURIComponent(c.req.param("id"));
  // 预置技能存在全局表里、所有租户共享，一个租户删掉它等于替所有人删。
  if (!skillId.startsWith(UPLOAD_PREFIX)) {
    return c.json({ error: "Only uploaded skills can be deleted" }, 400);
  }
  await deleteTenantSkill(c.env, tenantId, skillId);
  return c.json({ ok: true });
});
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add content/src/services/skill-content.ts content/src/index.ts content/tests/routes-api-skills.test.ts content/tests/services/skill-content.test.ts
git commit -m "feat(content): import, list and delete tenant-uploaded skills over HTTP"
```

---

### Task 4: content 前端 — 拆包纯函数

**Files:**
- Create: `content/frontend/lib/skill-package.ts`
- Modify: `content/package.json`（加 `fflate`）
- Test: `content/tests/skill-package.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface UploadFile { path: string; content: string }`
  - `interface ParsedSkill { name: string; files: UploadFile[]; bytes: number }`
  - `parseSkillFiles(entries: { path: string; text: string }[]): ParsedSkill[]`
  - `unzipToEntries(bytes: Uint8Array): { path: string; text: string }[]`

**关于依赖**：ZIP 的容器格式（中央目录）原生 `DecompressionStream` 解不了——它只做 gzip/deflate 裸流。所以需要 `fflate`（约 8KB，浏览器端可用）。`cd content && npm install fflate`。**它只进前端，`content/src/` 里不得出现**。

- [ ] **Step 1: 写失败测试**

创建 `content/tests/skill-package.test.ts`。用 `fflate` 的 `zipSync` 现造 zip 夹具，zip 这条路径因此是真跑的：

```ts
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseSkillFiles, unzipToEntries } from "../frontend/lib/skill-package";

const md = (name: string) => `---\nname: ${name}\n---\n\n# ${name}`;

describe("parseSkillFiles — 单技能", () => {
  it("根目录有 SKILL.md 就是单技能，名字取 frontmatter 的 name", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("social") },
      { path: "references/limits.md", text: "280" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("social");
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/limits.md"]);
  });

  it("frontmatter 没有 name 时退回目录名", () => {
    const out = parseSkillFiles([{ path: "my-skill/SKILL.md", text: "# 无 frontmatter" }]);
    expect(out[0].name).toBe("my-skill");
  });

  it("单个 .md 文件视作只有 SKILL.md 的技能，名字取文件名", () => {
    const out = parseSkillFiles([{ path: "内部文案规范.md", text: "# 规范" }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("内部文案规范");
    expect(out[0].files).toEqual([{ path: "SKILL.md", content: "# 规范" }]);
  });
});

describe("parseSkillFiles — 整包", () => {
  it("每个含 SKILL.md 的子目录各成一个技能，路径按技能目录归一化", () => {
    const out = parseSkillFiles([
      { path: "skills/social/SKILL.md", text: md("social") },
      { path: "skills/social/references/a.md", text: "A" },
      { path: "skills/image/SKILL.md", text: md("image") },
    ]);
    expect(out.map((s) => s.name).sort()).toEqual(["image", "social"]);
    const social = out.find((s) => s.name === "social")!;
    // 归一化很关键：inlineReferencesFromFiles 按 SKILL.md 里的 "references/a.md" 原样查表
    expect(social.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });
});

describe("parseSkillFiles — 过滤与上限", () => {
  it("丢弃非 .md 与 evals/", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("s") },
      { path: "references/a.md", text: "A" },
      { path: "evals/case1.md", text: "E" },
      { path: "logo.png", text: "binary" },
      { path: "run.sh", text: "#!/bin/sh" },
    ]);
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("references 超过 8 个时只取前 8", () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ path: `references/r${i}.md`, text: `${i}` }));
    const out = parseSkillFiles([{ path: "SKILL.md", text: md("s") }, ...refs]);
    expect(out[0].files.filter((f) => f.path.startsWith("references/"))).toHaveLength(8);
  });

  it("既没有根 SKILL.md 也没有含 SKILL.md 的子目录 → 抛错", () => {
    expect(() => parseSkillFiles([{ path: "readme.md", text: "x" }, { path: "a/b.md", text: "y" }]))
      .toThrow(/SKILL\.md/);
  });

  it("空清单 → 抛错", () => {
    expect(() => parseSkillFiles([])).toThrow(/SKILL\.md/);
  });
});

describe("unzipToEntries", () => {
  it("解出 zip 里的文本文件，忽略目录条目", () => {
    const zip = zipSync({
      "social/SKILL.md": strToU8(md("social")),
      "social/references/a.md": strToU8("A"),
    });
    const entries = unzipToEntries(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(["social/SKILL.md", "social/references/a.md"]);
    expect(entries.find((e) => e.path.endsWith("a.md"))!.text).toBe("A");
  });

  it("解出来的清单能直接喂给 parseSkillFiles", () => {
    const zip = zipSync({ "SKILL.md": strToU8(md("z")), "references/r.md": strToU8("R") });
    const out = parseSkillFiles(unzipToEntries(zip));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("z");
  });
});
```

- [ ] **Step 2: 装依赖并跑测试确认失败**

Run: `cd content && npm install fflate && npx vitest run tests/skill-package.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `content/frontend/lib/skill-package.ts`：

```ts
import { unzipSync, strFromU8 } from "fflate";

// 与后端 extractReferenceLinks 同一个上限：内联超过 8 份参考资料的收益递减，而每一份都要
// 进模型的系统提示词。两处保持一致，免得前端放进去、后端又丢掉。
const MAX_REFERENCE_FILES = 8;

export interface UploadFile {
  path: string;
  content: string;
}

export interface ParsedSkill {
  name: string;
  files: UploadFile[];
  bytes: number;
}

export function unzipToEntries(bytes: Uint8Array): { path: string; text: string }[] {
  const unzipped = unzipSync(bytes);
  return Object.entries(unzipped)
    // zip 里的目录是以 "/" 结尾的零长条目，不是文件
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path, text: strFromU8(data) }));
}

function frontmatterName(text: string): string | null {
  // frontmatter 是文件开头 --- 包起来的 YAML。我们只消费 name 一个字段，用正则取出即可，
  // 不值得为此引入 YAML 解析库。
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const nameLine = fm[1].match(/^name:\s*(.+)$/m);
  return nameLine?.[1].trim().replace(/^["']|["']$/g, "") || null;
}

function keepFile(relPath: string): boolean {
  if (relPath === "SKILL.md") return true;
  return relPath.startsWith("references/") && relPath.endsWith(".md");
}

function buildSkill(dir: string, entries: { path: string; text: string }[]): ParsedSkill {
  const prefix = dir ? `${dir}/` : "";
  const kept: UploadFile[] = [];
  let refCount = 0;
  let main = "";

  for (const e of entries) {
    const rel = e.path.slice(prefix.length);
    if (!keepFile(rel)) continue;
    if (rel === "SKILL.md") {
      main = e.text;
      kept.unshift({ path: rel, content: e.text });
    } else {
      if (refCount >= MAX_REFERENCE_FILES) continue;
      refCount++;
      kept.push({ path: rel, content: e.text });
    }
  }

  const dirName = dir.split("/").filter(Boolean).pop() ?? "";
  const name = frontmatterName(main) ?? dirName;
  return { name, files: kept, bytes: kept.reduce((n, f) => n + f.content.length, 0) };
}

export function parseSkillFiles(entries: { path: string; text: string }[]): ParsedSkill[] {
  // 单个 .md：当成"只有 SKILL.md、没有 references"的技能，名字用文件名。
  if (entries.length === 1 && entries[0].path.endsWith(".md") && !entries[0].path.endsWith("SKILL.md")) {
    const file = entries[0];
    const base = file.path.split("/").pop()!.replace(/\.md$/, "");
    return [{
      name: frontmatterName(file.text) ?? base,
      files: [{ path: "SKILL.md", content: file.text }],
      bytes: file.text.length,
    }];
  }

  // 每个 SKILL.md 决定一个技能目录；根目录的 SKILL.md 对应空前缀。
  const skillDirs = entries
    .filter((e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -"/SKILL.md".length)));

  if (skillDirs.length === 0) {
    throw new Error("No SKILL.md found — expected a skill folder or a package of skill folders");
  }

  return skillDirs.map((dir) =>
    buildSkill(dir, entries.filter((e) => (dir ? e.path.startsWith(`${dir}/`) : true)))
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS。`content/src/services/video-action/transcribe.ts` 里那条 `Buffer` 类型错误是**先于本计划存在**的，不是你的。

- [ ] **Step 5: 提交**

```bash
git add content/package.json content/package-lock.json content/frontend/lib/skill-package.ts content/tests/skill-package.test.ts
git commit -m "feat(content): parse uploaded skill packages in the browser"
```

---

### Task 5: content 前端 — 上传卡片

**Files:**
- Create: `content/frontend/components/SkillUploadCard.tsx`
- Modify: `content/frontend/lib/api.ts`, `content/frontend/pages/SettingsPage.tsx`
- Test: `content/tests/skill-upload-card.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的三个端点；Task 4 的 `parseSkillFiles` / `unzipToEntries` / `ParsedSkill`
- Produces: 无（叶子）

- [ ] **Step 1: 写接线测试**

创建 `content/tests/skill-upload-card.test.ts`。**本仓库的前端测试事实**：vitest pool 是 workerd，没有 `document`，也没装 `@testing-library/react`（见 `flow/tests/unit/channel-node-panel-order.test.tsx` 顶部的说明）。既有做法是 `?raw` 源码接线断言——照做；真正的解析逻辑由 Task 4 的行为测试覆盖。

```ts
import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/SkillUploadCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";
import apiSource from "../frontend/lib/api.ts?raw";

describe("SkillUploadCard 接线", () => {
  it("用共享的拆包函数，不自己再造一个解析器", () => {
    expect(cardSource).toContain('from "../lib/skill-package"');
    expect(cardSource).toContain("parseSkillFiles");
    expect(cardSource).toContain("unzipToEntries");
  });

  it("三种入口都接上：zip、文件夹、单文件", () => {
    expect(cardSource).toContain("webkitdirectory");
    expect(cardSource).toContain(".zip");
    expect(cardSource).toContain("onDrop");
  });

  // 重名必须先问用户。静默覆盖会让用户丢掉自己写的技能。
  it("重名有覆盖/改名两条出路，且不静默覆盖", () => {
    expect(cardSource).toContain("conflict");
    expect(cardSource).toContain('{ en: "Overwrite", zh: "覆盖" }');
    expect(cardSource).toContain('{ en: "Rename", zh: "改名" }');
  });

  it("文案双语", () => {
    for (const s of ['{ en: "My skills", zh: "我的技能" }',
                     '{ en: "Drag & drop a .zip, a folder, or a SKILL.md", zh: "拖入 .zip、文件夹或 SKILL.md" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("api client 有导入、列出与删除", () => {
    expect(apiSource).toContain("skills:");
    expect(apiSource).toContain("/api/skills/import");
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("SkillUploadCard");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/skill-upload-card.test.ts`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 加 api client**

`content/frontend/lib/api.ts` 的 `api` 对象追加：

```ts
  skills: {
    list: (): Promise<{ skills: { id: string; label: string; hasCachedContent: boolean; uploaded: boolean }[] }> =>
      request("/api/skills"),
    import: (skills: { name: string; source: string; overwrite?: boolean; files: { path: string; content: string }[] }[]) =>
      request<{ imported: number }>("/api/skills/import", { method: "POST", body: JSON.stringify({ skills }) }),
    remove: (skillId: string): Promise<{ ok: boolean }> =>
      request(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" }),
  },
```

- [ ] **Step 4: 实现卡片**

创建 `content/frontend/components/SkillUploadCard.tsx`。拖拽与文件夹读取照 `link/frontend/components/LocalImport.tsx` 的写法（`webkitGetAsEntry` + 递归 `readDirectory` + `webkitdirectory` 隐藏 input），共享组件用 `Button` / `Label` / `Input`：

```tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";
import { parseSkillFiles, unzipToEntries, type ParsedSkill } from "../lib/skill-package";

type Uploaded = { id: string; label: string; uploaded: boolean };

export function SkillUploadCard() {
  const T = useT();
  const { toast } = useToast();
  const [existing, setExisting] = useState<Uploaded[]>([]);
  const [preview, setPreview] = useState<ParsedSkill[]>([]);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () =>
    api.skills.list().then((r) => setExisting(r.skills.filter((s) => s.uploaded))).catch(() => {});
  useEffect(() => { reload(); }, []);

  // 重名只可能发生在上传的技能之间 —— 预置 id 是 marketingskills-*，上传是 upload:*。
  const existingLabels = new Set(existing.map((s) => s.label.toLowerCase()));
  const isConflict = (name: string) => existingLabels.has(name.toLowerCase());

  const ingest = async (files: File[]) => {
    try {
      const zip = files.find((f) => f.name.endsWith(".zip"));
      const entries = zip
        ? unzipToEntries(new Uint8Array(await zip.arrayBuffer()))
        : await Promise.all(
            files
              .filter((f) => f.name.endsWith(".md"))
              .map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, text: await f.text() }))
          );
      setPreview(parseSkillFiles(entries));
      setOverwrite({});
    } catch (e) {
      toast({ title: T({ en: "Could not read that upload", zh: "这个上传读不出来" }), description: String(e), variant: "destructive" });
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files: File[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry?.isDirectory) files.push(...(await readDirectory(entry)));
      else if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
    }
    await ingest(files);
  };

  const rename = (index: number, name: string) =>
    setPreview((p) => p.map((s, i) => (i === index ? { ...s, name } : s)));

  const confirm = async () => {
    setBusy(true);
    try {
      await api.skills.import(
        preview.map((s) => ({ name: s.name, source: s.name, overwrite: !!overwrite[s.name], files: s.files }))
      );
      toast({ title: T({ en: "Skills imported", zh: "技能已导入" }) });
      setPreview([]);
      await reload();
    } catch (e: any) {
      // 后端自己也查重名（前端列表可能过期或有第二个标签页），409 时把冲突名摊开让用户处理
      const msg = e?.status === 409
        ? T({ en: "Some names already exist — choose Overwrite or rename them.", zh: "有重名——请选择覆盖或改名。" })
        : T({ en: "Import failed", zh: "导入失败" });
      toast({ title: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-sm font-semibold">{T({ en: "My skills", zh: "我的技能" })}</h2>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        {T({ en: "Drag & drop a .zip, a folder, or a SKILL.md", zh: "拖入 .zip、文件夹或 SKILL.md" })}
        <div className="mt-2 flex justify-center gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            {T({ en: "Choose file", zh: "选择文件" })}
          </Button>
          <Button variant="ghost" onClick={() => dirRef.current?.click()}>
            {T({ en: "Choose folder", zh: "选择文件夹" })}
          </Button>
        </div>
        <input ref={fileRef} type="file" accept=".zip,.md" className="hidden"
          onChange={(e) => ingest(Array.from(e.target.files ?? []))} />
        <input ref={dirRef} type="file" className="hidden"
          onChange={(e) => ingest(Array.from(e.target.files ?? []))}
          {...({ webkitdirectory: "", directory: "" } as any)} />
      </div>

      {preview.length > 0 && (
        <div className="space-y-2">
          {preview.map((s, i) => {
            const conflict = isConflict(s.name);
            return (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Input value={s.name} onChange={(e: any) => rename(i, e.target.value)} className="flex-1 text-sm" />
                <span className="text-xs text-muted-foreground shrink-0">{Math.ceil(s.bytes / 1024)} KB</span>
                {conflict && (
                  <>
                    <span className="text-xs text-destructive shrink-0">{T({ en: "Name exists", zh: "已存在同名" })}</span>
                    <Button variant={overwrite[s.name] ? "default" : "ghost"} className="shrink-0"
                      onClick={() => setOverwrite((o) => ({ ...o, [s.name]: !o[s.name] }))}>
                      {T({ en: "Overwrite", zh: "覆盖" })}
                    </Button>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {T({ en: "Rename", zh: "改名" })}
                    </span>
                  </>
                )}
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button onClick={confirm} disabled={busy || preview.some((s) => isConflict(s.name) && !overwrite[s.name])}>
              {T({ en: "Import", zh: "导入" })}
            </Button>
            <Button variant="ghost" onClick={() => setPreview([])}>{T({ en: "Cancel", zh: "取消" })}</Button>
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Uploaded", zh: "已上传" })}</Label>
          {existing.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-sm py-1">
              <span className="truncate">{s.label}</span>
              <Button variant="ghost" onClick={() => api.skills.remove(s.id).then(reload)}>
                {T({ en: "Delete", zh: "删除" })}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

async function readDirectory(entry: any): Promise<File[]> {
  const files: File[] = [];
  const reader = entry.createReader();
  const batch: any[] = await new Promise((res) => reader.readEntries(res));
  for (const e of batch) {
    if (e.isFile) files.push(await new Promise<File>((res) => e.file(res)));
    else if (e.isDirectory) files.push(...(await readDirectory(e)));
  }
  return files;
}
```

**注意**：上面的 409 分支依赖抛出的 Error 带状态码。`content/frontend/lib/api.ts:14` 已经有 `e.status = res.status`（之前为 `MarketingContextCard` 的 409 处理加的），直接用即可，不用再改 `request()`。

- [ ] **Step 5: 挂进设置页**

`content/frontend/pages/SettingsPage.tsx`：import 该组件，在「品牌与产品上下文」卡片之后渲染 `<div className="mt-8"><SkillUploadCard /></div>`。

- [ ] **Step 6: 跑测试与类型检查**

Run: `cd content && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add content/frontend/components/SkillUploadCard.tsx content/frontend/lib/api.ts content/frontend/pages/SettingsPage.tsx content/tests/skill-upload-card.test.ts
git commit -m "feat(content): upload skills from a zip, a folder, or a single SKILL.md"
```

---

### Task 6: 部署与自测

**Files:** 无源码改动

**Interfaces:**
- Consumes: Task 1–5
- Produces: 无

- [ ] **Step 1: 应用 migration**

```bash
cd content && wrangler d1 migrations apply uniscrm-content-dev --env dev --remote
```

用全局 `wrangler`，**不要 `npx wrangler`**（npx 会挑到本仓库里过期的 4.86）。数据库名以 `content/wrangler.toml` 的 `[env.dev]` 为准，别猜。

- [ ] **Step 2: 部署 dev**

```bash
cd content && npm run deploy:dev
```

**必须用 `npm run deploy:dev`**：裸 `wrangler deploy` 会打到 PROD 并抹掉 bindings，手跑 `--env dev` 会跳过 vite 前端构建、发出过期前端。

部署后核对前端产物确实是新的（本仓库真出现过 wrangler 报错退出、前端却没更新的情况）：

```bash
curl -s https://content-dev.uni-scrm.com/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js'
```

取到的 bundle 里应含 `我的技能`。

- [ ] **Step 3: 浏览器自测**

复用已登录的 Chrome 会话（`tabs_context_mcp`）：

1. `https://content-dev.uni-scrm.com/settings`：出现「我的技能」卡片。
2. 造一个 zip：把 `marketingskills` 的 `skills/social/` 目录（`SKILL.md` + `references/`）打包上传，确认预览里出现一个技能、大小合理，导入成功。
3. 再传一次同一个包：确认预览标出「已存在同名」，且不选「覆盖」时导入按钮是禁用的；选了覆盖后导入成功且列表里仍只有一条。
4. 打开一个 content flow 的 X Content Action 节点，确认技能下拉里**同时**有预置的 `Social (marketingskills)` 和上传的那个。
5. 选上传的那个，触发一次生成，确认产出正常（与预置那条的差别只在于没有注入租户上下文）。
6. 回设置页删除它，确认列表里消失；再回 flow 触发一次，确认节点**不报错**、按"无技能"继续生成。

- [ ] **Step 4: 无需提交**

本任务不改源码。若自测中发现问题，报告而不是就地修。

---

## Self-Review

**Spec 覆盖：**

| Spec 章节 | 任务 |
|---|---|
| §1 并列/自动识别/不注入上下文 | 3（并列）、4（识别）、全程零改动（不注入） |
| §2 浏览器端拆包、识别规则 | 4 |
| §3 存储（新表、`upload:` 前缀） | 1 |
| §4 双来源分派、`/api/skills` 合并 | 2、3 |
| §5 导入规则（过滤、8 上限、label、slug、体量、重名 409） | 3、4 |
| §6 界面（拖拽、预览、重名两条出路、删除、静默降级） | 5、6 |
| §7 测试 | 各任务内 |
| §8 明确不做 | 全程 |

**类型一致性：** `UPLOAD_PREFIX` / `slugifySkillName` / `listTenantSkills` / `getTenantSkillContent` / `upsertTenantSkill` / `deleteTenantSkill` / `findExistingSkillIds` 在 Task 1 定义，Task 2、3 按同名同参使用；`getSkillContent(env, tenantId, skillId)` 的新签名在 Task 2 定下，唯一调用点同任务内改完；`inlineReferencesFromFiles` 在 Task 3 定义并即时使用；`ParsedSkill { name, files, bytes }` 与 `UploadFile { path, content }` 在 Task 4 定义，Task 5 消费——注意 `files` 的字段名是 `content`（与后端 `/api/skills/import` 的 `files[].content` 对齐），而 `parseSkillFiles` 的**入参**用的是 `text`，两者刻意不同名以免混淆读入与提交两个阶段。

**占位符扫描：** 无 TBD / TODO / "similar to Task N"。
