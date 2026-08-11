# X Content Action 图片生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 X Content Action 的 create-post 能附带一张 AI 生成的配图，图片模型的选择集中到 AI Content Settings 页并按 provider 动态发现。

**Architecture:** 复用已有的出图管道（`content` 的 `/internal/generate-image` → Workers AI / OpenAI → R2 → URL）。新增的是三件事：图片模型从代码常量迁到 `tenant_llm_credentials.image_model` 一列；`link` 的 create-post 多一条"取图 → 以 `media_category="tweet_image"` 上传 X"的分支；flow 的 X 节点多一个图片勾选框，与视频勾选框互斥（发布校验拦）。TikTok photo-post 的图片块同步收敛成同一形态。

**Tech Stack:** Cloudflare Workers（Hono）、D1、R2、Workers AI、vitest + `@cloudflare/vitest-pool-workers`、React（无 DOM 测试环境）

**Spec:** `docs/superpowers/specs/2026-08-11-x-content-action-image-generation-design.md`

## Global Constraints

- 图片是**氛围配图**，不是信息卡片。不试图让扩散模型写准文字，不引入任何模板渲染/光栅化方案。
- **一段式**：用户写的图片 prompt 插值 `$content.*` 后**直接**送扩散模型，不经文本模型改写。
- X create-post **固定 1 张图**。TikTok 的 `imageCount`（1–9）保留不动。
- **无运行时硬编码回退**：Default provider 的 `@cf/black-forest-labs/flux-1-schnell` 是*初始配置值*（与文本侧 `getDefaultModel` 的 `model ?? DEFAULT_WORKERS_AI_MODEL` 完全同构）；BYOK provider 的 `image_model` 为 NULL 就是没配置，不兜底、不代换成别的 provider。
- **"Anthropic 没有图片模型"不写死**：由对 `/v1/models` 结果套同一个图片模型正则筛出空列表得出。
- 出图失败（生成 / 下载 / X 拒绝）→ 记日志，**继续发纯文本推，节点记为成功**。失败原因只进日志，不进 `reason`（`reason` 会写进 `content_flow_log`，外部错误体长度不可控）。
- 图片与视频**同时勾选是配置错误**，由 `validate-flow-graph.ts` 在发布前拦下。
- `metadata/x-byok.ts` 中 create-post 的 `price: 0.010` **不变**（那是 X 的发推计费；出图不是平台文档记载的 per-call fee）。
- 所有面向用户的文案必须 `{ en, zh }` 双语；品牌名（OpenAI / Anthropic / Cloudflare Workers AI / 模型 id）不翻译，按仓库惯例加 `// i18n-ok:` 注释。
- 提交只 `git add` 明确列出的路径，**禁止 `git add -A`**（本仓库有其他 session 的未提交文件）。
- 不要 push 到 main；dev 部署一律用模块目录下的 `npm run deploy:dev`。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `content/migrations/0007_image_model.sql` | 加 `image_model` 列 | 1 |
| `content/src/services/llm-credentials.ts` | 图片模型读写 | 1 |
| `content/src/services/model-catalog.ts` | 图片模型的动态发现与筛选 | 1 |
| `content/src/services/generate-image.ts` | 出图时解析租户配置的模型 | 2 |
| `content/src/routes-internal.ts` | `/generate-image` 去掉 skillId、配置缺失返回 400 | 2 |
| `content/src/index.ts` | `/api/llm-models` 的 kind、credentials 的 imageModel、`/api/image-providers` | 3 |
| `content/frontend/lib/api.ts` + `pages/SettingsPage.tsx` | 设置页的 Image model 选择器 | 4 |
| `metadata/x-byok.ts` | create-post 加 `message_image` | 5 |
| `link/src/services/x-posts-api.ts` | `initMediaUpload` 的 mediaCategory 参数 | 5 |
| `link/src/routes-internal.ts` | create-post 的图片分支；TikTok 去掉 imageSkillId | 5, 6 |
| `flow/src/node-executors.ts` + `flow/src/index.ts` | 透传与插值、代理 `/api/image-providers` | 7 |
| `flow/frontend/*` | 节点 UI、发布校验、错误文案 | 8 |
| `flow/sequence.md` | 时序图补出图两步 | 9 |

---

### Task 1: content — 图片模型的存储与动态发现

**Files:**
- Create: `content/migrations/0007_image_model.sql`
- Modify: `content/src/services/llm-credentials.ts`
- Modify: `content/src/services/model-catalog.ts`
- Test: `content/tests/llm-credentials.test.ts`, `content/tests/model-catalog.test.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces:
  - `DEFAULT_WORKERS_AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell"`
  - `getImageModel(env: Env, tenantId: number, provider: "default" | "openai" | "anthropic"): Promise<string | null>`
  - `setDefaultModel(env, tenantId, model: string, imageModel: string | null): Promise<void>`（多了第 4 个必填参数）
  - `setTenantLlmCredentials(env, tenantId, provider, apiKey: string, model: string, imageModel: string | null): Promise<void>`（多了第 6 个必填参数）
  - `getDefaultImageModel(env, tenantId): Promise<string>`
  - `listConfiguredProviders` 的返回项多一个 `imageModel: string | null`
  - `OPENAI_STATIC_IMAGE_MODELS: string[]`、`ANTHROPIC_STATIC_IMAGE_MODELS: string[]`
  - `filterImageModels(ids: string[]): string[]`
  - `listOpenAiImageModels(apiKey: string): Promise<string[]>`
  - `listAnthropicImageModels(apiKey: string): Promise<string[]>`
  - `listWorkersAiImageModels(env: Env): Promise<string[]>`

- [ ] **Step 1: 写 migration**

创建 `content/migrations/0007_image_model.sql`：

```sql
-- Per-provider image model, alongside the existing text `model` column. NULL means
-- "this tenant has not configured an image model for this provider" — for BYOK providers
-- that is a real, load-bearing state (the provider is then not offered in flow's image
-- provider dropdown). The 'default' provider never needs it: getDefaultImageModel falls
-- back to the same constant the text side uses for `model`.
ALTER TABLE tenant_llm_credentials ADD COLUMN image_model TEXT;
```

- [ ] **Step 2: 写 model-catalog 的失败测试**

在 `content/tests/model-catalog.test.ts` 末尾追加：

```ts
import {
  filterImageModels,
  listOpenAiImageModels,
  listAnthropicImageModels,
  listWorkersAiImageModels,
  OPENAI_STATIC_IMAGE_MODELS,
  ANTHROPIC_STATIC_IMAGE_MODELS,
} from "../src/services/model-catalog";

describe("image model discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps image model ids and drops chat/embedding/audio ones", () => {
    expect(
      filterImageModels(["gpt-4o", "gpt-image-1", "dall-e-3", "dall-e-2", "text-embedding-3-small", "whisper-1"])
    ).toEqual(["dall-e-2", "dall-e-3", "gpt-image-1"]);
  });

  // 这一条就是 spec 里「Anthropic 没有图片模型」那句话的全部实现——不是写死的规则，
  // 而是同一个正则套在 Anthropic 真实返回的模型列表上自然筛空。
  it("filters an Anthropic model list down to nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }] }), { status: 200 })
    ));
    expect(await listAnthropicImageModels("sk-ant-x")).toEqual([]);
    expect(ANTHROPIC_STATIC_IMAGE_MODELS).toEqual([]);
  });

  it("lists OpenAI image models from /v1/models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-image-1" }] }), { status: 200 })
    ));
    expect(await listOpenAiImageModels("sk-x")).toEqual(["gpt-image-1"]);
    expect(OPENAI_STATIC_IMAGE_MODELS).toContain("gpt-image-1");
  });

  it("asks Cloudflare for Text-to-Image models, not text generation ones", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [{ name: "@cf/black-forest-labs/flux-1-schnell", task: { name: "Text-to-Image" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const models = await listWorkersAiImageModels({ CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" } as never);
    expect(models).toEqual(["@cf/black-forest-labs/flux-1-schnell"]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("task=Text-to-Image");
  });
});
```

若该文件顶部尚未 import `vi` / `afterEach`，一并补上。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd content && npx vitest run tests/model-catalog.test.ts`
Expected: FAIL —— `filterImageModels` 等符号不存在。

- [ ] **Step 4: 实现 model-catalog**

在 `content/src/services/model-catalog.ts` 中：把 OpenAI / Anthropic 的取号动作从筛选里拆出来，再加图片侧。

```ts
export const OPENAI_STATIC_IMAGE_MODELS = ["gpt-image-1", "dall-e-3"];
// 空数组不是"待补"，是结论：Anthropic 不提供图片模型，无 key 时的静态目录因此为空。
export const ANTHROPIC_STATIC_IMAGE_MODELS: string[] = [];

// 与 NON_CHAT_KEYWORDS 同性质的启发式：provider 的 /v1/models 不带能力字段，只能按 id 认。
// 认得出的都认，认不出的一律不认——宁可让用户在下拉里少看到一个模型，也不要把一个
// 对话模型送进出图接口。
const IMAGE_ID_PATTERN = /^(gpt-image|dall-e|imagen|stable-diffusion|flux)/i;

export function filterImageModels(ids: string[]): string[] {
  return ids.filter((id) => IMAGE_ID_PATTERN.test(id)).sort();
}

async function fetchOpenAiModelIds(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

async function fetchAnthropicModelIds(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

export async function listOpenAiImageModels(apiKey: string): Promise<string[]> {
  return filterImageModels(await fetchOpenAiModelIds(apiKey));
}

export async function listAnthropicImageModels(apiKey: string): Promise<string[]> {
  return filterImageModels(await fetchAnthropicModelIds(apiKey));
}

export async function listWorkersAiImageModels(env: Env): Promise<string[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?task=Text-to-Image`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Workers AI image models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { name: string; task?: { name: string } | null }[] };
  return body.result
    .filter((m) => !m.task || /text-to-image/i.test(m.task.name))
    .map((m) => m.name)
    .sort();
}
```

同时把现有的 `listOpenAiModels` / `listAnthropicModels` 改成复用新的 `fetchOpenAiModelIds` / `fetchAnthropicModelIds`（行为不变：OpenAI 仍套 `CHAT_ID_PREFIX` + `NON_CHAT_KEYWORDS`，Anthropic 仍不筛，两者仍 `.sort()`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd content && npx vitest run tests/model-catalog.test.ts`
Expected: PASS（含原有用例）。

- [ ] **Step 6: 写 llm-credentials 的失败测试**

在 `content/tests/llm-credentials.test.ts` 末尾追加：

```ts
import { getImageModel, getDefaultImageModel, DEFAULT_WORKERS_AI_IMAGE_MODEL } from "../src/services/llm-credentials";

describe("image model", () => {
  // Default 的常量是「初始配置值」，不是「兜底」：这条与文本侧 getDefaultModel 的
  // `model ?? DEFAULT_WORKERS_AI_MODEL` 完全同构，也是 Default provider 永远可选的原因。
  it("returns the built-in Workers AI image model when the tenant never chose one", async () => {
    expect(await getDefaultImageModel(env as never, 4201)).toBe(DEFAULT_WORKERS_AI_IMAGE_MODEL);
    expect(await getImageModel(env as never, 4201, "default")).toBe(DEFAULT_WORKERS_AI_IMAGE_MODEL);
  });

  it("returns the tenant's chosen image model once saved", async () => {
    await setDefaultModel(env as never, 4202, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/bytedance/stable-diffusion-xl-lightning");
    expect(await getImageModel(env as never, 4202, "default")).toBe("@cf/bytedance/stable-diffusion-xl-lightning");
  });

  // BYOK 没有兜底：NULL 就是「没配置」，调用方据此把该 provider 从可选列表里去掉。
  it("returns null for a BYOK provider with no image model configured", async () => {
    await setTenantLlmCredentials(env as never, 4203, "openai", "sk-test", "gpt-4.1", null);
    expect(await getImageModel(env as never, 4203, "openai")).toBeNull();
  });

  it("returns null for a BYOK provider that has no credentials row at all", async () => {
    expect(await getImageModel(env as never, 4204, "openai")).toBeNull();
  });

  it("carries imageModel through listConfiguredProviders", async () => {
    await setTenantLlmCredentials(env as never, 4205, "openai", "sk-test", "gpt-4.1", "gpt-image-1");
    const rows = await listConfiguredProviders(env as never, 4205);
    expect(rows).toEqual([expect.objectContaining({ provider: "openai", model: "gpt-4.1", imageModel: "gpt-image-1" })]);
  });
});
```

该文件已有的 `setDefaultModel` / `setTenantLlmCredentials` 调用全部补上新的最后一个参数（`null`），否则类型不过。

- [ ] **Step 7: 跑测试确认失败**

Run: `cd content && npx vitest run tests/llm-credentials.test.ts`
Expected: FAIL —— `getImageModel` 不存在 / 参数个数不符。

- [ ] **Step 8: 实现 llm-credentials**

`content/src/services/llm-credentials.ts`：

```ts
export const DEFAULT_WORKERS_AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export async function getDefaultImageModel(env: Env, tenantId: number): Promise<string> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT image_model FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = 'default'"
  ).bind(tenantId).first<{ image_model: string | null }>();
  return row?.image_model ?? DEFAULT_WORKERS_AI_IMAGE_MODEL;
}

// BYOK provider 没有任何回退：NULL 就是「这个租户没为该 provider 选图片模型」，
// 调用方据此把它从 flow 的图片 provider 下拉里去掉（spec §3.2）。
export async function getImageModel(
  env: Env,
  tenantId: number,
  provider: "default" | LlmProviderName
): Promise<string | null> {
  if (provider === "default") return getDefaultImageModel(env, tenantId);
  const row = await env.CONTENT_DB.prepare(
    "SELECT image_model FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = ?"
  ).bind(tenantId, provider).first<{ image_model: string | null }>();
  return row?.image_model ?? null;
}
```

`setDefaultModel` 与 `setTenantLlmCredentials` 各加一个**必填**参数 `imageModel: string | null`（必填而非可选：可选会让某个调用点忘记传，从而静默把用户已选的图片模型抹成 NULL），并写进 INSERT 与 `ON CONFLICT DO UPDATE`：

```ts
export async function setDefaultModel(env: Env, tenantId: number, model: string, imageModel: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, image_model, created_at, updated_at)
     VALUES (?, 'default', NULL, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider) DO UPDATE SET
       model = excluded.model,
       image_model = excluded.image_model,
       updated_at = excluded.updated_at`
  ).bind(tenantId, model, imageModel, now, now).run();
}
```

`setTenantLlmCredentials` 同样加 `image_model` 到列清单、VALUES 与 DO UPDATE。

`listConfiguredProviders` 的 SELECT 加 `image_model`，映射时加 `imageModel: r.image_model`，返回类型改为 `{ provider: string; model: string; imageModel: string | null; createdAt: string }[]`。

- [ ] **Step 9: 跑全套 content 测试**

Run: `cd content && npx vitest run`
Expected: PASS。（结尾出现 "close timed out after 10000ms" / "something prevents Vite server from exiting" 是本仓库已知噪音，绿色汇总之后出现即可忽略。）

- [ ] **Step 10: 提交**

```bash
git add content/migrations/0007_image_model.sql content/src/services/llm-credentials.ts content/src/services/model-catalog.ts content/tests/llm-credentials.test.ts content/tests/model-catalog.test.ts
git commit -m "feat(content): store a per-provider image model and discover image models dynamically"
```

---

### Task 2: content — generate-image 用租户配置的模型，去掉 skillId

**Files:**
- Modify: `content/src/services/generate-image.ts`
- Modify: `content/src/routes-internal.ts:35-56`
- Test: `content/tests/generate-image.test.ts`, `content/tests/routes-internal.test.ts:146-200`

**Interfaces:**
- Consumes: Task 1 的 `getImageModel(env, tenantId, provider)`
- Produces:
  - `GenerateImageParams = { tenantId: number; prompt: string; provider: "default" | "openai" }`（**不再有 `skillId`**）
  - `POST /internal/generate-image` 请求体 `{ tenantId, prompt, provider }`；配置缺失返回 **400**，其余失败返回 502

- [ ] **Step 1: 写失败测试**

`content/tests/generate-image.test.ts` 中，把所有传 `skillId` 的用例删掉（技能拼进出图 prompt 的行为整体取消），并追加：

```ts
import * as credentialsModule from "../src/services/llm-credentials";

it("generates with the tenant's configured Workers AI image model", async () => {
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/bytedance/stable-diffusion-xl-lightning");
  const aiRun = vi.fn().mockResolvedValue({ image: btoa("png-bytes") });

  await generateImage({ AI: { run: aiRun } } as never, { tenantId: 1, prompt: "a lizard", provider: "default" });

  expect(aiRun).toHaveBeenCalledWith("@cf/bytedance/stable-diffusion-xl-lightning", { prompt: "a lizard", steps: 4 });
});

// 没有回退：BYOK provider 没配图片模型时必须报错，绝不悄悄换成免费的 Workers AI 模型出图。
it("throws instead of falling back when the provider has no image model configured", async () => {
  vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue(null);
  await expect(
    generateImage({} as never, { tenantId: 1, prompt: "a lizard", provider: "openai" })
  ).rejects.toThrow(/No image model configured/);
});
```

`content/tests/routes-internal.test.ts` 的 `/internal/generate-image` 段落追加：

```ts
it("returns 400 (not 502) when the tenant has no image model for the provider", async () => {
  vi.spyOn(generateImageModule, "generateImage").mockRejectedValue(new Error("No image model configured for provider openai"));
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
      method: "POST",
      headers: { "X-Internal-Secret": "test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: 1, prompt: "a lizard", provider: "openai" }),
    }),
    env
  );
  expect(res.status).toBe(400);
});
```

（该文件顶部按现有写法 import `* as generateImageModule from "../src/services/generate-image"`；若已有 mock 方式不同，沿用现有写法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/generate-image.test.ts tests/routes-internal.test.ts`
Expected: FAIL —— 仍在用常量模型 / 400 分支不存在。

- [ ] **Step 3: 实现**

`content/src/services/generate-image.ts` 整体改写为：

```ts
import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

export interface GenerateImageParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai";
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  // 模型只来自租户配置（Default 的常量是初始值，不是兜底）。拿不到就报错——把 OpenAI
  // 的出图请求悄悄换到免费模型上，用户看不出来，账单和画风却都对不上。
  const model = await credentialsModule.getImageModel(env, params.tenantId, params.provider);
  if (!model) {
    throw new Error(`No image model configured for provider ${params.provider}`);
  }

  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(params.prompt, model);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }

  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(params.prompt, model);
}
```

（技能拼接与 `getSkillContent` 的 import 一并删除。）

`content/src/routes-internal.ts` 的 `/generate-image`：请求体解构去掉 `skillId`，调用去掉 `skillId`，catch 里加配置类错误的 400 分支：

```ts
    } catch (err) {
      const message = String(err);
      // 配置问题（没选图片模型 / 没有 key）是 400：调用方据此知道这是用户配置错、
      // 不是模型抽风，不值得重试。
      if (message.includes("No image model configured") || message.includes("credentials configured")) {
        return c.json({ error: message }, 400);
      }
      console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: message }));
      return c.json({ error: "Image generation failed" }, 502);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add content/src/services/generate-image.ts content/src/routes-internal.ts content/tests/generate-image.test.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): resolve the image model from tenant config, drop the image skill"
```

---

### Task 3: content — HTTP 接口（kind 参数、imageModel、image-providers）

**Files:**
- Modify: `content/src/index.ts:91-156`
- Test: `content/tests/routes-api-models.test.ts`, `content/tests/routes-api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getImageModel` / `getDefaultImageModel` / `listConfiguredProviders`（含 `imageModel`）/ `listWorkersAiImageModels` / `listOpenAiImageModels` / `listAnthropicImageModels` / `OPENAI_STATIC_IMAGE_MODELS` / `ANTHROPIC_STATIC_IMAGE_MODELS`
- Produces:
  - `POST /api/llm-models` 接受 `{ provider, apiKey?, kind?: "text" | "image" }`，`kind` 缺省为 `"text"`
  - `GET /api/llm-credentials` → `{ providers: { provider, model, imageModel, createdAt }[], defaultModel, defaultImageModel }`
  - `PUT /api/llm-credentials` 接受 `{ provider, apiKey?, model, imageModel?: string | null }`
  - `GET /api/image-providers` → `{ providers: { provider: string; model: string }[] }`

- [ ] **Step 1: 写失败测试**

`content/tests/routes-api-models.test.ts` 追加：

```ts
it("lists image models for the default provider when kind is image", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: [{ name: "@cf/black-forest-labs/flux-1-schnell", task: { name: "Text-to-Image" } }] }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/llm-models", {
      method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "default", kind: "image" }),
    }),
    env
  );
  expect(res.status).toBe(200);
  expect((await res.json() as { models: string[] }).models).toEqual(["@cf/black-forest-labs/flux-1-schnell"]);
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("task=Text-to-Image");
});

// 「Anthropic 没有图片模型」在这里的表现形式：空数组，而不是一条特判。
it("returns an empty image model list for anthropic", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }), { status: 200 })
  ));
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/llm-models", {
      method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x", kind: "image" }),
    }),
    env
  );
  expect((await res.json() as { models: string[] }).models).toEqual([]);
});
```

新建 `content/tests/routes-api-image-providers.test.ts`：

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import { setDefaultModel, setTenantLlmCredentials } from "../src/services/llm-credentials";

beforeAll(async () => {
  await seedSession(env as never, "img", 91);
});

async function get() {
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/image-providers", { headers: { Cookie: "session=img" } }),
    env
  );
  return { status: res.status, body: await res.json() as { providers: { provider: string; model: string }[] } };
}

describe("GET /api/image-providers", () => {
  it("always offers default, even for a tenant that never opened the settings page", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.providers).toEqual([{ provider: "default", model: "@cf/black-forest-labs/flux-1-schnell" }]);
  });

  it("omits a BYOK provider that has a key but no image model", async () => {
    await setTenantLlmCredentials(env as never, 91, "openai", "sk-test", "gpt-4.1", null);
    expect((await get()).body.providers.map((p) => p.provider)).toEqual(["default"]);
  });

  it("includes a BYOK provider once an image model is chosen", async () => {
    await setTenantLlmCredentials(env as never, 91, "openai", "sk-test", "gpt-4.1", "gpt-image-1");
    expect((await get()).body.providers).toEqual([
      { provider: "default", model: "@cf/black-forest-labs/flux-1-schnell" },
      { provider: "openai", model: "gpt-image-1" },
    ]);
  });

  it("reflects a changed default image model", async () => {
    await setDefaultModel(env as never, 91, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/bytedance/stable-diffusion-xl-lightning");
    expect((await get()).body.providers[0]).toEqual({ provider: "default", model: "@cf/bytedance/stable-diffusion-xl-lightning" });
  });
});
```

`content/tests/routes-api.test.ts` 的 llm-credentials 段落追加：

```ts
it("round-trips imageModel through PUT and GET", async () => {
  await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
      method: "PUT", headers: { Cookie: "session=ok", "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", apiKey: "sk-x", model: "gpt-4.1", imageModel: "gpt-image-1" }),
    }),
    env
  );
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
    env
  );
  const body = await res.json() as { providers: { provider: string; imageModel: string | null }[]; defaultImageModel: string };
  expect(body.providers.find((p) => p.provider === "openai")?.imageModel).toBe("gpt-image-1");
  expect(body.defaultImageModel).toBe("@cf/black-forest-labs/flux-1-schnell");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/routes-api-models.test.ts tests/routes-api-image-providers.test.ts tests/routes-api.test.ts`
Expected: FAIL —— `/api/image-providers` 404、`kind` 被忽略、`imageModel` 丢失。

- [ ] **Step 3: 实现 /api/llm-models 的 kind**

`content/src/index.ts` 的 `app.post("/api/llm-models", ...)` 改为：

```ts
app.post("/api/llm-models", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, kind } = await c.req.json<{
    provider: "openai" | "anthropic" | "default";
    apiKey?: string;
    kind?: "text" | "image";
  }>();
  const wantsImage = kind === "image";

  if (provider === "default") {
    try {
      const models = wantsImage ? await listWorkersAiImageModels(c.env) : await listWorkersAiModels(c.env);
      return c.json({ models, source: "live" });
    } catch (err) {
      console.error(JSON.stringify({ event: "llm_models_list_failed", tenantId, provider, kind: kind ?? "text", error: String(err) }));
      return c.json({ error: "Could not fetch model list" }, 502);
    }
  }

  // BYOK providers: listing their actual models requires a valid key, so without one (or
  // if the live call fails) fall back to the curated static catalog rather than erroring --
  // the model dropdown should always be usable, key or no key.
  const staticModels = wantsImage
    ? (provider === "openai" ? OPENAI_STATIC_IMAGE_MODELS : ANTHROPIC_STATIC_IMAGE_MODELS)
    : (provider === "openai" ? OPENAI_STATIC_MODELS : ANTHROPIC_STATIC_MODELS);
  if (!apiKey) return c.json({ models: staticModels, source: "static" });

  try {
    const models = wantsImage
      ? (provider === "openai" ? await listOpenAiImageModels(apiKey) : await listAnthropicImageModels(apiKey))
      : (provider === "openai" ? await listOpenAiModels(apiKey) : await listAnthropicModels(apiKey));
    return c.json({ models, source: "live" });
  } catch (err) {
    console.error(JSON.stringify({ event: "llm_models_live_fetch_failed", tenantId, provider, kind: kind ?? "text", error: String(err) }));
    return c.json({ models: staticModels, source: "static" });
  }
});
```

（顶部 import 补上四个新符号。）

- [ ] **Step 4: 实现 credentials 的 imageModel 与 /api/image-providers**

`GET /api/llm-credentials`：

```ts
app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers = await listConfiguredProviders(c.env, tenantId);
  const defaultModel = await getDefaultModel(c.env, tenantId);
  const defaultImageModel = await getDefaultImageModel(c.env, tenantId);
  return c.json({ providers, defaultModel, defaultImageModel });
});
```

`PUT /api/llm-credentials`：

```ts
app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model, imageModel } = await c.req.json<{
    provider: "openai" | "anthropic" | "default"; apiKey?: string; model: string; imageModel?: string | null;
  }>();
  if (!provider || !model) return c.json({ error: "provider, model required" }, 400);
  if (provider === "default") {
    await setDefaultModel(c.env, tenantId, model, imageModel ?? null);
    return c.json({ ok: true });
  }
  if (!apiKey) return c.json({ error: "apiKey required for this provider" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model, imageModel ?? null);
  return c.json({ ok: true });
});
```

在 `app.use("/api/llm-models", sessionAuth)` 之后新增：

```ts
app.use("/api/image-providers", sessionAuth);

// flow 的图片 provider 下拉的唯一数据源。规则：default 恒在（其图片模型是初始配置值，
// 不是兜底）；BYOK provider 当且仅当同时有 key 与非空 image_model 时列出——没配图片
// 模型的 provider 在 flow 里就是选不到，而不是选了之后运行时才失败。
app.get("/api/image-providers", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers: { provider: string; model: string }[] = [
    { provider: "default", model: await getDefaultImageModel(c.env, tenantId) },
  ];
  for (const row of await listConfiguredProviders(c.env, tenantId)) {
    if (row.imageModel) providers.push({ provider: row.provider, model: row.imageModel });
  }
  return c.json({ providers });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd content && npx vitest run`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add content/src/index.ts content/tests/routes-api-models.test.ts content/tests/routes-api-image-providers.test.ts content/tests/routes-api.test.ts
git commit -m "feat(content): expose image models and the tenant's usable image providers over HTTP"
```

---

### Task 4: content — 设置页的 Image model 选择器

**Files:**
- Modify: `content/frontend/lib/api.ts`
- Modify: `content/frontend/pages/SettingsPage.tsx`
- Test: `content/tests/settings-image-model.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 的 `/api/llm-models`（`kind`）、`/api/llm-credentials`（`imageModel` / `defaultImageModel`）
- Produces: 无（页面是叶子）

- [ ] **Step 1: 写失败测试**

新建 `content/tests/settings-image-model.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";
import apiSource from "../frontend/lib/api.ts?raw";

// 这个页面用 hook，workerd 里没有 document、仓库也没装 @testing-library/react
// （见 flow/tests/unit/channel-node-panel-order.test.tsx 的说明），所以这里只守接线约定：
// 真正的判定逻辑（哪些 provider 有图片模型）活在 content 的 /api/image-providers，
// 已由 routes-api-image-providers.test.ts 真跑。
describe("AI Content Settings 的图片模型接线", () => {
  it("api client 会带 kind 请求模型列表，并把 imageModel 一起存下", () => {
    expect(apiSource).toContain('kind?: "text" | "image"');
    expect(apiSource).toContain("imageModel");
  });

  it("Image model 选择器有双语标签", () => {
    expect(settingsSource).toContain('{ en: "Image model", zh: "图片模型" }');
  });

  // 列表为空时整块不渲染 —— Anthropic 卡上因此不会出现一个永远选不出东西的空下拉框，
  // 也不需要任何 "该 provider 没有图片模型" 的说明文案（spec §2.3）。
  it("图片模型列表为空时不渲染选择器，且没有写死 provider 名的说明文案", () => {
    expect(settingsSource).toContain("imageModels.length > 0 && (");
    expect(settingsSource).not.toContain("Anthropic has no image");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd content && npx vitest run tests/settings-image-model.test.ts`
Expected: FAIL —— 三条断言都找不到对应字符串。

- [ ] **Step 3: 改 api client**

`content/frontend/lib/api.ts`：

```ts
export interface ProviderCredentialInfo {
  // BYOK-only, matches listConfiguredProviders' contract (see this plan's Global
  // Constraints) -- "default" never appears in the `providers` array, it's carried
  // separately in `defaultModel` below.
  provider: "openai" | "anthropic";
  model: string;
  imageModel: string | null;
  createdAt: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[]; defaultModel: string; defaultImageModel: string }> =>
      request("/api/llm-credentials"),
    save: (provider: ProviderName, model: string, apiKey?: string, imageModel?: string | null): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model, imageModel }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
  llmModels: {
    list: (provider: ProviderName, apiKey?: string, kind?: "text" | "image"): Promise<{ models: string[]; source: "static" | "live" }> =>
      request("/api/llm-models", { method: "POST", body: JSON.stringify({ provider, apiKey, kind }) }),
  },
};
```

- [ ] **Step 4: 改设置页**

`content/frontend/pages/SettingsPage.tsx`：

1. `ModelPicker` 加一个 `kind: "text" | "image"` prop，透传给 `api.llmModels.list(provider, apiKey || undefined, kind)`，并进 `useEffect` 依赖数组。
2. `ProviderForm` 加 `initialImageModel?: string | null` prop，内部 `const [imageModel, setImageModel] = useState(initialImageModel || "")`，并新增一个受列表非空控制的图片模型块：

```tsx
      <ImageModelField provider={provider} apiKey={apiKey} model={imageModel} onChange={setImageModel} />
```

3. 新增 `ImageModelField` 组件——它自己拉一次图片模型列表，空则整块不渲染（这正是"Anthropic 卡上没有图片模型选择器"的全部实现，代码里没有任何 provider 名字的特判）：

```tsx
function ImageModelField({
  provider, apiKey, model, onChange,
}: { provider: ProviderName; apiKey: string; model: string; onChange: (m: string) => void }) {
  const T = useT();
  const [imageModels, setImageModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.llmModels.list(provider, apiKey || undefined, "image")
      .then((res) => {
        if (cancelled) return;
        setImageModels(res.models);
        // 列表刚拿到、用户还没选过时预选首项：BYOK provider 的 image_model 为 NULL 意味着
        // 「flow 里选不到这个 provider 出图」，不该因为用户没注意到这个新选择器而发生。
        if (res.models.length > 0 && !model) onChange(res.models[0]);
      })
      .catch(() => { if (!cancelled) setImageModels([]); });
    return () => { cancelled = true; };
  }, [provider, apiKey]);

  return imageModels.length > 0 && (
    <div>
      <Label className="text-xs block mb-1">{T({ en: "Image model", zh: "图片模型" })}</Label>
      <Select value={model} onChange={(e: any) => onChange(e.target.value)} className="w-full text-sm">
        {!imageModels.includes(model) && model && <option value={model}>{model}</option>}
        {imageModels.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
    </div>
  );
}
```

4. `handleSave` 改为 `await api.llmCredentials.save(provider, model, requiresApiKey ? apiKey : undefined, imageModel || null)`。
5. `SettingsPage` 的 `reload` 存下 `defaultImageModel`；渲染 `ProviderForm` 时传
   `initialImageModel={provider === "default" ? defaultImageModel : configured?.imageModel}`。
6. 卡片 `tagline` 在有图片模型时追加一行，例如
   `` `${modelLabel}: ${currentModel} · ${T({ en: "Image", zh: "图片" })}: ${currentImageModel}` ``；无图片模型时保持原样。

- [ ] **Step 5: 跑测试与类型检查**

Run: `cd content && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS，无类型错误。

- [ ] **Step 6: 提交**

```bash
git add content/frontend/lib/api.ts content/frontend/pages/SettingsPage.tsx content/tests/settings-image-model.test.ts
git commit -m "feat(content): pick an image model per provider on the AI Content Settings page"
```

---

### Task 5: metadata + link — X create-post 挂图

**Files:**
- Modify: `metadata/x-byok.ts:120-131`
- Modify: `link/src/services/x-posts-api.ts:189-200`
- Modify: `link/src/routes-internal.ts`（`uploadVideoToX` 附近加 `uploadImageToX`；`/content/create-post` 处理器）
- Test: `link/tests/services/routes-internal-content.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `POST /internal/generate-image { tenantId, prompt, provider }`
- Produces:
  - `initMediaUpload(accessToken, totalBytes, mediaType, mediaCategory: "tweet_video" | "tweet_image")`
  - `POST /internal/content/create-post` 请求体新增可选 `imagePrompt?: string` 与 `imageProvider?: "default" | "openai"`
  - `metadata/x-byok.ts` create-post 的 `contentProps` 含 `{ propId: "message_image", aiType: "IMAGE" }`

- [ ] **Step 1: 写失败测试**

`link/tests/services/routes-internal-content.test.ts` 追加（沿用该文件既有的 fetch mock 写法）：

```ts
it("generates an image, uploads it as tweet_image and attaches it to the post", async () => {
  // …按本文件既有写法 mock：/internal/generate（文本）、/internal/generate-image（返回 { url }）、
  // 图片 URL 的 GET（返回带 Content-Type: image/jpeg、Content-Length 的 Response）、
  // X 的 initialize / append / finalize、以及 POST /2/tweets
  const res = await worker.fetch(makeRequest({
    contentId: "c1", channelId: "chan-1", interpolatedPrompt: "hi", provider: "default", skillId: "none",
    imagePrompt: "abstract tech illustration", imageProvider: "default",
  }), env);

  expect(await res.json()).toEqual({ ok: true });
  const initBody = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes("/2/media/upload/initialize"))![1].body);
  expect(initBody.media_category).toBe("tweet_image");
  const tweetBody = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/2/tweets"))![1].body);
  expect(tweetBody.media.media_ids).toHaveLength(1);
});

// 配图是锦上添花，内容流不该因为一张图断掉（spec §4.3）。
it("still posts text when image generation fails", async () => {
  // mock /internal/generate-image 返回 400
  const res = await worker.fetch(makeRequest({
    contentId: "c1", channelId: "chan-1", interpolatedPrompt: "hi", provider: "default", skillId: "none",
    imagePrompt: "abstract tech illustration", imageProvider: "default",
  }), env);

  expect(await res.json()).toEqual({ ok: true });
  const tweetBody = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/2/tweets"))![1].body);
  expect(tweetBody.media).toBeUndefined();
  expect(tweetBody.text).toBeTruthy();
});

// 正常路径已被发布校验挡住，这里守后端的防御性行为，免得畸形图跑出两个 media_id。
it("prefers the video and skips image generation when both are supplied", async () => {
  const res = await worker.fetch(makeRequest({
    contentId: "c1", channelId: "chan-1", interpolatedPrompt: "hi", provider: "default", skillId: "none",
    videoUrl: "https://media.example/v.mp4", imagePrompt: "an image", imageProvider: "default",
  }), env);

  expect(res.status).toBe(200);
  expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/internal/generate-image"))).toBe(false);
});
```

同时在 `flow/tests/unit/node-type-registry.test.ts` 里把 create-post 的 contentProps 断言更新为三项（`message_text` / `message_image` / `message_video`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: FAIL —— 没有 `/internal/generate-image` 调用、`media_category` 仍是 `tweet_video`。

- [ ] **Step 3: 改 metadata**

`metadata/x-byok.ts` 的 create-post：

```ts
    contentProps: [
      {propId: "message_text", aiType:"TEXT"},
      {propId: "message_image", aiType:"IMAGE"},
      {propId: "message_video", aiType:"VIDEO"},
    ],
```

`price: 0.010` 不动。

- [ ] **Step 4: 给 initMediaUpload 加 mediaCategory 参数**

`link/src/services/x-posts-api.ts`：

```ts
export async function initMediaUpload(
  accessToken: string,
  totalBytes: number,
  mediaType: string,
  mediaCategory: "tweet_video" | "tweet_image"
): Promise<MediaUploadResult> {
  const res = await fetch("https://api.x.com/2/media/upload/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: mediaType, total_bytes: totalBytes, media_category: mediaCategory }),
  });
  …（其余不变）
}
```

`uploadVideoToX` 里的调用改为 `initMediaUpload(accessToken, contentLength, contentType, "tweet_video")`。

- [ ] **Step 5: 加 uploadImageToX**

`link/src/routes-internal.ts`，紧挨 `uploadVideoToX` 之后：

```ts
// X 单图上限 5MB（https://docs.x.com/x-api/media/quickstart/media-upload-chunked）。
// 出图产物是 JPEG、通常几百 KB，所以一次 append 就够——图片也没有 X 侧的异步转码，
// finalize 不返回 processing_info，因此这里不需要视频那套 pending 轮询。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function uploadImageToX(
  accessToken: string,
  imageUrl: string
): Promise<{ ok: true; mediaId: string } | { ok: false }> {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    console.error(JSON.stringify({ event: "x_image_fetch_failed", imageUrl, status: imageRes.status }));
    return { ok: false };
  }
  const bytes = new Uint8Array(await imageRes.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    console.error(JSON.stringify({ event: "x_image_size_rejected", imageUrl, byteLength: bytes.length }));
    return { ok: false };
  }

  const contentType = imageRes.headers.get("Content-Type") || "image/jpeg";
  const init = await initMediaUpload(accessToken, bytes.length, contentType, "tweet_image");
  if (!init.ok || !init.mediaId) return { ok: false };

  const appended = await appendMediaChunk(accessToken, init.mediaId, 0, bytes);
  if (!appended.ok) return { ok: false };

  const finalized = await finalizeMediaUpload(accessToken, init.mediaId);
  if (!finalized.ok || finalized.state !== "succeeded") {
    console.error(JSON.stringify({ event: "x_image_finalize_failed", mediaId: init.mediaId, state: finalized.state }));
    return { ok: false };
  }
  return { ok: true, mediaId: init.mediaId };
}
```

- [ ] **Step 6: 接进 /content/create-post**

请求体解构加 `imagePrompt` 与 `imageProvider`（都可选）。在**已有的 videoUrl 分支之后、`createPost(...)` 之前**插入：

```ts
    // videoUrl 优先：X 一条推文只能挂一种媒体。正常路径下两者同时出现已被发布校验挡住
    // （validate-flow-graph.ts），这里是后端防御——顺带省下一次注定用不上的出图推理。
    if (!mediaId && imagePrompt) {
      const imageMediaId = await generateAndUploadImage(
        c.env, channel.tenant_id, imagePrompt, imageProvider || "default", accessToken, contentId, channelId
      );
      if (imageMediaId) mediaId = imageMediaId;
    }
```

并在文件里加这个辅助函数（把"失败就当没图"的策略集中在一处）：

```ts
// 出图失败一律降级成纯文本推：配图是锦上添花，内容流不该因为一张图断掉（spec §4.3）。
// 失败原因只进日志，不进 reason —— reason 会写进 content_flow_log 这张分析表，
// 外部错误体长度不可控（与 YouTube 那几个出口同一条约定）。
async function generateAndUploadImage(
  env: Env, tenantId: number, prompt: string, provider: string,
  accessToken: string, contentId: string, channelId: string
): Promise<string | null> {
  const genRes = await fetch(`${env.CONTENT_URL}/internal/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
    body: JSON.stringify({ tenantId, prompt, provider }),
  });
  if (!genRes.ok) {
    console.error(JSON.stringify({
      event: "create_post_image_failed", contentId, channelId, provider,
      stage: "generate", status: genRes.status, body: await genRes.text().catch(() => ""),
    }));
    return null;
  }
  const { url } = await genRes.json<{ url: string }>();

  const upload = await uploadImageToX(accessToken, url);
  if (!upload.ok) {
    console.error(JSON.stringify({ event: "create_post_image_failed", contentId, channelId, provider, stage: "upload" }));
    return null;
  }
  console.log(JSON.stringify({ event: "create_post_image_attached", contentId, channelId, provider, mediaId: upload.mediaId }));
  return upload.mediaId;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd link && npx vitest run && cd ../flow && npx vitest run tests/unit/node-type-registry.test.ts`
Expected: PASS。（link 有两条既存的 unhandled-rejection 警告，来自 `poll-channel-youtube.test.ts` 与 `cron-polling.test.ts`，与本任务无关。）

- [ ] **Step 8: 提交**

```bash
git add metadata/x-byok.ts link/src/services/x-posts-api.ts link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts flow/tests/unit/node-type-registry.test.ts
git commit -m "feat(link): attach an AI-generated image to X create-post, degrading to text on failure"
```

---

### Task 6: link — TikTok photo-post 去掉 image skill

**Files:**
- Modify: `link/src/routes-internal.ts:1009-1080`
- Test: `link/tests/services/routes-internal-tiktok-photo-post.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `/internal/generate-image`（已无 `skillId`）
- Produces: `/internal/tiktok/photo-post` 请求体**不再接受** `imageSkillId`

- [ ] **Step 1: 改测试**

`link/tests/services/routes-internal-tiktok-photo-post.test.ts` 中：请求体去掉 `imageSkillId`，并加一条：

```ts
// 把 60KB 的技能文档拼在出图 prompt 后面只会把图带偏（spec §2.2）。存档 flow 里
// 残留的 imageSkillId 被忽略，不做数据迁移——所以这里连"传了也不转发"都要守住。
it("never forwards a skill to the image generator, even if an old graph still sends one", async () => {
  await worker.fetch(makeRequest({ …, imageSkillId: "marketingskills-social" }), env);
  const imageCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/internal/generate-image"))!;
  expect(JSON.parse(imageCall[1].body)).not.toHaveProperty("skillId");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: FAIL —— 请求体里仍有 `skillId`。

- [ ] **Step 3: 实现**

`/tiktok/photo-post` 的解构去掉 `imageSkillId`，其类型注解一并删除；出图调用改为
`body: JSON.stringify({ tenantId, prompt: prompts.message_image, provider: imageProvider })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd link && npx vitest run`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-tiktok-photo-post.test.ts
git commit -m "refactor(link): drop the image skill from TikTok photo-post"
```

---

### Task 7: flow 后端 — 透传、插值与代理

**Files:**
- Modify: `flow/src/node-executors.ts:85-93`
- Modify: `flow/src/index.ts:676-730`（xContentAction 分支）与 `:1258-1277`（代理段）
- Test: `flow/tests/unit/node-executors.test.ts`, `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `/internal/content/create-post` 的 `imagePrompt` / `imageProvider`；Task 3 的 `/api/image-providers`
- Produces:
  - action 对象新增 `attachImage: boolean`、`imageProvider: string`、`imagePrompt: string`
  - `GET /api/image-providers`（flow 侧代理，转发 session cookie）

- [ ] **Step 1: 写失败测试**

`flow/tests/unit/node-executors.test.ts` 追加：

```ts
it("carries the X image attachment fields through to the action", () => {
  const action = buildAction({
    id: "a1", type: "action",
    data: { actionType: "xContentAction", operation: "create-post", prompt: "p", provider: "default",
            attachImage: true, imageProvider: "openai", imagePrompt: "an abstract illustration" },
  } as never);
  expect(action).toEqual(expect.objectContaining({
    attachImage: true, imageProvider: "openai", imagePrompt: "an abstract illustration",
  }));
});
```

（`buildAction` 用该文件既有的构造方式。）

`flow/tests/unit/queue-content.test.ts` 追加：

```ts
it("interpolates $content.* in the image prompt and forwards it to link", async () => {
  // …按本文件既有写法搭一个含 xContentAction 的 flow，节点 data 为
  // { actionType: "xContentAction", channelId: "x-chan-1", prompt: "T: $content.title",
  //   provider: "default", attachImage: true, imageProvider: "default",
  //   imagePrompt: "Abstract art about: $content.title" }
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/internal/content/create-post"))!;
  const body = JSON.parse(call[1].body);
  expect(body.imagePrompt).toBe("Abstract art about: Original Title");
  expect(body.imageProvider).toBe("default");
});

// 没勾图片就不该给 link 任何图片字段，否则 link 会照着一段空 prompt 去出图。
it("omits the image fields when attachImage is off", async () => {
  // …同上，但节点 data 不含 attachImage
  const body = JSON.parse(fetchMock.mock.calls.find((c) => String(c[0]).includes("/internal/content/create-post"))![1].body);
  expect(body.imagePrompt).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/node-executors.test.ts tests/unit/queue-content.test.ts`
Expected: FAIL。

- [ ] **Step 3: 改 node-executors**

`flow/src/node-executors.ts` 的 `xContentAction`：

```ts
  xContentAction: (node, a) => {
    a.operation = (node.data.operation as string) || "create-post";
    // The X account that acts. Absent on nodes built before the picker existed — the executor
    // then falls back to the triggering channel, which is only correct for X-triggered flows.
    a.channelId = node.data.channelId as string;
    a.prompt = node.data.prompt as string;
    a.provider = node.data.provider as string;
    a.skillId = (node.data.skillId as string) || "none";
    a.attachVideo = !!node.data.attachVideo;
    a.attachImage = !!node.data.attachImage;
    a.imageProvider = (node.data.imageProvider as string) || "default";
    a.imagePrompt = (node.data.imagePrompt as string) || "";
  },
```

- [ ] **Step 4: 改 flow/src/index.ts 的转发**

在 `const interpolatedPrompt = …` 之后加：

```ts
        // 一段式：用户写的图片 prompt 插值后直接送扩散模型，不经文本模型改写。
        const imagePrompt = action.attachImage
          ? String(action.imagePrompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""))
          : "";
```

非视频分支的 fetch body 改为：

```ts
          body: JSON.stringify({
            contentId, interpolatedPrompt, provider, channelId: xChannelId, flowId: flowId || null, skillId,
            ...(imagePrompt ? { imagePrompt, imageProvider: action.imageProvider || "default" } : {}),
          }),
```

`logExtra` 加 `attachImage: !!imagePrompt`。视频分支不动（视频优先，且发布校验已挡住同时勾选）。

- [ ] **Step 5: 加代理路由**

`flow/src/index.ts`，紧挨 `/api/llm-providers` 代理之后：

```ts
// Proxy the tenant's usable image providers from content worker (for the image provider
// dropdowns). Deliberately a separate endpoint from /api/llm-providers: that one lists
// text-capable BYOK providers, this one lists providers that actually have an image model.
app.get("/api/image-providers", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/image-providers`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd flow && npx vitest run`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add flow/src/node-executors.ts flow/src/index.ts flow/tests/unit/node-executors.test.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat(flow): forward the X image attachment to link and proxy image providers"
```

---

### Task 8: flow 前端 — 节点 UI、发布校验、错误文案

**Files:**
- Modify: `flow/frontend/lib/api.ts:150-160`
- Modify: `flow/frontend/components/Inspector.tsx`（`XContentActionInspector` 约 1096-1225 行、`TikTokContentActionInspector` 约 1435-1490 行）
- Modify: `flow/frontend/lib/validate-flow-graph.ts:104-152`
- Modify: `flow/frontend/pages/EditorPage.tsx:112-146`
- Test: `flow/tests/unit/x-image-attachment.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 的 `GET /api/image-providers`；Task 5 的 `message_image` prop
- Produces:
  - `api.imageProviders.list(): Promise<{ providers: { provider: string; model: string }[] }>`
  - `findXImageVideoConflictIds(nodes): string[]`
  - `validateFlowGraph` 返回值新增 `xMediaConflictNodeIds: string[]`

- [ ] **Step 1: 写失败测试**

新建 `flow/tests/unit/x-image-attachment.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { findXImageVideoConflictIds, validateFlowGraph } from "../../frontend/lib/validate-flow-graph";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";
import editorSource from "../../frontend/pages/EditorPage.tsx?raw";

describe("X 图片/视频互斥的发布校验", () => {
  const node = (data: Record<string, unknown>) => ({ id: "n1", type: "xContentAction", data });

  it("同时勾了图片与视频的 create-post 节点被拦下", () => {
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachImage: true, attachVideo: true })])).toEqual(["n1"]);
  });

  it("只勾一个、或一个都不勾，都放行", () => {
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachImage: true })])).toEqual([]);
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachVideo: true })])).toEqual([]);
    expect(findXImageVideoConflictIds([node({ operation: "create-post" })])).toEqual([]);
  });

  // 别的 operation（bookmark / like / repost）根本没有媒体字段，畸形图里残留的
  // attachImage 不该把一个本来合法的节点拦在发布之外。
  it("不管非 create-post 的操作", () => {
    expect(findXImageVideoConflictIds([node({ operation: "like-post", attachImage: true, attachVideo: true })])).toEqual([]);
  });

  it("冲突会让整张图 invalid，并出现在返回值里", () => {
    const result = validateFlowGraph(
      [{ id: "t1", type: "xContentTrigger", data: {} },
       { id: "n1", type: "xContentAction", data: { operation: "create-post", attachImage: true, attachVideo: true } }],
      [{ source: "t1", target: "n1" }]
    );
    expect(result.valid).toBe(false);
    expect(result.xMediaConflictNodeIds).toEqual(["n1"]);
  });
});

describe("X 图片块的接线", () => {
  it("图片勾选框排在视频勾选框之前，两者都有双语文案", () => {
    const imageIdx = inspectorSource.indexOf("Attach AI-generated image");
    const videoIdx = inspectorSource.indexOf("Attach video (uses this flow's processed video, if any)");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(imageIdx).toBeLessThan(videoIdx);
    expect(inspectorSource).toContain("附加 AI 生成的图片");
  });

  it("两个图片 provider 下拉都来自 /api/image-providers，没有写死 gpt-image-1", () => {
    // 写死模型名意味着设置页选的图片模型不生效——这正是本次要消灭的东西。
    expect(inspectorSource).toContain("api.imageProviders.list()");
    expect(inspectorSource).not.toContain("gpt-image-1");
  });

  it("TikTok 的 Image Skill 下拉已经拿掉", () => {
    expect(inspectorSource).not.toContain('{ en: "Image Skill", zh: "图片技能" }');
    expect(inspectorSource).not.toContain("imageSkillId");
  });

  it("发布失败的提示为媒体冲突单列一条文案", () => {
    expect(editorSource).toContain("xMediaConflictNodeIds");
    expect(editorSource).toContain("can only attach either an image or a video");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/x-image-attachment.test.ts`
Expected: FAIL —— `findXImageVideoConflictIds` 不存在。

- [ ] **Step 3: 加发布校验**

`flow/frontend/lib/validate-flow-graph.ts`，在 `findGitHubTriggerNoRepoIds` 之后：

```ts
// X 一条推文只能挂一种媒体（https://docs.x.com/x-api/posts/create-post）。两个勾选框
// 同时勾中在画布上完全看不出异常，运行时则是后端悄悄以视频为准、用户配的图片凭空消失——
// 与产品坏了无法区分，所以挡在上线之前。只管 create-post：别的操作没有媒体字段，
// 畸形图里残留的 attachImage 不该把一个本来合法的节点拦下。
export function findXImageVideoConflictIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "xContentAction")
    .filter((n) => ((n.data?.operation as string) || "create-post") === "create-post")
    .filter((n) => !!n.data?.attachImage && !!n.data?.attachVideo)
    .map((n) => n.id);
}
```

`validateFlowGraph` 的返回类型加 `xMediaConflictNodeIds: string[]`，计算 `const xMediaConflictNodeIds = findXImageVideoConflictIds(nodes);`，`valid` 的与式里加 `xMediaConflictNodeIds.length === 0`，返回对象里带上它。

- [ ] **Step 4: 接进 EditorPage**

`flow/frontend/pages/EditorPage.tsx`：解构加 `xMediaConflictNodeIds`；`setErrorNodeIds` 的数组里加进去；`title` 的三元链在 `githubNoRepoNodeIds` 之后加一档：

```tsx
                        : xMediaConflictNodeIds.length > 0
                          ? T({
                              en: `${xMediaConflictNodeIds.length} X Content Action(s) can only attach either an image or a video, not both, cannot publish`,
                              zh: `${xMediaConflictNodeIds.length} 个 X Content Action 只能附加图片或视频之一，不能同时勾选，无法发布`,
                            })
```

同时把那段"六类错误"的中文注释改成"七类"。

- [ ] **Step 5: 加 api client**

`flow/frontend/lib/api.ts`，在 `llmProviders` 之后：

```ts
  imageProviders: {
    list: (): Promise<{ providers: { provider: string; model: string }[] }> => request("/api/image-providers"),
  },
```

- [ ] **Step 6: 改 XContentActionInspector**

在组件内加状态与拉取（`imageProviders` 只在勾了图片时才需要，但列表要先有才能渲染下拉，所以与 providers 一样在挂载时拉一次）：

```tsx
  const [imageProviders, setImageProviders] = useState<{ provider: string; model: string }[]>([]);

  useEffect(() => {
    api.imageProviders.list().then((res) => setImageProviders(res.providers)).catch(() => setImageProviders([]));
  }, []);

  const imageProp = selectedOperation?.contentProps.find((p) => p.aiType === "IMAGE");
```

在 `{videoProp && (…)}` **之前**插入图片块：

```tsx
      {imageProp && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`${nodeId}-attach-image`}
              checked={!!data.attachImage}
              onChange={(e) => updateNodeData(nodeId, { attachImage: e.target.checked })}
            />
            <Label htmlFor={`${nodeId}-attach-image`} className="text-xs cursor-pointer">
              {T({ en: "Attach AI-generated image", zh: "附加 AI 生成的图片" })}
            </Label>
          </div>
          {data.attachImage && (
            <>
              <div>
                <Label className="text-xs block mb-1">{T({ en: "Image Provider", zh: "图片模型" })}</Label>
                <Select
                  value={data.imageProvider || "default"}
                  onChange={(e: SelectChange) => updateNodeData(nodeId, { imageProvider: e.target.value })}
                  className="w-full text-sm"
                >
                  {imageProviders.map((p) => (
                    // i18n-ok: provider 与模型 id 都是品牌名，不翻译
                    <option key={p.provider} value={p.provider}>
                      {p.provider === "default" ? T({ en: "Default (Cloudflare Workers AI)", zh: "默认（Cloudflare Workers AI）" }) : "OpenAI"} ({p.model})
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label className="text-xs block mb-1">
                  {propLabel(imageProp.propId, locale)} {T({ en: "Prompt", zh: "提示词" })}
                </Label>
                <Textarea
                  value={data.imagePrompt || ""}
                  onChange={(e: TextareaChange) => updateNodeData(nodeId, { imagePrompt: e.target.value })}
                  placeholder={T({ en: "Abstract tech illustration about: $content.title", zh: "抽象科技风插画，主题：$content.title" })}
                  rows={3}
                  className="w-full text-sm font-mono"
                />
              </div>
            </>
          )}
        </>
      )}
```

（`propLabel` 与 `locale` 在本文件已有，沿用 TikTok 那边的用法；若 `XContentActionInspector` 尚未取 `locale`，按同文件写法 `const { locale } = useLocale();` 补上。）

- [ ] **Step 7: 改 TikTokContentActionInspector**

- 删掉整个 `Image Skill` 的 `<div>` 块。
- `Image Provider` 的 `<Select>` 改为由 `imageProviders`（同样来自 `api.imageProviders.list()`）渲染，写法与上面 X 的那段一致，删掉写死的 `OpenAI (gpt-image-1)` 选项。
- `Image Count` 保持不动。

- [ ] **Step 8: 跑测试与类型检查**

Run: `cd flow && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS，无类型错误。

- [ ] **Step 9: 提交**

```bash
git add flow/frontend/lib/api.ts flow/frontend/components/Inspector.tsx flow/frontend/lib/validate-flow-graph.ts flow/frontend/pages/EditorPage.tsx flow/tests/unit/x-image-attachment.test.ts
git commit -m "feat(flow): attach an AI image on X create-post, with an image/video publish gate"
```

---

### Task 9: 时序图与 dev 自测

**Files:**
- Modify: `flow/sequence.md`（`## Content-domain: xContentAction` 一节，约 64-100 行）

**Interfaces:**
- Consumes: Task 1–8 的全部改动
- Produces: 无

- [ ] **Step 1: 更新时序图**

在 `flow/sequence.md` 的 xContentAction 图里，`FW->>LW: POST /internal/content/create-post` 之后补出图两步，并在图下补一句说明（"图片路径不进 pending 轮询：X 对图片没有异步转码；出图或上传失败时降级为纯文本推，节点仍记 success"）：

```
    LW->>CW: POST /internal/generate-image { tenantId, prompt, provider }
    CW-->>LW: { url }  (R2 public media)
    LW->>X: media/upload initialize+append+finalize (media_category=tweet_image)
    X-->>LW: media_id
```

- [ ] **Step 2: 部署 dev**

```bash
cd content && npm run deploy:dev
cd ../link && npm run deploy:dev
cd ../flow && npm run deploy:dev
```

migration 0007 需要对 dev 的 `uniscrm-content-dev` 应用（按仓库既有做法：CI 的 migrate 作业，或本地 `wrangler d1 migrations apply uniscrm-content-dev --env dev --remote`）。

- [ ] **Step 3: 浏览器自测**

复用已登录的 Chrome 会话（`tabs_context_mcp`）：

1. 打开 `https://content-dev.uni-scrm.com/settings`，确认 Default 卡出现 `Image model` 且已预选 `@cf/black-forest-labs/flux-1-schnell`；Anthropic 卡**没有**该选择器。
2. 打开一个 content flow 的编辑器，选中 X Content Action 节点：确认「Attach AI-generated image」在「Attach video」之上；勾上后出现 Image Provider（选项与设置页一致）与 Image Prompt。
3. 两个勾选框都勾上，点 Publish：确认被拦下并给出媒体冲突提示。
4. 只勾图片，填 `Abstract tech illustration about: $content.title`，发布并手动触发一次，确认推文带图（或在失败时确认发出了纯文本推且日志有 `create_post_image_failed`）。

- [ ] **Step 4: 提交**

```bash
git add flow/sequence.md
git commit -m "docs(flow): add the image generation and media upload steps to the xContentAction sequence"
```

---

## Self-Review

**Spec 覆盖：**

| Spec 章节 | 任务 |
|---|---|
| §2.1 节点 UI（两个勾选框、图片在上、独立 provider、一段式） | 8 |
| §2.2 TikTok 收编（去 image skill、provider 统一、imageCount 保留） | 6, 8 |
| §2.3 设置页 Image model（动态、空则不渲染） | 3, 4 |
| §3.1 存储（migration、image_model 列） | 1 |
| §3.2 解析规则（Default 常量为初始值、BYOK 无兜底、保存时预选） | 1, 2, 4 |
| §3.3 `/api/image-providers` | 3（flow 侧代理在 7） |
| §4.1 节点字段 | 7, 8 |
| §4.2 调用链（mediaCategory、tweet_image、不进 pending） | 5 |
| §4.3 失败降级 | 5 |
| §4.4 发布校验 | 8 |
| §5 metadata（message_image、price 不变） | 5 |
| §6 改动清单 | 1–9 |
| §7 测试 | 各任务内 |
| §8 明确不做 | 全程无模板渲染 / 多图 / 两段式 / 数据迁移 |

**类型一致性：** `getImageModel` / `getDefaultImageModel` / `setDefaultModel` / `setTenantLlmCredentials` / `listConfiguredProviders` 的签名在 Task 1 定义，Task 2、3 按同名同参使用；`initMediaUpload` 的第四参在 Task 5 一次性加到定义与两个调用点；`imagePrompt` / `imageProvider` 这对字段名从 Task 5（link 入参）到 Task 7（flow 出参）到 Task 8（节点 data）全程同名；`xMediaConflictNodeIds` 在 Task 8 内定义并消费。

**占位符扫描：** 无 TBD / TODO / "similar to Task N"。Task 5、6、7 的测试里以 `// …按本文件既有写法` 标注的部分，指的是复用该测试文件已有的 mock 与请求构造工具，断言本身已写全。
