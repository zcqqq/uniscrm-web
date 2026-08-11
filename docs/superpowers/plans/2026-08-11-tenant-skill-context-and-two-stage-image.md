# 租户技能上下文 + 两段式出图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个租户在 AI Content Settings 里通过多轮对话产出一份 product marketing 上下文文档，注入到技能驱动的生成；并把图片生成改为两段式（文本模型读触发内容写视觉描述 → 扩散模型）。

**Architecture:** 上下文按「租户 × 技能包」存在 content D1 的 `skill_context` 表，由 `product-marketing` 技能引导的对话产出，起草信号来自租户近期内容 + 渠道清单（渠道走 link 的显式投影端点，凭证不出 link）。出图两段都在 content 内部，`/internal/generate-image` 换成 `{ sourceTitle, sourceText }` 入参；提示词长度保护下沉到 provider 适配器。

**Tech Stack:** Cloudflare Workers（Hono）、D1、R2、Workers AI、vitest + `@cloudflare/vitest-pool-workers`、React（无 DOM 测试环境）

**Spec:** `docs/superpowers/specs/2026-08-11-tenant-skill-context-and-two-stage-image-design.md`

## Global Constraints

- **注入顺序固定为「技能 → 租户上下文 → operationContext」。** operationContext 必须留在最末尾——2026-08-09 实测，长系统提示词里模型最看重尾部，契约放前面会被 60KB 技能文档淹没。
- **上下文按技能包归属，不按单个技能。** 存储键是 `(tenant_id, skill_repo)`，`skill_repo` 是 GitHub repo id（`coreyhaines31/marketingskills`）。现有 `SKILL_CATALOG` 的技能 id 不改名。
- **上下文的注入是技能作用域的**：选了某个技能才注入该技能所属包的上下文；`skillId` 为 `"none"` 时不注入任何上下文。（这是 spec §3.6「每次生成时取」的落地解释——见 Task 2 的说明。）
- **凭证绝不离开 link。** `channels.config` 里有 `access_token` / `refresh_token` / `app_client_secret`。渠道摘要端点逐字段显式投影，永不透传 `config`。
- **任何情况下都不自动保存上下文文档。** 只有解析出带哨兵 `PRODUCT-MARKETING-CONTEXT-V1` 的完整围栏块时才显示保存按钮——残缺文档会污染此后所有生成。
- **stage 1 输出不设人为上限**；长度保护住在 provider 适配器里，用模型的真实上限（flux-1-schnell 实测 **2048 字符含**，2049 即失败）。
- **没有任何功能以上下文的存在为前提。** 文档不存在就是不注入，行为退化到今天。
- 出图失败一律降级：记日志、照发纯文本、节点记成功。失败原因只进日志，不进 `reason`（它会写进 `content_flow_log` 分析表，外部错误体长度不可控）。
- 所有面向用户的文案必须 `{ en, zh }` 双语；品牌名与模型 id 不翻译，字面量处加 `// i18n-ok:`。
- 前端不用 inline CSS，全部用 `shared/frontend/ui/` 下的共享组件。
- 提交只 `git add` 明确列出的路径，**禁止 `git add -A`**（本仓库有其他 session 的未提交文件）。不要 push；dev 部署一律用模块目录下的 `npm run deploy:dev`。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `content/migrations/0008_skill_context.sql` | `skill_context` 表 | 1 |
| `content/src/skills/catalog.ts` | `repo` 字段 + image / product-marketing 两条目录条目 | 1 |
| `content/src/services/skill-context.ts` | 上下文读写（新建） | 1 |
| `content/src/services/generate.ts` | 文本生成注入上下文 | 2 |
| `content/src/services/tenant-content.ts` | 读 per-tenant D1 近期内容（新建） | 3 |
| `content/src/types.ts` + `wrangler.toml` | `LINK_URL` / `CF_D1_API_TOKEN` | 3 |
| `link/src/routes-internal.ts` | `/internal/channels/summary` 投影端点 | 4 |
| `content/src/services/marketing-context.ts` | 起草 + 对话编排（新建） | 5, 6 |
| `content/src/index.ts` | 4 条新 API 路由 | 5, 6 |
| `content/frontend/components/MarketingContextCard.tsx` | 上下文卡片 + 对话 UI（新建） | 7 |
| `content/frontend/lib/api.ts` + `pages/SettingsPage.tsx` | 客户端方法 + 挂载卡片 | 7 |
| `content/src/providers/image-interface.ts` + 两个 image provider | 提示词长度截断 | 8 |
| `content/src/services/generate-image.ts` + `routes-internal.ts` | 两段式 | 9 |
| `link/src/routes-internal.ts`、`flow/src/*`、`flow/frontend/components/Inspector.tsx` | 传 sourceTitle/sourceText，删 imagePrompt | 10 |
| dev 部署 + 自测 | | 11 |

---

### Task 1: content — skill_context 表、目录 repo 字段、两条新技能

**Files:**
- Create: `content/migrations/0008_skill_context.sql`
- Create: `content/src/services/skill-context.ts`
- Modify: `content/src/skills/catalog.ts`
- Test: `content/tests/services/skill-context.test.ts`（新建）、`content/tests/services/skill-catalog.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `MARKETING_SKILLS_REPO = "coreyhaines31/marketingskills"`
  - `SkillDefinition` 新增必填字段 `repo: string`
  - 目录新增 `marketingskills-image`、`marketingskills-product-marketing` 两条
  - `getSkillContext(env: Env, tenantId: number, skillRepo: string): Promise<string | null>`
  - `getSkillContextRow(env, tenantId, skillRepo): Promise<{ content: string; version: number; updatedAt: string } | null>`
  - `setSkillContext(env, tenantId, skillRepo, content: string): Promise<{ version: number }>`

- [ ] **Step 1: 写 migration**

创建 `content/migrations/0008_skill_context.sql`：

```sql
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
```

- [ ] **Step 2: 写目录的失败测试**

创建 `content/tests/services/skill-catalog.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, getSkillDefinition, MARKETING_SKILLS_REPO } from "../../src/skills/catalog";

describe("SKILL_CATALOG", () => {
  it("每条技能都声明自己属于哪个包", () => {
    for (const s of SKILL_CATALOG) {
      expect(s.repo, `${s.id} 缺少 repo`).toBeTruthy();
    }
  });

  // 技能 id 按技能、repo 按包 —— 上下文是按包存的，两者不能混为一谈。
  it("marketing 三件套同属一个包，但 id 各不相同", () => {
    const ids = ["marketingskills-social", "marketingskills-image", "marketingskills-product-marketing"];
    const defs = ids.map((id) => getSkillDefinition(id));
    expect(defs.every(Boolean)).toBe(true);
    expect(new Set(defs.map((d) => d!.repo))).toEqual(new Set([MARKETING_SKILLS_REPO]));
    expect(new Set(defs.map((d) => d!.id)).size).toBe(3);
  });

  it("新技能的 sourceUrl 指向各自的 SKILL.md", () => {
    expect(getSkillDefinition("marketingskills-image")!.sourceUrl).toContain("/skills/image/SKILL.md");
    expect(getSkillDefinition("marketingskills-product-marketing")!.sourceUrl).toContain("/skills/product-marketing/SKILL.md");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/skill-catalog.test.ts`
Expected: FAIL —— `MARKETING_SKILLS_REPO` 不存在、两条新技能查不到。

- [ ] **Step 4: 实现目录**

`content/src/skills/catalog.ts` 整体改写为：

```ts
export interface SkillDefinition {
  /** 按技能，如 "marketingskills-social"。已写进 skill_content_cache 与存量 flow 节点的 skillId，不可改名。 */
  id: string;
  label: string;
  sourceUrl: string;
  /** 按包，如 "coreyhaines31/marketingskills"。租户上下文按包存 —— 同包技能共用一份。 */
  repo: string;
}

export const MARKETING_SKILLS_REPO = "coreyhaines31/marketingskills";

const MARKETING_SKILLS_BASE = "https://raw.githubusercontent.com/coreyhaines31/marketingskills/main/skills";

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: "marketingskills-social",
    label: "Social (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/social/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
  {
    id: "marketingskills-image",
    label: "Image (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/image/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
  {
    id: "marketingskills-product-marketing",
    label: "Product Marketing (marketingskills)",
    sourceUrl: `${MARKETING_SKILLS_BASE}/product-marketing/SKILL.md`,
    repo: MARKETING_SKILLS_REPO,
  },
];

export function getSkillDefinition(id: string): SkillDefinition | undefined {
  return SKILL_CATALOG.find((s) => s.id === id);
}
```

- [ ] **Step 5: 写 skill-context 的失败测试**

创建 `content/tests/services/skill-context.test.ts`。**注意本仓库的测试环境事实**：vitest pool 不会自动跑 `content/migrations/*.sql`，同目录既有测试文件是自己手写 `CREATE TABLE IF NOT EXISTS` 的——照抄那个写法建 `skill_context` 表。

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { getSkillContext, getSkillContextRow, setSkillContext } from "../../src/services/skill-context";

const REPO = "coreyhaines31/marketingskills";

beforeAll(async () => {
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS skill_context (
       tenant_id INTEGER NOT NULL, skill_repo TEXT NOT NULL, content TEXT NOT NULL,
       version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, skill_repo))`
  ).run();
});

describe("skill context", () => {
  it("没写过就是 null —— 没有任何功能以它的存在为前提", async () => {
    expect(await getSkillContext(env as never, 7001, REPO)).toBeNull();
    expect(await getSkillContextRow(env as never, 7001, REPO)).toBeNull();
  });

  it("首次保存为 v1", async () => {
    const { version } = await setSkillContext(env as never, 7002, REPO, "# ctx v1");
    expect(version).toBe(1);
    expect(await getSkillContext(env as never, 7002, REPO)).toBe("# ctx v1");
  });

  it("再次保存递增版本并覆盖正文", async () => {
    await setSkillContext(env as never, 7003, REPO, "# first");
    const { version } = await setSkillContext(env as never, 7003, REPO, "# second");
    expect(version).toBe(2);
    const row = await getSkillContextRow(env as never, 7003, REPO);
    expect(row).toEqual(expect.objectContaining({ content: "# second", version: 2 }));
  });

  // 多租户隔离：一个租户的定位文档串到另一个租户，会污染对方此后所有生成。
  it("按 (tenant_id, skill_repo) 隔离", async () => {
    await setSkillContext(env as never, 7004, REPO, "# tenant A");
    await setSkillContext(env as never, 7005, REPO, "# tenant B");
    await setSkillContext(env as never, 7004, "someone/otherpack", "# other pack");
    expect(await getSkillContext(env as never, 7004, REPO)).toBe("# tenant A");
    expect(await getSkillContext(env as never, 7005, REPO)).toBe("# tenant B");
    expect(await getSkillContext(env as never, 7004, "someone/otherpack")).toBe("# other pack");
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/skill-context.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 7: 实现 skill-context**

创建 `content/src/services/skill-context.ts`：

```ts
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
```

- [ ] **Step 8: 跑全套 content 测试**

Run: `cd content && npx vitest run`
Expected: PASS。（绿色汇总后出现 "close timed out after 10000ms" / "something prevents Vite server from exiting" 是本仓库已知噪音。）

- [ ] **Step 9: 提交**

```bash
git add content/migrations/0008_skill_context.sql content/src/skills/catalog.ts content/src/services/skill-context.ts content/tests/services/skill-context.test.ts content/tests/services/skill-catalog.test.ts
git commit -m "feat(content): store a per-tenant context document per skill pack"
```

---

### Task 2: content — 文本生成注入租户上下文

**Files:**
- Modify: `content/src/services/generate.ts`
- Test: `content/tests/generate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getSkillContext(env, tenantId, skillRepo)`、`getSkillDefinition(id)`（返回值含 `repo`）
- Produces: `generateContent` 的系统提示词拼接顺序 `[skillContent, tenantContext, operationContext]`

**关于「技能作用域注入」**：`generateContent` 只在选了技能时才注入上下文，注入的是该技能 `def.repo` 的那一份；`skillId` 为 `"none"` 时不注入。理由：这份文档的 12 个小节是照着该技能包的消费方式写的，脱离该包单独注入未经验证；且用户的原话是"调用该 skill 时由 md 驱动"。出图的 stage 1 永远显式使用 `marketingskills-image`，所以图片路径永远拿得到上下文。

- [ ] **Step 1: 写失败测试**

`content/tests/generate.test.ts` 追加。该文件已有 `vi.spyOn(skillContentModule, "getSkillContent")` 的写法，照它加一个对 skill-context 的 spy：

```ts
import * as skillContextModule from "../src/services/skill-context";

// 顺序是承重的：技能是 60KB 通用文档，租户上下文是 2-4KB 具体信息，operationContext 是
// 执行契约。越具体越靠后，契约永远最后 —— 2026-08-09 实测，契约放前面会被技能文档淹没。
it("按「技能 → 租户上下文 → operationContext」拼接系统提示词", async () => {
  vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
  vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue("TENANT-CTX");
  const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
  const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

  await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
    ...baseParams, skillId: "marketingskills-social", operationContext: "OP-CTX",
  });

  expect(aiRun).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      messages: expect.arrayContaining([
        { role: "system", content: "SKILL-DOC\n\nTENANT-CTX\n\nOP-CTX" },
      ]),
    })
  );
});

it("按技能所属的包取上下文", async () => {
  vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
  const spy = vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue(null);
  const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
  const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

  await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
    ...baseParams, tenantId: 42, skillId: "marketingskills-social",
  });

  expect(spy).toHaveBeenCalledWith(expect.anything(), 42, "coreyhaines31/marketingskills");
});

// 上下文是技能作用域的：没选技能就没有"哪个包"可言，不注入。
it("skillId 为 none 时不查也不注入上下文", async () => {
  const spy = vi.spyOn(skillContextModule, "getSkillContext");
  const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
  const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

  await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, { ...baseParams, skillId: "none" });

  expect(spy).not.toHaveBeenCalled();
  expect(aiRun).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ messages: [{ role: "user", content: baseParams.prompt }] })
  );
});

it("上下文不存在时行为与今天完全一致", async () => {
  vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
  vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue(null);
  const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
  const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

  await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
    ...baseParams, skillId: "marketingskills-social", operationContext: "OP-CTX",
  });

  expect(aiRun).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      messages: expect.arrayContaining([{ role: "system", content: "SKILL-DOC\n\nOP-CTX" }]),
    })
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/generate.test.ts`
Expected: FAIL —— 上下文没有被拼进去。

- [ ] **Step 3: 实现**

`content/src/services/generate.ts` 的 `generateContent` 顶部改为：

```ts
import { getSkillDefinition } from "../skills/catalog";
import { getSkillContext } from "./skill-context";

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const useSkill = !!params.skillId && params.skillId !== "none";
  const skillContent = useSkill ? (await getSkillContent(env, params.skillId!)) ?? undefined : undefined;
  // 上下文按技能所属的包取：文档的小节是照着该包的消费方式写的，脱离该包单独注入未经验证。
  const repo = useSkill ? getSkillDefinition(params.skillId!)?.repo : undefined;
  const tenantContext = repo ? (await getSkillContext(env, params.tenantId, repo)) ?? undefined : undefined;

  // 技能 → 租户上下文 → operationContext。越具体越靠后，契约永远最后：LLM 对长系统提示词
  // 的尾部最敏感，而技能文档可以有 60k 字符。
  const systemPrompt =
    [skillContent, tenantContext, params.operationContext].filter(Boolean).join("\n\n") || undefined;
```

其余不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add content/src/services/generate.ts content/tests/generate.test.ts
git commit -m "feat(content): inject the tenant's skill-pack context into text generation"
```

---

### Task 3: content — 读租户近期内容 + 新增两项配置

**Files:**
- Create: `content/src/services/tenant-content.ts`
- Modify: `content/src/types.ts`, `content/wrangler.toml`
- Test: `content/tests/services/tenant-content.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `listRecentTenantContent(env: Env, tenantId: number, limit?: number): Promise<{ channelType: string; title: string | null; contentText: string | null }[]>`（未开库的租户返回 `[]`）

- [ ] **Step 1: 加配置**

`content/src/types.ts` 的 `Env` 接口追加两行：

```ts
  /** link 的内部基址，用于取渠道摘要（走 X-Internal-Secret，与其它内部跳转一致）。 */
  LINK_URL: string;
  /** 经 shared/tenant-data-db.ts 访问 per-tenant D1 的 token（与 CF_API_TOKEN 不是同一个）。 */
  CF_D1_API_TOKEN: string;
```

`content/wrangler.toml` 的 `[env.dev.vars]` 与 `[env.production.vars]` 各加一行 `LINK_URL`，值分别为 `"https://link-dev.uni-scrm.com"` 与 `"https://link.uni-scrm.com"`（照抄同文件里 `FLOW_URL` 的写法确认域名形式）。`CF_D1_API_TOKEN` 是 secret，不写进 toml。

- [ ] **Step 2: 写失败测试**

创建 `content/tests/services/tenant-content.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { listRecentTenantContent } from "../../src/services/tenant-content";

afterEach(() => vi.unstubAllGlobals());

const envWith = (d1: string | null) => ({
  CF_ACCOUNT_ID: "acct",
  CF_D1_API_TOKEN: "tok",
  WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => (d1 ? { d1_database_id: d1 } : null) }) }) },
}) as never;

describe("listRecentTenantContent", () => {
  // 新租户还没开库是常态，不是错误 —— 起草会退化成从白纸开始。
  it("租户没有 per-tenant 库时返回空数组，不抛错", async () => {
    expect(await listRecentTenantContent(envWith(null), 1)).toEqual([]);
  });

  it("按 created_at 倒序取，带 limit，映射成扁平结构", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: [{ results: [{ channel_type: "X", title: "T", content_text: "B" }] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await listRecentTenantContent(envWith("db-1"), 42, 5);

    expect(rows).toEqual([{ channelType: "X", title: "T", contentText: "B" }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sql).toContain("ORDER BY created_at DESC");
    expect(body.params).toEqual([5]);
  });

  // 起草是"锦上添花"的信号来源，租户库抽风不该让整个起草端点 500。
  it("查询失败时返回空数组而不是抛错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 200 })
    ));
    expect(await listRecentTenantContent(envWith("db-1"), 42)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd content && npx vitest run tests/services/tenant-content.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现**

创建 `content/src/services/tenant-content.ts`：

```ts
import type { Env } from "../types";
import { TenantDataDB } from "../../../shared/tenant-data-db";

const DEFAULT_LIMIT = 20;

export interface RecentContentRow {
  channelType: string;
  title: string | null;
  contentText: string | null;
}

// 起草用的信号源之一。租户没开库、或库查不动，都返回空数组：起草是锦上添花，
// 让它把整个端点拖成 500 不划算 —— 两个信号都空时对话会从白纸开始。
export async function listRecentTenantContent(
  env: Env,
  tenantId: number,
  limit = DEFAULT_LIMIT
): Promise<RecentContentRow[]> {
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return [];

  const db = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
  try {
    const rows = await db.query<{ channel_type: string; title: string | null; content_text: string | null }>(
      "SELECT channel_type, title, content_text FROM content ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map((r) => ({ channelType: r.channel_type, title: r.title, contentText: r.content_text }));
  } catch (err) {
    console.error(JSON.stringify({ event: "tenant_content_read_failed", tenantId, error: String(err) }));
    return [];
  }
}
```

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd content && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS。`content/src/services/video-action/transcribe.ts` 里有一条**先于本计划存在**的 `Buffer` 类型错误，不是你的，别修。

- [ ] **Step 6: 提交**

```bash
git add content/src/types.ts content/wrangler.toml content/src/services/tenant-content.ts content/tests/services/tenant-content.test.ts
git commit -m "feat(content): read the tenant's recent content from its per-tenant D1"
```

---

### Task 4: link — 渠道摘要投影端点

**Files:**
- Modify: `link/src/routes-internal.ts`（紧挨既有的 `/channels/active` 之后）
- Test: `link/tests/services/routes-internal-channels-summary.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `GET /internal/channels/summary?tenantId=<n>` → `{ channels: { channelType: string; displayName: string | null }[] }`

- [ ] **Step 1: 写失败测试**

创建 `link/tests/services/routes-internal-channels-summary.test.ts`。照抄同目录既有测试文件的 worker 引入与 `X-Internal-Secret` 写法（dev 环境的值是 `dev-internal-secret`，除非测试自带 env 覆盖）：

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

beforeAll(async () => {
  await env.LINK_DB.prepare("DELETE FROM channels WHERE tenant_id IN (9101, 9102)").run();
  const ins = (id: string, type: string, tenant: number, cfg: unknown) =>
    env.LINK_DB.prepare(
      "INSERT INTO channels (id, channel_type, config, tenant_id, is_active) VALUES (?, ?, ?, ?, 1)"
    ).bind(id, type, JSON.stringify(cfg), tenant).run();
  await ins("c-x", "X", 9101, { x_name: "UniSCRM", x_username: "uniscrm", access_token: "AT-SECRET", refresh_token: "RT-SECRET", app_client_secret: "CS-SECRET" });
  await ins("c-yt", "YOUTUBE_ACCOUNT", 9101, { channel_title: "UniSCRM TV", access_token: "AT-SECRET" });
  await ins("c-tt", "TIKTOK", 9101, { display_name: "UniSCRM TT", access_token: "AT-SECRET" });
  await ins("c-other", "X", 9102, { x_name: "SomeoneElse" });
});

async function summary(tenantId: number) {
  const res = await worker.fetch(
    new Request(`https://link-dev.uni-scrm.com/internal/channels/summary?tenantId=${tenantId}`, {
      headers: { "X-Internal-Secret": "dev-internal-secret" },
    }),
    env
  );
  return { status: res.status, text: await res.text() };
}

describe("GET /internal/channels/summary", () => {
  it("按渠道类型取显示名", async () => {
    const { status, text } = await summary(9101);
    expect(status).toBe(200);
    const body = JSON.parse(text) as { channels: { channelType: string; displayName: string | null }[] };
    expect(body.channels).toEqual(expect.arrayContaining([
      { channelType: "X", displayName: "UniSCRM" },
      { channelType: "YOUTUBE_ACCOUNT", displayName: "UniSCRM TV" },
      { channelType: "TIKTOK", displayName: "UniSCRM TT" },
    ]));
    expect(body.channels).toHaveLength(3);
  });

  // 这条是本端点存在的全部理由：config 里装着 access_token / refresh_token /
  // app_client_secret，而这个返回体会被喂进 LLM 提示词。泄一个字段就是泄凭证。
  it("绝不泄露 config 或其中任何凭证字段", async () => {
    const { text } = await summary(9101);
    for (const leak of ["AT-SECRET", "RT-SECRET", "CS-SECRET", "access_token", "refresh_token", "app_client_secret", "config"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("按租户隔离", async () => {
    const body = JSON.parse((await summary(9102)).text) as { channels: { displayName: string | null }[] };
    expect(body.channels).toEqual([{ channelType: "X", displayName: "SomeoneElse" }]);
  });

  it("没有渠道时返回空数组", async () => {
    expect(JSON.parse((await summary(9103)).text)).toEqual({ channels: [] });
  });

  it("缺少 tenantId 时 400", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/channels/summary", {
        headers: { "X-Internal-Secret": "dev-internal-secret" },
      }),
      env
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd link && npx vitest run tests/services/routes-internal-channels-summary.test.ts`
Expected: FAIL —— 端点 404。

- [ ] **Step 3: 实现**

`link/src/routes-internal.ts`，紧挨 `router.get("/channels/active", …)` 之后加入：

```ts
  // content 起草 product marketing 上下文时用的渠道清单：租户在哪些平台上、各叫什么。
  // 「在 X 和 YouTube 上、没有 TikTok」本身就是定位信号。
  //
  // 逐字段显式投影，永不透传 config —— config 里装着 access_token / refresh_token /
  // 加密的 app_client_secret，而这个返回体最终会进 LLM 的提示词。与 /channels/active
  // 只回 id 集合是同一条约定：内部端点交出去的永远是调用方真正需要的那几个字段。
  router.get("/channels/summary", async (c) => {
    const tenantId = Number(c.req.query("tenantId"));
    if (!Number.isFinite(tenantId)) return c.json({ error: "tenantId required" }, 400);

    const rows = await c.env.LINK_DB
      .prepare("SELECT channel_type, config FROM channels WHERE tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .all<{ channel_type: string; config: string }>();

    const channels = rows.results.map((r) => {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(r.config) as Record<string, unknown>; } catch { cfg = {}; }
      const pick = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : null);
      const displayName =
        pick("x_name") ?? pick("display_name") ?? pick("channel_name") ?? pick("channel_title");
      return { channelType: r.channel_type, displayName };
    });

    return c.json({ channels });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd link && npx vitest run`
Expected: PASS。`poll-channel-youtube.test.ts` 与 `cron-polling.test.ts` 有两条**先于本计划存在**的 unhandled-rejection 警告，与本任务无关。

- [ ] **Step 5: 提交**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-channels-summary.test.ts
git commit -m "feat(link): expose a credential-free channel summary for context drafting"
```

---

### Task 5: content — 起草服务与端点

**Files:**
- Create: `content/src/services/marketing-context.ts`
- Modify: `content/src/index.ts`
- Test: `content/tests/routes-api-marketing-context-draft.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `MARKETING_SKILLS_REPO` / `getSkillContext`；Task 3 的 `listRecentTenantContent`；Task 4 的 `GET link /internal/channels/summary`
- Produces:
  - `fetchChannelSummary(env, tenantId): Promise<{ channelType: string; displayName: string | null }[]>`
  - `buildDraftPrompt(rows, channels): string`
  - `POST /api/marketing-context/draft` → `{ draft: string }`

- [ ] **Step 1: 写失败测试**

创建 `content/tests/routes-api-marketing-context-draft.test.ts`：

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import * as tenantContentModule from "../src/services/tenant-content";
import * as generateModule from "../src/services/generate";

beforeAll(async () => { await seedSession(env as never, "mc", 93); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function draft() {
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/marketing-context/draft", {
      method: "POST", headers: { Cookie: "session=mc", "Content-Type": "application/json" }, body: "{}",
    }),
    env
  );
  return { status: res.status, body: await res.json() as { draft: string } };
}

function stubChannels(channels: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ channels }), { status: 200 })));
}

describe("POST /api/marketing-context/draft", () => {
  it("把近期内容和渠道清单都喂给模型", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([
      { channelType: "X", title: "Shipping v2", contentText: "attribution models" },
    ]);
    stubChannels([{ channelType: "X", displayName: "UniSCRM" }, { channelType: "YOUTUBE_ACCOUNT", displayName: null }]);
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("# Product Marketing Context");

    const { status, body } = await draft();

    expect(status).toBe(200);
    expect(body.draft).toBe("# Product Marketing Context");
    const prompt = gen.mock.calls[0][1].prompt;
    expect(prompt).toContain("Shipping v2");
    expect(prompt).toContain("attribution models");
    expect(prompt).toContain("UniSCRM");
    expect(prompt).toContain("YOUTUBE_ACCOUNT");
    // 起草受 product-marketing 技能指导
    expect(gen.mock.calls[0][1].skillId).toBe("marketingskills-product-marketing");
  });

  it("只有渠道、没有内容时照样起草", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([]);
    stubChannels([{ channelType: "TIKTOK", displayName: "UniSCRM TT" }]);
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("# draft");
    expect((await draft()).body.draft).toBe("# draft");
  });

  // 新租户两个信号都空 —— 这不是错误，对话从白纸开始。
  it("两个信号都为空时返回空草稿，不报错也不调模型", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([]);
    stubChannels([]);
    const gen = vi.spyOn(generateModule, "generateContent");
    const { status, body } = await draft();
    expect(status).toBe(200);
    expect(body.draft).toBe("");
    expect(gen).not.toHaveBeenCalled();
  });

  // 渠道端点挂了不该让起草整个失败 —— 还有内容这一路信号。
  it("渠道摘要取不到时降级为只用内容", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([
      { channelType: "X", title: "T", contentText: "B" },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("link down")));
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("# draft");
    expect((await draft()).status).toBe(200);
  });

  it("未登录返回 401", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/marketing-context/draft", {
        method: "POST", headers: { Cookie: "session=bad", "Content-Type": "application/json" }, body: "{}",
      }),
      env
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/routes-api-marketing-context-draft.test.ts`
Expected: FAIL —— 端点 404。

- [ ] **Step 3: 实现服务**

创建 `content/src/services/marketing-context.ts`：

```ts
import type { Env } from "../types";
import { MARKETING_SKILLS_REPO } from "../skills/catalog";
import { listRecentTenantContent, type RecentContentRow } from "./tenant-content";
import { generateContent } from "./generate";

export const PRODUCT_MARKETING_SKILL_ID = "marketingskills-product-marketing";
export const CONTEXT_SENTINEL = "PRODUCT-MARKETING-CONTEXT-V1";
export { MARKETING_SKILLS_REPO };

export interface ChannelSummaryRow {
  channelType: string;
  displayName: string | null;
}

// 渠道摘要是"锦上添花"的第二路信号；link 挂了就当没有，内容那一路还在。
export async function fetchChannelSummary(env: Env, tenantId: number): Promise<ChannelSummaryRow[]> {
  try {
    const res = await fetch(`${env.LINK_URL}/internal/channels/summary?tenantId=${tenantId}`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) return [];
    return (await res.json<{ channels: ChannelSummaryRow[] }>()).channels ?? [];
  } catch (err) {
    console.error(JSON.stringify({ event: "channel_summary_fetch_failed", tenantId, error: String(err) }));
    return [];
  }
}

export function buildDraftPrompt(rows: RecentContentRow[], channels: ChannelSummaryRow[]): string {
  const channelLines = channels
    .map((c) => `- ${c.channelType}${c.displayName ? `: ${c.displayName}` : ""}`)
    .join("\n");
  const contentLines = rows
    .map((r) => `- [${r.channelType}] ${r.title ?? ""}\n  ${(r.contentText ?? "").slice(0, 500)}`)
    .join("\n");

  return [
    "Draft a Product Marketing Context document for this tenant, following your skill's 12-section structure.",
    "You have no codebase to read. Everything known about them is below. Where a section cannot be",
    "supported by this evidence, write a short best guess and mark it clearly as an assumption to confirm.",
    channels.length ? `\nConnected marketing channels:\n${channelLines}` : "",
    rows.length ? `\nTheir most recent published/ingested content:\n${contentLines}` : "",
  ].filter(Boolean).join("\n");
}

export async function draftMarketingContext(env: Env, tenantId: number): Promise<string> {
  const [rows, channels] = await Promise.all([
    listRecentTenantContent(env, tenantId),
    fetchChannelSummary(env, tenantId),
  ]);
  // 两个信号都空 = 这个租户我们一无所知。生成一份纯靠猜的文档只会给用户一堆要删的东西，
  // 不如把对话交回给他们从白纸开始。
  if (rows.length === 0 && channels.length === 0) return "";

  return generateContent(env, {
    tenantId,
    prompt: buildDraftPrompt(rows, channels),
    provider: "default",
    skillId: PRODUCT_MARKETING_SKILL_ID,
  });
}
```

**注意**：`provider: "default"` 是占位——Task 6 会把它换成"跟随租户已配置的文本模型"的解析结果，两个端点共用同一个解析函数。本任务先按 default 实现，Task 6 统一改。

- [ ] **Step 4: 实现端点**

`content/src/index.ts`，在 `/api/image-providers` 之后加：

```ts
app.use("/api/marketing-context/*", sessionAuth);

app.post("/api/marketing-context/draft", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  try {
    return c.json({ draft: await draftMarketingContext(c.env, tenantId) });
  } catch (err) {
    console.error(JSON.stringify({ event: "marketing_context_draft_failed", tenantId, error: String(err) }));
    return c.json({ error: "Draft failed" }, 502);
  }
});
```

`sessionAuth` 用 `/*` 通配注册——注意本文件 `/api/llm-credentials` 上方那条注释：Hono 的 `/*` 也匹配父路径本身，所以**只注册一次**通配形式，不要同时注册裸路径。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add content/src/services/marketing-context.ts content/src/index.ts content/tests/routes-api-marketing-context-draft.test.ts
git commit -m "feat(content): draft a product marketing context from tenant content and channels"
```

---

### Task 6: content — 对话、读取与保存端点

**Files:**
- Modify: `content/src/services/marketing-context.ts`, `content/src/index.ts`
- Test: `content/tests/routes-api-marketing-context.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `getSkillContextRow` / `setSkillContext` / `MARKETING_SKILLS_REPO`；Task 5 的 `PRODUCT_MARKETING_SKILL_ID`
- Produces:
  - `resolveContextProvider(env, tenantId): Promise<"default" | "openai" | "anthropic">`
  - `GET /api/marketing-context` → `{ content: string | null; version: number | null; updatedAt: string | null }`
  - `POST /api/marketing-context/chat { messages }` → `{ reply: string }`
  - `PUT /api/marketing-context { content, baseVersion? }` → `{ version }`，版本不匹配返回 409

- [ ] **Step 1: 写失败测试**

创建 `content/tests/routes-api-marketing-context.test.ts`：

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import * as generateModule from "../src/services/generate";

beforeAll(async () => {
  await seedSession(env as never, "mc2", 94);
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS skill_context (
       tenant_id INTEGER NOT NULL, skill_repo TEXT NOT NULL, content TEXT NOT NULL,
       version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, skill_repo))`
  ).run();
});
afterEach(() => vi.restoreAllMocks());

const H = { Cookie: "session=mc2", "Content-Type": "application/json" };
const call = (path: string, init: RequestInit) =>
  worker.fetch(new Request(`https://content-dev.uni-scrm.com${path}`, { headers: H, ...init }), env);

describe("marketing context 读写", () => {
  it("没写过时返回空", async () => {
    const res = await call("/api/marketing-context", {});
    expect(await res.json()).toEqual({ content: null, version: null, updatedAt: null });
  });

  it("PUT 保存后 GET 拿得到，版本从 1 开始", async () => {
    const put = await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "# doc" }) });
    expect(await put.json()).toEqual({ version: 1 });
    const got = await (await call("/api/marketing-context", {})).json() as { content: string; version: number };
    expect(got.content).toBe("# doc");
    expect(got.version).toBe(1);
  });

  it("空正文拒绝保存", async () => {
    const res = await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "   " }) });
    expect(res.status).toBe(400);
  });

  // 乐观并发：两个标签页各改各的，后写的不该无声覆盖前一个。
  it("baseVersion 与当前不符时 409", async () => {
    await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "# v-a" }) });
    const stale = await call("/api/marketing-context", {
      method: "PUT", body: JSON.stringify({ content: "# v-b", baseVersion: 1 }),
    });
    expect(stale.status).toBe(409);
  });
});

describe("POST /api/marketing-context/chat", () => {
  it("把对话历史拼成 prompt，用 product-marketing 技能做 system", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("下一句提问");
    const res = await call("/api/marketing-context/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [
        { role: "assistant", content: "你的产品叫什么？" },
        { role: "user", content: "UniSCRM" },
      ] }),
    });

    expect(await res.json()).toEqual({ reply: "下一句提问" });
    const params = gen.mock.calls[0][1];
    expect(params.skillId).toBe("marketingskills-product-marketing");
    expect(params.prompt).toContain("你的产品叫什么？");
    expect(params.prompt).toContain("UniSCRM");
    // 出成品文档的哨兵约定必须进 system，否则前端永远解析不出可保存的块
    expect(params.operationContext).toContain("PRODUCT-MARKETING-CONTEXT-V1");
  });

  it("messages 为空时 400", async () => {
    const res = await call("/api/marketing-context/chat", { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/routes-api-marketing-context.test.ts`
Expected: FAIL —— 端点 404。

- [ ] **Step 3: 实现服务侧**

`content/src/services/marketing-context.ts` 追加：

```ts
import { listConfiguredProviders } from "./llm-credentials";
import { getSkillContext } from "./skill-context";

// 对话与起草都跟随租户已配置的文本模型：配了 BYOK 就用 BYOK，没配就用免费默认。
// 与全站一致，不引入"这个功能专用的模型"这种新概念。
export async function resolveContextProvider(
  env: Env,
  tenantId: number
): Promise<"default" | "openai" | "anthropic"> {
  const configured = await listConfiguredProviders(env, tenantId);
  if (configured.some((p) => p.provider === "anthropic")) return "anthropic";
  if (configured.some((p) => p.provider === "openai")) return "openai";
  return "default";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// 哨兵写在围栏的语言标签位，而不是认 ```markdown：模型在对话里会为了举例输出各种
// markdown 块，只有这个串明确表示"这是可保存的成品文档"。
export function buildChatContract(): string {
  return (
    "You are interviewing this user to produce their Product Marketing Context document." +
    " Ask about one section at a time; never dump every question at once." +
    " When — and only when — you have enough to write the full document, output it as a fenced" +
    ` code block whose info string is exactly ${CONTEXT_SENTINEL}, containing the complete markdown` +
    " document and nothing else. Until then, do not emit a block with that info string."
  );
}

export function buildChatPrompt(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
}

export async function chatMarketingContext(env: Env, tenantId: number, messages: ChatMessage[]): Promise<string> {
  const existing = await getSkillContext(env, tenantId, MARKETING_SKILLS_REPO);
  const contract = existing
    ? `${buildChatContract()}\n\nThe tenant's current document follows; update it rather than starting over.\n\n${existing}`
    : buildChatContract();

  return generateContent(env, {
    tenantId,
    prompt: buildChatPrompt(messages),
    provider: await resolveContextProvider(env, tenantId),
    skillId: PRODUCT_MARKETING_SKILL_ID,
    operationContext: contract,
  });
}
```

同时把 `draftMarketingContext` 里的 `provider: "default"` 换成 `provider: await resolveContextProvider(env, tenantId)`。

- [ ] **Step 4: 实现端点**

`content/src/index.ts` 在起草端点旁边加三条：

```ts
app.get("/api/marketing-context", async (c) => {
  const row = await getSkillContextRow(c.env, Number(c.get("tenantId")), MARKETING_SKILLS_REPO);
  return c.json({ content: row?.content ?? null, version: row?.version ?? null, updatedAt: row?.updatedAt ?? null });
});

app.put("/api/marketing-context", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { content, baseVersion } = await c.req.json<{ content: string; baseVersion?: number }>();
  if (!content || !content.trim()) return c.json({ error: "content required" }, 400);

  // 乐观并发：两个标签页各改各的时，后写的不该无声覆盖前一个。
  const current = await getSkillContextRow(c.env, tenantId, MARKETING_SKILLS_REPO);
  if (baseVersion !== undefined && current && current.version !== baseVersion) {
    return c.json({ error: "version conflict", currentVersion: current.version }, 409);
  }

  return c.json(await setSkillContext(c.env, tenantId, MARKETING_SKILLS_REPO, content));
});

app.post("/api/marketing-context/chat", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { messages } = await c.req.json<{ messages: ChatMessage[] }>();
  if (!Array.isArray(messages) || messages.length === 0) return c.json({ error: "messages required" }, 400);
  try {
    return c.json({ reply: await chatMarketingContext(c.env, tenantId, messages) });
  } catch (err) {
    console.error(JSON.stringify({ event: "marketing_context_chat_failed", tenantId, error: String(err) }));
    return c.json({ error: "Chat failed" }, 502);
  }
});
```

`GET`/`PUT` 的裸路径 `/api/marketing-context` 已被 Task 5 注册的 `/api/marketing-context/*` 中间件覆盖（Hono 的 `/*` 也匹配父路径本身），**不要再单独注册一次 `sessionAuth`**，否则它会跑两遍、把内部 fetch 的 Response body 消费两次。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add content/src/services/marketing-context.ts content/src/index.ts content/tests/routes-api-marketing-context.test.ts
git commit -m "feat(content): conversational authoring and storage for the marketing context"
```

---

### Task 7: content 前端 — 上下文卡片与对话 UI

**Files:**
- Create: `content/frontend/components/MarketingContextCard.tsx`
- Create: `content/frontend/lib/context-block.ts`
- Modify: `content/frontend/lib/api.ts`, `content/frontend/pages/SettingsPage.tsx`
- Test: `content/tests/context-block.test.ts`（新建）、`content/tests/marketing-context-card.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5、6 的四条 `/api/marketing-context*` 端点
- Produces: `extractContextBlock(text: string): string | null`（`content/frontend/lib/context-block.ts`）

- [ ] **Step 1: 写哨兵解析的失败测试**

创建 `content/tests/context-block.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { extractContextBlock } from "../frontend/lib/context-block";

const S = "PRODUCT-MARKETING-CONTEXT-V1";

describe("extractContextBlock", () => {
  it("取出带哨兵的完整块", () => {
    const reply = `聊得差不多了，这是文档：\n\n\`\`\`${S}\n# Product Marketing Context\n\n## Product Overview\nUniSCRM ...\n\`\`\`\n\n还需要改什么？`;
    expect(extractContextBlock(reply)).toBe("# Product Marketing Context\n\n## Product Overview\nUniSCRM ...");
  });

  // 这是不自动保存的技术前提：块没闭合就是没写完，存下去等于把半份文档灌进此后所有生成。
  it("围栏没闭合时返回 null", () => {
    expect(extractContextBlock(`\`\`\`${S}\n# Product Marketing Context\n## Product Overview`)).toBeNull();
  });

  it("普通 markdown 块不算数", () => {
    expect(extractContextBlock("举个例子：\n\n```markdown\n# 标题\n```")).toBeNull();
    expect(extractContextBlock("```\n# 无标签\n```")).toBeNull();
  });

  it("块内容为空白时返回 null", () => {
    expect(extractContextBlock(`\`\`\`${S}\n   \n\`\`\``)).toBeNull();
  });

  it("没有块时返回 null", () => {
    expect(extractContextBlock("你的目标客户是谁？")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/context-block.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现解析**

创建 `content/frontend/lib/context-block.ts`：

```ts
// 与后端 CONTEXT_SENTINEL 保持一致（content/src/services/marketing-context.ts）。
export const CONTEXT_SENTINEL = "PRODUCT-MARKETING-CONTEXT-V1";

// 只认「以哨兵为 info string 且已闭合」的围栏块。未闭合 = 模型还没写完，
// 这时给出保存按钮就会把半份文档灌进此后所有生成 —— 宁可让用户多聊一轮。
const BLOCK_RE = new RegExp("```" + CONTEXT_SENTINEL + "\\s*\\n([\\s\\S]*?)\\n```");

export function extractContextBlock(text: string): string | null {
  const m = text.match(BLOCK_RE);
  const body = m?.[1]?.trim();
  return body ? body : null;
}
```

- [ ] **Step 4: 加 api client**

`content/frontend/lib/api.ts` 的 `api` 对象追加：

```ts
  marketingContext: {
    get: (): Promise<{ content: string | null; version: number | null; updatedAt: string | null }> =>
      request("/api/marketing-context"),
    draft: (): Promise<{ draft: string }> =>
      request("/api/marketing-context/draft", { method: "POST", body: "{}" }),
    chat: (messages: { role: "user" | "assistant"; content: string }[]): Promise<{ reply: string }> =>
      request("/api/marketing-context/chat", { method: "POST", body: JSON.stringify({ messages }) }),
    save: (content: string, baseVersion?: number): Promise<{ version: number }> =>
      request("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content, baseVersion }) }),
  },
```

- [ ] **Step 5: 写卡片的接线测试**

创建 `content/tests/marketing-context-card.test.ts`。**本仓库的前端测试事实**：vitest pool 是 workerd，没有 `document`，也没装 `@testing-library/react`（见 `flow/tests/unit/channel-node-panel-order.test.tsx` 顶部的说明）。既有做法是 `?raw` 源码接线断言——照做：

```ts
import { describe, it, expect } from "vitest";
import cardSource from "../frontend/components/MarketingContextCard.tsx?raw";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";

describe("MarketingContextCard 接线", () => {
  // 真正的解析逻辑由 context-block.test.ts 实跑；这里只守"卡片确实用的是它，
  // 而不是自己又写了一个宽松的正则"。
  it("用共享的哨兵解析，不自造判断", () => {
    expect(cardSource).toContain('from "../lib/context-block"');
    expect(cardSource).toContain("extractContextBlock");
  });

  // 不自动保存是这个功能最重要的一条约束：一份残缺文档会污染此后所有生成。
  it("保存按钮受解析结果控制，且没有任何自动保存路径", () => {
    expect(cardSource).toContain("savableDoc && (");
    expect(cardSource).not.toContain("autoSave");
  });

  it("文案双语", () => {
    for (const s of ['{ en: "Brand & product context", zh: "品牌与产品上下文" }',
                     '{ en: "Save this document", zh: "保存这份文档" }',
                     '{ en: "Draft it for me", zh: "帮我起草" }']) {
      expect(cardSource).toContain(s);
    }
  });

  it("卡片挂进了设置页", () => {
    expect(settingsSource).toContain("MarketingContextCard");
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd content && npx vitest run tests/marketing-context-card.test.ts`
Expected: FAIL —— 组件不存在。

- [ ] **Step 7: 实现卡片**

创建 `content/frontend/components/MarketingContextCard.tsx`。用本仓库已有的共享组件（`Button` / `Label` / `Textarea`；见 `SettingsPage.tsx` 的 import 路径），不写 inline CSS：

```tsx
import { useEffect, useState } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Label } from "../../../shared/frontend/ui/label";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";
import { extractContextBlock } from "../lib/context-block";

type Msg = { role: "user" | "assistant"; content: string };

export function MarketingContextCard() {
  const T = useT();
  const { toast } = useToast();
  const [doc, setDoc] = useState<string>("");
  const [version, setVersion] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.marketingContext.get()
      .then((r) => { setDoc(r.content ?? ""); setVersion(r.version); })
      .catch(() => {});
  }, []);

  // 只有解析出带哨兵的完整块才有可保存的文档。解析不出就没有按钮 —— 见 context-block.ts。
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const savableDoc = lastAssistant ? extractContextBlock(lastAssistant.content) : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); }
    catch { toast({ title: T({ en: "Request failed", zh: "请求失败" }), variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const handleDraft = () => run(async () => {
    const { draft } = await api.marketingContext.draft();
    setMessages([{
      role: "assistant",
      content: draft || T({ en: "I could not find enough about you to draft from. Tell me what your product does and who it is for.",
                            zh: "我这边还没有足够的信息可以起草。先告诉我你的产品是做什么的、给谁用？" }),
    }]);
  });

  const handleSend = () => run(async () => {
    const next = [...messages, { role: "user" as const, content: input }];
    setMessages(next);
    setInput("");
    const { reply } = await api.marketingContext.chat(next);
    setMessages([...next, { role: "assistant", content: reply }]);
  });

  const handleSave = (content: string) => run(async () => {
    const { version: v } = await api.marketingContext.save(content, version ?? undefined);
    setDoc(content);
    setVersion(v);
    toast({ title: T({ en: "Context saved", zh: "上下文已保存" }) });
  });

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-sm font-semibold">{T({ en: "Brand & product context", zh: "品牌与产品上下文" })}</h2>
      <p className="text-xs text-muted-foreground">
        {T({ en: "Used by every AI generation for this tenant. Version: ", zh: "本租户所有 AI 生成都会用到。版本：" })}
        {version ?? T({ en: "not set", zh: "未设置" })}
      </p>

      <div className="space-y-2 max-h-80 overflow-y-auto">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-sm text-right" : "text-sm"}>
            <span className="text-xs text-muted-foreground">
              {m.role === "user" ? T({ en: "You", zh: "你" }) : T({ en: "Assistant", zh: "助手" })}
            </span>
            <p className="whitespace-pre-wrap">{m.content}</p>
          </div>
        ))}
      </div>

      {savableDoc && (
        <Button onClick={() => handleSave(savableDoc)} disabled={busy}>
          {T({ en: "Save this document", zh: "保存这份文档" })}
        </Button>
      )}

      <div className="flex gap-2">
        <Textarea value={input} onChange={(e: any) => setInput(e.target.value)} rows={2} className="flex-1 text-sm"
          placeholder={T({ en: "Answer, or ask to change a section...", zh: "回答，或要求修改某一节…" })} />
        <Button onClick={handleSend} disabled={busy || !input.trim()}>{T({ en: "Send", zh: "发送" })}</Button>
        {messages.length === 0 && (
          <Button variant="ghost" onClick={handleDraft} disabled={busy}>
            {T({ en: "Draft it for me", zh: "帮我起草" })}
          </Button>
        )}
      </div>

      <div>
        <Label className="text-xs block mb-1">{T({ en: "Document (editable)", zh: "文档（可直接编辑）" })}</Label>
        <Textarea value={doc} onChange={(e: any) => setDoc(e.target.value)} rows={10} className="w-full text-sm font-mono" />
        <Button className="mt-2" variant="ghost" onClick={() => handleSave(doc)} disabled={busy || !doc.trim()}>
          {T({ en: "Save edits", zh: "保存编辑" })}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: 挂进设置页**

`content/frontend/pages/SettingsPage.tsx`：import 该组件，在三张 provider 卡片的 grid **之后**渲染 `<div className="mt-8"><MarketingContextCard /></div>`。

- [ ] **Step 9: 跑测试与类型检查**

Run: `cd content && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS。`transcribe.ts` 的 `Buffer` 错误是既有的，不是你的。

- [ ] **Step 10: 提交**

```bash
git add content/frontend/lib/context-block.ts content/frontend/components/MarketingContextCard.tsx content/frontend/lib/api.ts content/frontend/pages/SettingsPage.tsx content/tests/context-block.test.ts content/tests/marketing-context-card.test.ts
git commit -m "feat(content): author the marketing context conversationally in settings"
```

---

### Task 8: content — 图片提示词长度保护下沉到适配器

**Files:**
- Modify: `content/src/providers/image-interface.ts`, `content/src/providers/workers-ai-image.ts`, `content/src/providers/openai-image.ts`
- Test: `content/tests/providers/workers-ai-image.test.ts`、`content/tests/providers/openai-image.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `clampPrompt(prompt: string, maxChars: number): string`（`content/src/providers/image-interface.ts`）

- [ ] **Step 1: 写失败测试**

`content/tests/providers/workers-ai-image.test.ts` 追加（该文件已有 `ai.run` 的 mock 写法，照它写）：

```ts
// flux-1-schnell 的提示词上限实测为 2048 字符（含）：2048 通过，2049 返回 502。
// 超限时静默丢图是本仓库真踩过的坑，所以保护放在这里 —— 适配器是唯一知道"自己这个
// 模型能吃多长"的地方，放在这里所有调用方都受保护。
it("把超出 flux 上限的提示词截到 2048 再发", async () => {
  const aiRun = vi.fn().mockResolvedValue({ image: btoa("x") });
  await new WorkersAiImageProvider({ run: aiRun } as never)
    .generate("a".repeat(2100), "@cf/black-forest-labs/flux-1-schnell");
  expect(aiRun.mock.calls[0][1].prompt).toHaveLength(2048);
});

it("正好 2048 的提示词原样发出", async () => {
  const aiRun = vi.fn().mockResolvedValue({ image: btoa("x") });
  await new WorkersAiImageProvider({ run: aiRun } as never)
    .generate("a".repeat(2048), "@cf/black-forest-labs/flux-1-schnell");
  expect(aiRun.mock.calls[0][1].prompt).toHaveLength(2048);
});
```

`content/tests/providers/openai-image.test.ts` 追加：

```ts
// gpt-image-1 与 dall-e-3 的提示词上限不同，各按各的截。
it("按模型各自的上限截断", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [{ b64_json: btoa("x") }] }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  await new OpenAiImageProvider("sk-x").generate("a".repeat(40000), "gpt-image-1");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toHaveLength(32000);

  await new OpenAiImageProvider("sk-x").generate("a".repeat(5000), "dall-e-3");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toHaveLength(4000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/providers`
Expected: FAIL —— 提示词原样发出，长度不符。

- [ ] **Step 3: 实现**

`content/src/providers/image-interface.ts` 追加：

```ts
// 每个扩散模型对提示词长度都有硬上限，超了就是一个 4xx/5xx，而调用链上游会把它降级成
// "这条内容没有配图"、只留一行日志。截断在扩散模型上几乎零损失（它对提示词开头之外的
// 部分注意力很弱），所以宁可截也不要让请求撞墙。上限由各适配器提供 —— 它们是唯一知道
// 自己那个模型能吃多长的地方。
export function clampPrompt(prompt: string, maxChars: number): string {
  return prompt.length <= maxChars ? prompt : prompt.slice(0, maxChars);
}
```

`content/src/providers/workers-ai-image.ts`：

```ts
import { base64ToBytes, clampPrompt } from "./image-interface";

// 实测边界：2048 字符通过，2049 返回 502。
const FLUX_MAX_PROMPT_CHARS = 2048;

export class WorkersAiImageProvider implements ImageProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // flux-1-schnell's response shape is { image: string } (base64-encoded JPEG),
    // unlike the text models' { response: string } shape.
    const result = (await this.ai.run(model, {
      prompt: clampPrompt(prompt, FLUX_MAX_PROMPT_CHARS),
      steps: 4,
    })) as { image: string };
    return { bytes: base64ToBytes(result.image), contentType: "image/jpeg" };
  }
}
```

`content/src/providers/openai-image.ts`：沿用已有的 `isGptImage` 判断，加上限并在组 body 时截断：

```ts
// OpenAI 两个族的提示词上限不同（gpt-image-1 32000、dall-e-3 4000）。
const GPT_IMAGE_MAX_PROMPT_CHARS = 32000;
const DALL_E_MAX_PROMPT_CHARS = 4000;
```

`const body` 里的 `prompt` 改为 `clampPrompt(prompt, isGptImage ? GPT_IMAGE_MAX_PROMPT_CHARS : DALL_E_MAX_PROMPT_CHARS)`，并 import `clampPrompt`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add content/src/providers/image-interface.ts content/src/providers/workers-ai-image.ts content/src/providers/openai-image.ts content/tests/providers/workers-ai-image.test.ts content/tests/providers/openai-image.test.ts
git commit -m "feat(content): clamp image prompts to each model's real limit in the adapter"
```

---

### Task 9: content — 两段式出图

**Files:**
- Modify: `content/src/services/generate-image.ts`, `content/src/routes-internal.ts`
- Test: `content/tests/generate-image.test.ts`, `content/tests/routes-internal.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MARKETING_SKILLS_REPO`；Task 2 之后的 `generateContent`（已会注入上下文）；Task 8 的适配器截断
- Produces:
  - `IMAGE_PROMPT_SKILL_ID = "marketingskills-image"`
  - `buildImagePromptContract(): string`
  - `GenerateImageParams = { tenantId: number; provider: "default" | "openai"; sourceTitle?: string; sourceText?: string }`
  - `/internal/generate-image` 请求体同上（**不再有 `prompt`**）

- [ ] **Step 1: 写失败测试**

`content/tests/generate-image.test.ts` 追加，并删掉所有还在传 `prompt` 的旧用例：

```ts
import * as generateModule from "../src/services/generate";

it("stage 1 用 image 技能把触发内容写成视觉描述，stage 2 拿它出图", async () => {
  const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("a futuristic dashboard, neon accents");
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
  const aiRun = vi.fn().mockResolvedValue({ image: btoa("png") });

  await generateImage({ AI: { run: aiRun } } as never, {
    tenantId: 1, provider: "default", sourceTitle: "v2.10.0", sourceText: "attribution models and reconciliation",
  });

  const stage1 = gen.mock.calls[0][1];
  expect(stage1.skillId).toBe("marketingskills-image");
  expect(stage1.prompt).toContain("v2.10.0");
  expect(stage1.prompt).toContain("attribution models");
  expect(stage1.operationContext).toContain("no readable text");
  expect(aiRun.mock.calls[0][1].prompt).toBe("a futuristic dashboard, neon accents");
});

// stage 1 不设人为上限：压缩就是它的职责，长度保护住在适配器里（Task 8）。
it("不对 stage 1 的输出做长度处理", async () => {
  vi.spyOn(generateModule, "generateContent").mockResolvedValue("b".repeat(900));
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
  const aiRun = vi.fn().mockResolvedValue({ image: btoa("png") });

  await generateImage({ AI: { run: aiRun } } as never, { tenantId: 1, provider: "default", sourceTitle: "t" });

  expect(aiRun.mock.calls[0][1].prompt).toHaveLength(900);
});

it("stage 1 失败时整体抛错，交给调用方降级", async () => {
  vi.spyOn(generateModule, "generateContent").mockRejectedValue(new Error("model down"));
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
  await expect(
    generateImage({ AI: { run: vi.fn() } } as never, { tenantId: 1, provider: "default", sourceTitle: "t" })
  ).rejects.toThrow(/model down/);
});

// 没有图片模型仍然要在花掉一次文本推理之前就失败。
it("没有图片模型时不跑 stage 1", async () => {
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue(null);
  const gen = vi.spyOn(generateModule, "generateContent");
  await expect(
    generateImage({} as never, { tenantId: 1, provider: "openai", sourceTitle: "t" })
  ).rejects.toThrow(/No image model configured/);
  expect(gen).not.toHaveBeenCalled();
});
```

`content/tests/routes-internal.test.ts` 的 `/internal/generate-image` 段落：把请求体从 `{ tenantId, prompt, provider }` 改成 `{ tenantId, provider, sourceTitle, sourceText }`，并加：

```ts
it("缺少 sourceTitle 和 sourceText 时 400", async () => {
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
      method: "POST",
      headers: { "X-Internal-Secret": "test-internal-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: 1, provider: "default" }),
    }),
    testEnv
  );
  expect(res.status).toBe(400);
});
```

（`testEnv` / secret 值照该文件既有写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/generate-image.test.ts tests/routes-internal.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`content/src/services/generate-image.ts` 整体改写为：

```ts
import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { generateContent } from "./generate";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

export const IMAGE_PROMPT_SKILL_ID = "marketingskills-image";

export interface GenerateImageParams {
  tenantId: number;
  provider: "default" | "openai";
  sourceTitle?: string;
  sourceText?: string;
}

// stage 1 的执行契约。扩散模型要的是"一个仪表盘、冷色调、浅景深"，不是产品说明书 ——
// 这段话的全部作用就是把文本模型的输出压成可以直接送进扩散模型的一行。
export function buildImagePromptContract(): string {
  return (
    "Write one image prompt for a text-to-image diffusion model, for an illustration that will" +
    " accompany the content below on social media." +
    " Output only that prompt as a single plain-text line in English — no quotes, no commentary," +
    " no alternatives, no markdown." +
    " The image must contain no readable text."
  );
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  // 先确认出图模型存在，再花 stage 1 那次文本推理 —— 配置错了没必要先烧一次推理。
  const model = await credentialsModule.getImageModel(env, params.tenantId, params.provider);
  if (!model) {
    throw new Error(`No image model configured for provider ${params.provider}`);
  }

  // stage 1：文本模型读内容，写出视觉描述。技能与租户上下文都由 generateContent 注入。
  const source = [params.sourceTitle, params.sourceText].filter(Boolean).join("\n\n");
  const imagePrompt = await generateContent(env, {
    tenantId: params.tenantId,
    prompt: source,
    provider: "default",
    skillId: IMAGE_PROMPT_SKILL_ID,
    operationContext: buildImagePromptContract(),
  });

  console.log(JSON.stringify({
    event: "image_prompt_generated",
    tenantId: params.tenantId,
    sourceChars: source.length,
    promptChars: imagePrompt.length,
    prompt: imagePrompt,
  }));

  // stage 2。提示词长度保护住在适配器里（image-interface.ts 的 clampPrompt）。
  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(imagePrompt, model);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }
  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(imagePrompt, model);
}
```

**stage 1 固定用 `provider: "default"`**：出图这一段总是需要一个文本模型，而节点上的文本 provider 可以是 `"none"`；用免费默认模型也让"加一张配图"不额外烧租户的 BYOK 额度。

`content/src/routes-internal.ts` 的 `/generate-image`：

```ts
  router.post("/generate-image", async (c) => {
    const { tenantId, provider, sourceTitle, sourceText } = await c.req.json<{
      tenantId: number;
      provider: "default" | "openai";
      sourceTitle?: string;
      sourceText?: string;
    }>();

    if (!tenantId || !provider || (!sourceTitle && !sourceText)) {
      return c.json({ error: "tenantId, provider, and one of sourceTitle/sourceText required" }, 400);
    }

    try {
      const { bytes, contentType } = await generateImage(c.env, { tenantId, provider, sourceTitle, sourceText });
      const key = crypto.randomUUID();
      await c.env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      return c.json({ url: `${c.env.CONTENT_URL}/public/media/${key}` });
    } catch (err) {
      const message = String(err);
      if (message.includes("No image model configured") || message.includes("credentials configured")) {
        return c.json({ error: message }, 400);
      }
      console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: message }));
      return c.json({ error: "Image generation failed" }, 502);
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add content/src/services/generate-image.ts content/src/routes-internal.ts content/tests/generate-image.test.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): generate images in two stages, distilling the source content first"
```

---

### Task 10: link + flow — 改传 sourceTitle/sourceText，删掉 imagePrompt

**Files:**
- Modify: `link/src/routes-internal.ts`（`/content/create-post` 与 `/tiktok/photo-post`）
- Modify: `flow/src/node-executors.ts`, `flow/src/index.ts`, `flow/frontend/components/Inspector.tsx`
- Test: `link/tests/services/routes-internal-content.test.ts`, `link/tests/services/routes-internal-tiktok-photo-post.test.ts`, `flow/tests/unit/node-executors.test.ts`, `flow/tests/unit/queue-content.test.ts`, `flow/tests/unit/x-image-attachment.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `/internal/generate-image { tenantId, provider, sourceTitle, sourceText }`
- Produces: `/internal/content/create-post` 接受 `sourceTitle?` / `sourceText?` 取代 `imagePrompt`；节点 data 不再有 `imagePrompt`

- [ ] **Step 1: 写失败测试**

`link/tests/services/routes-internal-content.test.ts`：把挂图用例的请求体从 `imagePrompt` 改为 `sourceTitle` / `sourceText`，并加：

```ts
it("把触发内容原样转给 generate-image，不再自己拼提示词", async () => {
  // …照本文件既有写法 mock 各跳；请求体带 attachImage 语义的 sourceTitle/sourceText
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/internal/generate-image"))!;
  const body = JSON.parse(call[1].body);
  expect(body).toEqual(expect.objectContaining({ sourceTitle: "v2.10.0", sourceText: "attribution models" }));
  expect(body).not.toHaveProperty("prompt");
});
```

`link/tests/services/routes-internal-tiktok-photo-post.test.ts`：同样把 `prompts.message_image` 相关断言改为断言转发 `sourceTitle` / `sourceText`。

`flow/tests/unit/node-executors.test.ts`：

```ts
it("不再产出 imagePrompt", () => {
  const action = buildAction({
    id: "a1", type: "action",
    data: { actionType: "xContentAction", operation: "create-post", prompt: "p", provider: "default",
            attachImage: true, imageProvider: "default", imagePrompt: "旧图里残留的" },
  } as never);
  expect(action).not.toHaveProperty("imagePrompt");
  expect(action).toEqual(expect.objectContaining({ attachImage: true, imageProvider: "default" }));
});
```

`flow/tests/unit/queue-content.test.ts`：把断言 `body.imagePrompt` 的用例改为断言 `body.sourceTitle` / `body.sourceText` 来自 payload 的 `title` / `content_text`；「没勾图片就不带图片字段」那条改为断言不含 `sourceTitle` / `sourceText` / `imageProvider`。

`flow/tests/unit/x-image-attachment.test.ts`：接线断言里把"图片提示词框存在"改成不存在：

```ts
it("节点面板不再有图片提示词输入框", () => {
  expect(inspectorSource).not.toContain("imagePrompt");
  expect(inspectorSource).not.toContain("抽象科技风插画");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts` 与 `cd flow && npx vitest run`
Expected: FAIL。

- [ ] **Step 3: 改 link**

`/content/create-post`：请求体的 `imagePrompt` 换成 `sourceTitle?: string` 与 `sourceText?: string`；`generateAndUploadImage` 的签名相应改为接收这两个字段，转发给 `/internal/generate-image` 的 body 改为 `{ tenantId, provider, sourceTitle, sourceText }`；触发条件从 `if (!mediaId && imagePrompt)` 改为 `if (!mediaId && (sourceTitle || sourceText))`。降级、日志、视频优先的逻辑全部不动。

`/tiktok/photo-post`：`prompts.message_image` 不再用于出图，改为把 `sourceTitle` / `sourceText`（同样来自请求体）转给 `/internal/generate-image`；`imageCount` 循环保持不变。

- [ ] **Step 4: 改 flow**

`flow/src/node-executors.ts` 的 `xContentAction`：删掉 `a.imagePrompt = …` 那一行，保留 `attachImage` 与 `imageProvider`。

`flow/src/index.ts` 的 xContentAction 非视频分支：删掉 `imagePrompt` 的插值，改为

```ts
        // 触发内容原样交给 content，由那边的 stage 1 读懂并写成视觉描述 ——
        // 前端不再让用户手写图片提示词，"把正文插进提示词"这个失败模式随之消失。
        const imageSource = action.attachImage
          ? { sourceTitle: String(payload?.title ?? ""), sourceText: String(payload?.content_text ?? "") }
          : null;
```

body 里的展开改为 `...(imageSource ? { ...imageSource, imageProvider: action.imageProvider || "default" } : {})`，`logExtra` 的 `attachImage` 保持 `!!action.attachImage`（那是节点配置，不是请求内容）。

`flow/frontend/components/Inspector.tsx`：删掉 X 与 TikTok 两处的图片提示词 `<Textarea>` 块及其 `imagePrompt` / `prompts.message_image` 写入；`imageProp` 现在只用于决定"这个操作是否支持配图"，不再驱动输入框。图片 provider 下拉、`attachImage` 勾选框、TikTok 的 `imageCount` 全部保留。

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd link && npx vitest run` 与 `cd flow && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS。flow 的 `EditorPage.tsx` 有一条**先于本计划存在**的 `FlowDetail.enabled` 类型错误，不是你的。

- [ ] **Step 6: 提交**

```bash
git add link/src/routes-internal.ts flow/src/node-executors.ts flow/src/index.ts flow/frontend/components/Inspector.tsx link/tests/services/routes-internal-content.test.ts link/tests/services/routes-internal-tiktok-photo-post.test.ts flow/tests/unit/node-executors.test.ts flow/tests/unit/queue-content.test.ts flow/tests/unit/x-image-attachment.test.ts
git commit -m "feat(flow,link): hand the source content to content's two-stage image path"
```

---

### Task 11: 配置、部署与自测

**Files:**
- Modify: `flow/sequence.md`

**Interfaces:**
- Consumes: Task 1–10
- Produces: 无

- [ ] **Step 1: 配 secret 并同步 CI**

`CF_D1_API_TOKEN` 需要配到 content 的 dev 与 prod（按仓库既有做法用全局 `wrangler`，**不要 `npx wrangler`**）：

```bash
cd content && wrangler secret put CF_D1_API_TOKEN --env dev
cd content && wrangler secret put CF_D1_API_TOKEN --env production
```

同时检查 `.github/workflows/` 里的 sync-secrets 作业是否需要把 content 的这一项加进去（`link` 已经有同名 secret，照它的配置方式加）。

**这一步需要人提供 token 值。** 拿不到就停下报告，不要跳过——起草端点会因此常态返回空草稿。

- [ ] **Step 2: 应用 migration 并刷新两个新技能的缓存**

```bash
cd content && wrangler d1 migrations apply uniscrm-content-dev --env dev --remote
```

部署后刷新两条新技能的缓存（`refreshSkillContent` 是手动触发的，不会自己跑）：

```bash
curl -X POST https://content-dev.uni-scrm.com/internal/skills/marketingskills-image/refresh \
  -H "X-Internal-Secret: dev-internal-secret"
curl -X POST https://content-dev.uni-scrm.com/internal/skills/marketingskills-product-marketing/refresh \
  -H "X-Internal-Secret: dev-internal-secret"
```

两条都要返回 `{"ok":true}`。image 技能的 SKILL.md 里有 `[references/ai-image-prompting.md](references/ai-image-prompting.md)`，会被现有逻辑自动内联——刷新后用 `SELECT length(content) FROM skill_content_cache` 确认它明显大于 SKILL.md 本身（约 15.8KB + 8.3KB）。

- [ ] **Step 3: 更新时序图**

`flow/sequence.md` 的 `## Content-domain: xContentAction` 一节：把出图那一步从"link 传 imagePrompt"改为"link 传 sourceTitle/sourceText，content 内部先跑 stage 1 文本模型再出图"，并在图下补一句：stage 1 的系统提示词由 image 技能 + 该租户的 marketing 上下文组成；提示词长度保护在 provider 适配器里，不在 stage 1。

- [ ] **Step 4: 部署 dev**

```bash
cd content && npm run deploy:dev
cd ../link && npm run deploy:dev
cd ../flow && npm run deploy:dev
```

**必须用 `npm run deploy:dev`**：裸 `wrangler deploy` 会打到 PROD 并抹掉 bindings，手跑 `--env dev` 会跳过 vite 前端构建、发出过期前端。

部署后核对前端产物确实是新的（本仓库真出现过 wrangler 报错退出、前端却没更新的情况）：

```bash
curl -s https://content-dev.uni-scrm.com/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js'
```

取到的 bundle 里应含 `品牌与产品上下文`，flow 的 bundle 里应**不含** `imagePrompt`。

- [ ] **Step 5: 浏览器自测**

复用已登录的 Chrome 会话（`tabs_context_mcp`）：

1. `https://content-dev.uni-scrm.com/settings`：出现「品牌与产品上下文」卡片；点「帮我起草」，确认返回一份 12 节草稿；追问一句确认对话能继续；模型给出带哨兵的块后确认「保存这份文档」按钮出现，点击后版本变为 1。
2. 刷新页面，确认文档与版本被持久化。
3. 打开一个含 X Content Action 的 content flow：确认节点上**没有**图片提示词输入框，图片勾选框与图片模型下拉仍在。
4. 直接验证两段式（不发推文）：
   ```bash
   curl -s -X POST https://content-dev.uni-scrm.com/internal/generate-image \
     -H "X-Internal-Secret: dev-internal-secret" -H "Content-Type: application/json" \
     -d '{"tenantId":<你的租户 id>,"provider":"default","sourceTitle":"v2.10.0","sourceText":"<一段 2000+ 字的 release 正文>"}'
   ```
   期望 200 并返回图片 URL——**这正是改造前必然 502 的输入**。同时在 `wrangler tail` 里确认 `image_prompt_generated` 日志中的 `promptChars` 是几百而不是几千。

- [ ] **Step 6: 提交**

```bash
git add flow/sequence.md
git commit -m "docs(flow): describe the two-stage image path in the xContentAction sequence"
```

---

## Self-Review

**Spec 覆盖：**

| Spec 章节 | 任务 |
|---|---|
| §2 注入顺序 | 2 |
| §3.1 归属包（`repo` 字段） | 1 |
| §3.2 存储（表、无行级历史） | 1 |
| §3.3 起草（内容 + 渠道、两者皆空、配置） | 3, 4, 5 |
| §3.4 对话（哨兵、不自动保存、PUT） | 6, 7 |
| §3.5 模型（跟随租户配置） | 6 |
| §3.6 注入（不存在即不注入） | 2 |
| §4.1 边界（两段都在 content） | 9 |
| §4.2 接口（sourceTitle/sourceText） | 9, 10 |
| §4.3 stage 1（技能、契约、default 模型、不设上限） | 9 |
| §4.4 适配器截断 | 8 |
| §4.5 失败降级 | 9, 10 |
| §5 删除（提示词框、imagePrompt） | 10 |
| §6 测试 | 各任务内 |
| §7 明确不做 | 全程 |

**类型一致性：** `getSkillContext(env, tenantId, skillRepo)` / `setSkillContext` / `getSkillContextRow` 在 Task 1 定义，Task 2、6 按同名同参使用；`MARKETING_SKILLS_REPO` 在 Task 1 导出，Task 5、6、9 使用；`listRecentTenantContent` 在 Task 3 定义，Task 5 使用；`clampPrompt(prompt, maxChars)` 在 Task 8 定义，两个适配器使用；`CONTEXT_SENTINEL` 在 Task 5（后端）与 Task 7（前端 `context-block.ts`）各有一份同值常量，Task 6 的测试断言 system 里含该串、Task 7 的测试断言前端用的是共享解析函数——两处不同步会被这两条测试同时挡住；`sourceTitle` / `sourceText` 从 Task 9（content 入参）到 Task 10（link 出参、flow 出参）全程同名。

**占位符扫描：** 无 TBD / TODO / "similar to Task N"。Task 10 的测试里以「照本文件既有写法」标注的部分，指的是复用该测试文件已有的 mock 与请求构造工具，断言本身已写全。

**一处需要人介入：** Task 11 Step 1 的 `CF_D1_API_TOKEN` 需要用户提供，拿不到就停下报告。
