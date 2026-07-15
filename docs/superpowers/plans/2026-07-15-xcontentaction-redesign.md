# xContentAction Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the just-shipped `aiRewritePublish` action (skill-catalog-driven) with `xContentAction` — a free-text prompt + explicit provider choice, modeled on `xAction`'s UI pattern — and move tenant BYOK credentials to a multi-provider, card-based model.

**Architecture:** Metadata-driven operation list (mirrors `EventMetadata_X`) → `flow` interpolates `$content.xxx` into the prompt before calling `link` → `link` calls `content`'s simplified `/internal/generate` (`{tenantId, prompt, provider} → {text}`, or skips it entirely for `provider: "none"`) → `link` posts to X. Tenant credentials become one row per `(tenant_id, provider)`, surfaced as provider cards on `content`'s settings page.

**Tech Stack:** Same as the prior plan — Cloudflare Workers (Hono), D1, `@cloudflare/vitest-pool-workers`, React + Zustand + `@xyflow/react`.

**Spec:** `docs/superpowers/specs/2026-07-15-xcontentaction-redesign-design.md`

## Global Constraints

- Every task touching `content/src/*`, `flow/src/*`, or `link/src/*` must pass `tsc --noEmit` in that module before being considered done.
- This is a rework of already-shipped, already-deployed code (all 22 prior tasks are live in dev). Every task that changes an existing test file must update it in place, not leave the old assertions alongside new ones.
- A destructive D1 migration (`DROP TABLE` + recreate) is acceptable for `tenant_llm_credentials` — no real tenant data exists yet, this is dev-only iteration, not production data loss.
- No full external API payloads in the DB — unchanged rule, still applies to `recordPublishedContent`'s `raw_data`.
- Frontend: no inline CSS, use `shared/frontend/ui/*` components, reuse `link/frontend/components/ChannelCard.tsx` directly for the new settings page (don't fork it).

---

## Task 1: Metadata — `ContentMetadata` extension + `ContentMetadata_X`

**Files:**
- Modify: `metadata/dataTypes.ts`
- Modify: `metadata/x.ts`

**Interfaces:**
- Produces: `ContentMetadata` gains `flowType?: string`, `price?: number`, `label?: LocalizedString`, `description?: LocalizedString` (matching `EventMetadata`'s existing shape). New export `ContentMetadata_X: ContentMetadata[]` with one entry for `create-post`. Consumed by: nothing yet in this task — Task 9 imports `ContentMetadata_X` directly in the frontend for the Operation dropdown.

- [ ] **Step 1: Extend `ContentMetadata` in `metadata/dataTypes.ts`**

Find:

```ts
export interface ContentMetadata {
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  sourceContentType: string;
  contentProps: PropMapping[];
}
```

Replace with:

```ts
export interface ContentMetadata {
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  sourceContentType: string;
  flowType?: string; //trigger or action
  price?: number; //价格/官方费用
  label?: LocalizedString;
  description?: LocalizedString;
  contentProps: PropMapping[];
}
```

- [ ] **Step 2: Add `ContentMetadata_X` to `metadata/x.ts`**

Add near the top of the file, after the existing imports (`import type { EventMetadata, ContentMetadata } from "./dataTypes";` already exists in this file):

```ts
export const ContentMetadata_X: ContentMetadata[] = [
  {
    sourceContentType: "create-post", // https://docs.x.com/x-api/posts/create-post
    flowType: "action",
    label: { en: "Create Post", zh: "新建推文" },
    contentProps: [],
  },
];
```

- [ ] **Step 3: Typecheck (this file is imported by `link`, `flow`, and `content` — check all three)**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm run typecheck 2>&1 | grep -v "shared/frontend"
cd ../flow && npm run typecheck 2>&1 | grep -v "shared/frontend"
cd ../content && npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: no new errors in any module beyond the pre-existing `shared/frontend` react-types baseline noise (filtered out above).

- [ ] **Step 4: Commit**

```bash
git add metadata/dataTypes.ts metadata/x.ts
git commit -m "feat(metadata): extend ContentMetadata with flowType/label/price, add ContentMetadata_X create-post entry"
```

---

## Task 2: Delete the skill catalog

**Files:**
- Delete: `content/src/skills/interface.ts`
- Delete: `content/src/skills/punchy-social.ts`
- Delete: `content/src/skills/professional-tone.ts`
- Delete: `content/src/skills/index.ts`
- Delete: `content/tests/skills.test.ts`

**Interfaces:**
- Produces: nothing (removal only). `content/src/services/generate.ts` still imports `getSkill` from `../skills` at this point — Task 4 fixes that in the same PR sequence, so a transient broken import between this task and Task 4 is expected and fine (both land before any review/deploy checkpoint that matters).

- [ ] **Step 1: Delete the four skill files and the test file**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content
rm -rf src/skills
rm tests/skills.test.ts
```

- [ ] **Step 2: Confirm nothing else references `src/skills` yet (Task 4/5 will fix the two real consumers)**

```bash
grep -rn "from \"\.\./skills\"\|from \"\./skills\"\|SKILL_CATALOG\|getSkill" src/ 2>/dev/null
```

Expected output: two matches — `src/services/generate.ts` (imports `getSkill`) and `src/index.ts` (imports `SKILL_CATALOG`, defines `GET /api/skills`). Both are fixed in Tasks 4 and 5 respectively. Do not fix them in this task — this task is pure deletion, scoped only to the files listed above.

- [ ] **Step 3: Commit**

```bash
git add -A src/skills tests/skills.test.ts
git commit -m "feat(content): remove skill catalog (superseded by free-text prompt in flow)"
```

---

## Task 3: Multi-provider BYOK credentials — schema + service

**Files:**
- Create: `content/migrations/0002_multi_provider_credentials.sql`
- Modify: `content/src/services/llm-credentials.ts`
- Modify: `content/tests/llm-credentials.test.ts`

**Interfaces:**
- Produces: `getTenantLlmCredentials(env, tenantId, provider): Promise<{apiKey, model} | null>`, `setTenantLlmCredentials(env, tenantId, provider, apiKey, model): Promise<void>`, `listConfiguredProviders(env, tenantId): Promise<{provider: string, model: string}[]>`, `deleteTenantLlmCredentials(env, tenantId, provider): Promise<void>`. Consumed by Task 4 (`generate.ts`) and Task 5 (routes).

- [ ] **Step 1: Write the migration**

```sql
-- content/migrations/0002_multi_provider_credentials.sql
DROP TABLE IF EXISTS tenant_llm_credentials;
CREATE TABLE tenant_llm_credentials (
  tenant_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);
```

- [ ] **Step 2: Apply it locally**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content
wrangler d1 migrations apply uniscrm-content-dev --local
wrangler d1 execute uniscrm-content-dev --local --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='tenant_llm_credentials'"
```

Expected: the new schema shown, with `PRIMARY KEY (tenant_id, provider)`.

- [ ] **Step 3: Write the failing tests (rewrite `content/tests/llm-credentials.test.ts` in full — the old single-provider assertions no longer apply)**

```ts
// content/tests/llm-credentials.test.ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import {
  getTenantLlmCredentials,
  setTenantLlmCredentials,
  listConfiguredProviders,
  deleteTenantLlmCredentials,
} from "../src/services/llm-credentials";

describe("multi-provider tenant LLM credentials", () => {
  const testMasterKey = generateMasterKey();
  const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

  beforeEach(async () => {
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials`).run();
  });

  it("returns null for a provider with no credentials set", async () => {
    expect(await getTenantLlmCredentials(testEnv as any, 42, "openai")).toBeNull();
  });

  it("round-trips provider + api key + model through encryption", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123", "gpt-4o-mini");
    const creds = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(creds).toEqual({ apiKey: "sk-test-123", model: "gpt-4o-mini" });
  });

  it("stores openai and anthropic independently for the same tenant", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");

    const openai = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    const anthropic = await getTenantLlmCredentials(testEnv as any, 42, "anthropic");
    expect(openai).toEqual({ apiKey: "sk-openai", model: "gpt-4o-mini" });
    expect(anthropic).toEqual({ apiKey: "sk-anthropic", model: "claude-3-5-haiku-latest" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42`).first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("upserts on a second call for the same (tenant, provider) pair", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-old", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-new", "gpt-4o");
    const creds = await getTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(creds).toEqual({ apiKey: "sk-new", model: "gpt-4o" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42 AND provider = 'openai'`).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("listConfiguredProviders reports provider+model without decrypting, for all configured providers", async () => {
    expect(await listConfiguredProviders(testEnv as any, 42)).toEqual([]);
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");
    const list = await listConfiguredProviders(testEnv as any, 42);
    expect(list.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
      { provider: "anthropic", model: "claude-3-5-haiku-latest" },
      { provider: "openai", model: "gpt-4o-mini" },
    ]);
  });

  it("deleteTenantLlmCredentials removes only the specified provider", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-anthropic", "claude-3-5-haiku-latest");
    await deleteTenantLlmCredentials(testEnv as any, 42, "openai");
    expect(await getTenantLlmCredentials(testEnv as any, 42, "openai")).toBeNull();
    expect(await getTenantLlmCredentials(testEnv as any, 42, "anthropic")).toEqual({ apiKey: "sk-anthropic", model: "claude-3-5-haiku-latest" });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/llm-credentials.test.ts
```

Expected: FAIL — `getTenantLlmCredentials` etc. don't accept a `provider` argument yet, and `listConfiguredProviders`/`deleteTenantLlmCredentials` don't exist.

- [ ] **Step 5: Rewrite `content/src/services/llm-credentials.ts` in full**

```ts
// content/src/services/llm-credentials.ts
import type { Env } from "../types";
import { encrypt, decrypt } from "./crypto";

export type LlmProviderName = "openai" | "anthropic";

export interface LlmCredentials {
  apiKey: string;
  model: string;
}

export async function getTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName
): Promise<LlmCredentials | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT encrypted_api_key, model FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = ?"
  ).bind(tenantId, provider).first<{ encrypted_api_key: string; model: string }>();
  if (!row) return null;

  const masterKey = await env.ENCRYPTION_KEY.get();
  const apiKey = await decrypt(row.encrypted_api_key, masterKey);
  return { apiKey, model: row.model };
}

export async function setTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName,
  apiKey: string,
  model: string
): Promise<void> {
  const masterKey = await env.ENCRYPTION_KEY.get();
  const encryptedApiKey = await encrypt(apiKey, masterKey);
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, provider) DO UPDATE SET
       encrypted_api_key = excluded.encrypted_api_key,
       model = excluded.model,
       updated_at = excluded.updated_at`
  ).bind(tenantId, provider, encryptedApiKey, model, now, now).run();
}

export async function listConfiguredProviders(
  env: Env,
  tenantId: number
): Promise<{ provider: string; model: string }[]> {
  const rows = await env.CONTENT_DB.prepare(
    "SELECT provider, model FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).all<{ provider: string; model: string }>();
  return rows.results;
}

export async function deleteTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName
): Promise<void> {
  await env.CONTENT_DB.prepare(
    "DELETE FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = ?"
  ).bind(tenantId, provider).run();
}
```

- [ ] **Step 6: Run the tests**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/llm-credentials.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck (expect errors in `generate.ts`/`index.ts` — Tasks 4/5 fix them, don't touch here)**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: errors in `src/services/generate.ts` (calls `hasTenantLlmCredentials`/old `getTenantLlmCredentials` shape — removed/changed) and `src/index.ts` (calls old `hasTenantLlmCredentials`/`setTenantLlmCredentials` shape). This is expected and fixed in Tasks 4/5 — do not fix it here.

- [ ] **Step 8: Commit**

```bash
git add content/migrations/0002_multi_provider_credentials.sql content/src/services/llm-credentials.ts content/tests/llm-credentials.test.ts
git commit -m "feat(content): multi-provider BYOK credentials (one row per tenant+provider)"
```

(Note: this commit intentionally leaves `generate.ts`/`index.ts` red — Tasks 4/5 fix them in the same PR sequence, mirroring how the original plan handled the `emitFlowEvent` threading gap.)

---

## Task 4: Simplify `generate.ts`

**Files:**
- Modify: `content/src/services/generate.ts`
- Modify: `content/tests/generate.test.ts`

**Interfaces:**
- Consumes: `getTenantLlmCredentials(env, tenantId, provider)` (Task 3).
- Produces: `generateContent(env, {tenantId, prompt, provider}): Promise<string>` where `provider: "default" | "openai" | "anthropic"` (note: `"none"` is handled entirely by `link`, never reaches this function — see Task 11). Throws a clear error if `provider` is `"openai"`/`"anthropic"` but no credentials are configured for that tenant+provider (no silent fallback). Consumed by Task 5 (`/internal/generate` route).

- [ ] **Step 1: Rewrite the test file in full**

```ts
// content/tests/generate.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateContent } from "../src/services/generate";
import * as credentialsModule from "../src/services/llm-credentials";

describe("generateContent", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseParams = { tenantId: 1, prompt: "Rewrite this in a punchy tone: We shipped a thing today.", provider: "default" as const };

  it("uses Workers AI for provider: 'default'", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const text = await generateContent({ AI: { run: aiRun } } as any, baseParams);
    expect(text).toBe("punchy text");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      expect.objectContaining({ messages: expect.arrayContaining([{ role: "user", content: baseParams.prompt }]) })
    );
  });

  it("uses the tenant's OpenAI BYOK credentials for provider: 'openai'", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "openai text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, { ...baseParams, provider: "openai" });

    expect(text).toBe("openai text");
    expect(credentialsModule.getTenantLlmCredentials).toHaveBeenCalledWith(expect.anything(), 1, "openai");
    vi.unstubAllGlobals();
  });

  it("uses the tenant's Anthropic BYOK credentials for provider: 'anthropic'", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-ant-test", model: "claude-3-5-haiku-latest" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic text" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, { ...baseParams, provider: "anthropic" });

    expect(text).toBe("anthropic text");
    vi.unstubAllGlobals();
  });

  it("throws clearly (no silent fallback) when provider: 'openai' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateContent({} as any, { ...baseParams, provider: "openai" })).rejects.toThrow(/No openai credentials configured/);
  });

  it("throws clearly (no silent fallback) when provider: 'anthropic' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateContent({} as any, { ...baseParams, provider: "anthropic" })).rejects.toThrow(/No anthropic credentials configured/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/generate.test.ts
```

Expected: FAIL — current `generateContent` still takes `{skillId, material, targetPlatform}` and imports `getSkill` from the now-deleted `../skills`.

- [ ] **Step 3: Rewrite `content/src/services/generate.ts` in full**

```ts
// content/src/services/generate.ts
import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { WorkersAiProvider } from "../providers/workers-ai";
import { OpenAiProvider } from "../providers/openai";
import { AnthropicProvider } from "../providers/anthropic";
import type { LlmProvider } from "../providers/interface";

export interface GenerateParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai" | "anthropic";
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  if (params.provider === "default") {
    return new WorkersAiProvider(env.AI).generate(params.prompt);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, params.provider);
  if (!credentials) {
    throw new Error(`No ${params.provider} credentials configured for this tenant`);
  }

  const provider: LlmProvider =
    params.provider === "openai"
      ? new OpenAiProvider(credentials.apiKey)
      : new AnthropicProvider(credentials.apiKey);

  return provider.generate(params.prompt);
}
```

Note the `LlmProvider` interface's `generate` signature is changing from `(systemPrompt, userPrompt)` to a single `(prompt)` — see Step 4.

- [ ] **Step 4: Update the three provider implementations to a single-argument `generate(prompt)`**

In `content/src/providers/interface.ts`, change:

```ts
export interface LlmProvider {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}
```

to:

```ts
export interface LlmProvider {
  generate(prompt: string): Promise<string>;
}
```

In `content/src/providers/workers-ai.ts`, change:

```ts
  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const result = (await this.ai.run(MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
    })) as { response: string };
    return result.response;
  }
```

to:

```ts
  async generate(prompt: string): Promise<string> {
    const result = (await this.ai.run(MODEL, {
      messages: [{ role: "user", content: prompt }],
      stream: false,
    })) as { response: string };
    return result.response;
  }
```

In `content/src/providers/openai.ts`, change:

```ts
  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
```

to:

```ts
  async generate(prompt: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    });
```

In `content/src/providers/anthropic.ts`, change:

```ts
  async generate(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
```

to:

```ts
  async generate(prompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
```

- [ ] **Step 5: Update the three providers' existing tests for the new single-argument signature**

In `content/tests/providers/workers-ai.test.ts`, `openai.test.ts`, `anthropic.test.ts` — change every `provider.generate("system prompt", "user prompt")` call to `provider.generate("user prompt")`, and update the corresponding assertions on the constructed request body (drop the `system`/`role:"system"` expectations, keep only the single user-role message). Run each focused test file after editing to confirm.

- [ ] **Step 6: Run the tests**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/generate.test.ts tests/providers/
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: only `src/index.ts` remains red (Task 5 fixes it).

- [ ] **Step 8: Commit**

```bash
git add content/src/services/generate.ts content/src/providers content/tests/generate.test.ts content/tests/providers
git commit -m "feat(content): simplify generate to {tenantId, prompt, provider}, single-message LLM calls"
```

---

## Task 5: Routes — `/internal/generate`, multi-provider `/api/llm-credentials`, remove `/api/skills`

**Files:**
- Modify: `content/src/routes-internal.ts`
- Modify: `content/src/index.ts`
- Modify: `content/tests/routes-internal.test.ts`
- Modify: `content/tests/routes-api.test.ts`

**Interfaces:**
- Consumes: `generateContent` (Task 4), `listConfiguredProviders`/`setTenantLlmCredentials`/`deleteTenantLlmCredentials` (Task 3).
- Produces: `POST /internal/generate` body becomes `{tenantId, prompt, provider}`. `GET /api/llm-credentials` returns `{providers: {provider, model}[]}` (a list, not a single nullable object). `PUT /api/llm-credentials` takes `{provider, apiKey, model}`. New `DELETE /api/llm-credentials/:provider`. `/api/skills` removed. Consumed by Task 6 (settings page) and Task 8 (`link`'s `CONTENT_URL` calls, Task 9's `/api/llm-providers` proxy).

- [ ] **Step 1: Rewrite `content/tests/routes-internal.test.ts`'s generate tests for the new body shape**

Find the existing test bodies that POST `{tenantId, skillId, material, targetPlatform}` and replace with `{tenantId, prompt, provider}`:

```ts
// content/tests/routes-internal.test.ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("POST /internal/generate", () => {
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };

  afterEach(() => vi.unstubAllGlobals());

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, prompt: "hello", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns generated text on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "hello world", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(typeof body.text).toBe("string");
  });

  it("returns 400 for missing required fields", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999 }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when provider is openai/anthropic with no configured credentials", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "hello", provider: "openai" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/routes-internal.test.ts
```

Expected: FAIL — the route still expects `skillId`/`material`/`targetPlatform`.

- [ ] **Step 3: Rewrite `content/src/routes-internal.ts`**

```ts
// content/src/routes-internal.ts
import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/generate", async (c) => {
    const { tenantId, prompt, provider } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai" | "anthropic";
    }>();

    if (!tenantId || !prompt || !provider) {
      return c.json({ error: "tenantId, prompt, provider required" }, 400);
    }

    try {
      const text = await generateContent(c.env, { tenantId, prompt, provider });
      return c.json({ text });
    } catch (err) {
      if (String(err).includes("No") && String(err).includes("credentials configured")) {
        return c.json({ error: String(err) }, 400);
      }
      console.error(JSON.stringify({ event: "generate_failed", tenantId, provider, error: String(err) }));
      return c.json({ error: "Generation failed" }, 502);
    }
  });

  return router;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/routes-internal.test.ts
```

Expected: PASS.

- [ ] **Step 5: Rewrite `content/tests/routes-api.test.ts`** (drop the `/api/skills` test entirely, rewrite the `/api/llm-credentials` tests for the list/multi-provider shape, add a DELETE test)

```ts
// content/tests/routes-api.test.ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("/api/llm-credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET returns 401 when the session check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=bad" } }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("GET returns an empty list when authed but nothing configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "77" } }), { status: 200 }))
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 77`).run();

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  it("PUT saves a provider, GET lists it (with model, never the key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "78" } }), { status: 200 }))
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 78`).run();

    const putRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT",
        headers: { Cookie: "session=ok", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" }),
      }),
      env
    );
    expect(putRes.status).toBe(200);

    const getRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      env
    );
    expect(await getRes.json()).toEqual({ providers: [{ provider: "openai", model: "gpt-4o-mini" }] });
  });

  it("DELETE removes a provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "79" } }), { status: 200 }))
    );
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials WHERE tenant_id = 79`).run();
    await env.CONTENT_DB.prepare(
      `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at) VALUES (79, 'openai', 'x', 'gpt-4o-mini', datetime('now'), datetime('now'))`
    ).run();

    const delRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials/openai", { method: "DELETE", headers: { Cookie: "session=ok" } }),
      env
    );
    expect(delRes.status).toBe(200);

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 79`).first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
npx vitest run tests/routes-api.test.ts
```

Expected: FAIL — routes still use the old single-provider shape, no DELETE route exists.

- [ ] **Step 7: Rewrite `content/src/index.ts`**

Find:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { SKILL_CATALOG } from "./skills";
import { setTenantLlmCredentials, hasTenantLlmCredentials } from "./services/llm-credentials";
```

Replace with:

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { setTenantLlmCredentials, listConfiguredProviders, deleteTenantLlmCredentials } from "./services/llm-credentials";
```

Find:

```ts
app.get("/api/skills", (c) => {
  return c.json({ skills: SKILL_CATALOG.map((s) => ({ id: s.id, label: s.label })) });
});

app.use("/api/llm-credentials", sessionAuth);

app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const credentials = await hasTenantLlmCredentials(c.env, tenantId);
  return c.json({ credentials });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey } = await c.req.json<{ provider: "openai" | "anthropic"; apiKey: string }>();
  if (!provider || !apiKey) return c.json({ error: "provider and apiKey required" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey);
  return c.json({ ok: true });
});
```

Replace with:

```ts
app.use("/api/llm-credentials", sessionAuth);
app.use("/api/llm-credentials/*", sessionAuth);

app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers = await listConfiguredProviders(c.env, tenantId);
  return c.json({ providers });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model } = await c.req.json<{ provider: "openai" | "anthropic"; apiKey: string; model: string }>();
  if (!provider || !apiKey || !model) return c.json({ error: "provider, apiKey, model required" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model);
  return c.json({ ok: true });
});

app.delete("/api/llm-credentials/:provider", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const provider = c.req.param("provider") as "openai" | "anthropic";
  await deleteTenantLlmCredentials(c.env, tenantId, provider);
  return c.json({ ok: true });
});
```

- [ ] **Step 8: Run the tests**

```bash
npx vitest run tests/routes-api.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run the full module test suite + typecheck**

```bash
npx vitest run
npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: all tests pass; typecheck clean beyond the pre-existing `./App`-resolved-by-Task-9 note (there is none anymore, `App.tsx` exists — expect zero errors in `src/`).

- [ ] **Step 10: Commit**

```bash
git add content/src/routes-internal.ts content/src/index.ts content/tests/routes-internal.test.ts content/tests/routes-api.test.ts
git commit -m "feat(content): multi-provider /api/llm-credentials (list/put/delete), simplified /internal/generate, remove /api/skills"
```

---

## Task 6: Settings page — card-based multi-provider UI

**Files:**
- Modify: `content/frontend/lib/api.ts`
- Modify: `content/frontend/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/llm-credentials` (Task 5), `ChannelCard` (`link/frontend/components/ChannelCard.tsx` — imported directly cross-module via relative path, it's a generic presentational component with no `link`-specific logic).
- Produces: a working card-per-provider settings page. No further tasks consume this directly (leaf).

- [ ] **Step 1: Rewrite `content/frontend/lib/api.ts`**

```ts
// content/frontend/lib/api.ts
import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error || res.statusText);
  }
  return res.json();
}

export interface ProviderCredentialInfo {
  provider: "openai" | "anthropic";
  model: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[] }> => request("/api/llm-credentials"),
    save: (provider: "openai" | "anthropic", apiKey: string, model: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
};
```

- [ ] **Step 2: Rewrite `content/frontend/pages/SettingsPage.tsx`**

```tsx
// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api, type ProviderCredentialInfo } from "../lib/api";

const PROVIDER_MODELS: Record<"openai" | "anthropic", string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
};

const PROVIDER_LABELS: Record<"openai" | "anthropic", string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

function ProviderLogo({ provider }: { provider: "openai" | "anthropic" }) {
  return (
    <div className="w-full h-full flex items-center justify-center text-sm font-bold text-foreground/70">
      {provider === "openai" ? "AI" : "A"}
    </div>
  );
}

function ProviderForm({
  provider,
  initialModel,
  onSaved,
  onCancel,
}: {
  provider: "openai" | "anthropic";
  initialModel?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel || PROVIDER_MODELS[provider][0]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!apiKey) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, apiKey, model);
      toast({ title: `${PROVIDER_LABELS[provider]} key saved` });
      onSaved();
    } catch {
      toast({ title: "Failed to save key", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs block mb-1">API Key</Label>
        <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
      </div>
      <div>
        <Label className="text-xs block mb-1">Model</Label>
        <Select value={model} onChange={(e: any) => setModel(e.target.value)} className="w-full text-sm">
          {PROVIDER_MODELS[provider].map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || !apiKey}>{saving ? "Saving..." : "Save"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderCredentialInfo[]>([]);
  const [editing, setEditing] = useState<"openai" | "anthropic" | null>(null);
  const { toast } = useToast();

  const reload = () => {
    api.llmCredentials.list().then((res) => setProviders(res.providers)).catch(() => {});
  };

  useEffect(reload, []);

  const handleDisconnect = async (provider: "openai" | "anthropic") => {
    try {
      await api.llmCredentials.remove(provider);
      toast({ title: `${PROVIDER_LABELS[provider]} disconnected` });
      reload();
    } catch {
      toast({ title: "Failed to disconnect", variant: "destructive" });
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Content Generation Settings</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(["openai", "anthropic"] as const).map((provider) => {
          const configured = providers.find((p) => p.provider === provider);
          return (
            <ChannelCard
              key={provider}
              logo={<ProviderLogo provider={provider} />}
              name={PROVIDER_LABELS[provider]}
              tagline={configured ? `Model: ${configured.model}` : "No key configured for this provider"}
              status={configured ? "connected" : "disconnected"}
              extra={
                editing === provider ? (
                  <ProviderForm
                    provider={provider}
                    initialModel={configured?.model}
                    onSaved={() => { setEditing(null); reload(); }}
                    onCancel={() => setEditing(null)}
                  />
                ) : undefined
              }
              actions={
                editing === provider ? undefined : (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setEditing(provider)}>{configured ? "Edit" : "Connect"}</Button>
                    {configured && <Button size="sm" variant="ghost" onClick={() => handleDisconnect(provider)}>Disconnect</Button>}
                  </div>
                )
              }
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        No key configured for a provider? Flow nodes can still use the free built-in model ("default") or post text with no AI at all ("none").
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: clean. (If `Button`'s `variant`/`size` props don't exist on the shared `Button` component, read `shared/frontend/ui/button.tsx` first and adjust to whatever props it actually supports — don't invent props that don't exist.)

- [ ] **Step 4: Manual verification** (no automated frontend tests in this repo's convention)

Run `npm run dev:worker` and `npm run dev`, open the settings page, confirm both provider cards render, "Connect" opens the inline form, saving a key flips the card to "connected" with the model shown, "Disconnect" flips it back.

- [ ] **Step 5: Commit**

```bash
git add content/frontend/lib/api.ts content/frontend/pages/SettingsPage.tsx
git commit -m "feat(content): card-based multi-provider settings page (reuses link's ChannelCard)"
```

---

## Task 7: `flow` engine — `aiRewritePublish` → `xContentAction`

**Files:**
- Modify: `flow/src/engine.ts`
- Modify: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Produces: `buildActionData`/`collectActions` recognize `actionType: "xContentAction"` instead of `"aiRewritePublish"`, collecting `{targetChannelId, prompt, provider}` (no `skillId`). Consumed by Task 8 (`executeContentActions`).

- [ ] **Step 1: Update the existing test**

Find every occurrence of `aiRewritePublish` in `flow/tests/unit/engine.test.ts` and replace the action-type string with `xContentAction`, and replace `skillId: "punchy-social"` node-data fields with `prompt: "Rewrite this: $content.content_text"` and `provider: "default"`. For example, the `collectActions` test:

```ts
  it("collects an xContentAction action carrying its target channel, prompt, and provider", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([
      { type: "xContentAction", nodeId: "a1", hasBranches: true, targetChannelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" },
    ]);
  });
```

Apply the same rename to the `resumeFromNode` branch-resolution tests (Task 13's tests) — replace `aiRewritePublish`/`skillId` node data with `xContentAction`/`prompt`+`provider` throughout.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npx vitest run tests/unit/engine.test.ts
```

Expected: FAIL — `engine.ts` doesn't recognize `xContentAction` yet.

- [ ] **Step 3: Update `buildActionData` in `flow/src/engine.ts`**

Find:

```ts
function buildActionData(targetNode: FlowNode): ActionResult {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction" || actionType === "repost" || actionType === "aiRewritePublish";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
  if (actionType === "xAction") {
    actionData.xEvent = targetNode.data.xEvent as string;
    actionData.channelId = targetNode.data.channelId as string;
    if (targetNode.data.messageText) actionData.messageText = targetNode.data.messageText as string;
  }
  if (actionType === "aiRewritePublish") {
    actionData.targetChannelId = targetNode.data.channelId as string;
    actionData.skillId = targetNode.data.skillId as string;
  }
  if (actionType === "updateContentStatus") {
    actionData.status = targetNode.data.status as string;
  }
  return actionData;
}
```

Replace with:

```ts
function buildActionData(targetNode: FlowNode): ActionResult {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction" || actionType === "repost" || actionType === "xContentAction";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
  if (actionType === "xAction") {
    actionData.xEvent = targetNode.data.xEvent as string;
    actionData.channelId = targetNode.data.channelId as string;
    if (targetNode.data.messageText) actionData.messageText = targetNode.data.messageText as string;
  }
  if (actionType === "xContentAction") {
    actionData.targetChannelId = targetNode.data.channelId as string;
    actionData.prompt = targetNode.data.prompt as string;
    actionData.provider = targetNode.data.provider as string;
  }
  if (actionType === "updateContentStatus") {
    actionData.status = targetNode.data.status as string;
  }
  return actionData;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/unit/engine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + full regression run**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
npx vitest run
```

Expected: no new errors (other test files reference `aiRewritePublish` too — they're fixed in Task 8, expect them red until then; if `engine.test.ts` alone is green, that satisfies this task).

- [ ] **Step 6: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): rename aiRewritePublish to xContentAction, drop skillId for prompt+provider"
```

---

## Task 8: `flow` executor — interpolation, new endpoint, `/api/llm-providers` proxy

**Files:**
- Modify: `flow/src/index.ts`
- Modify: `flow/tests/unit/queue-content.test.ts`
- Modify: `flow/tests/unit/scheduled-content.test.ts`

**Interfaces:**
- Consumes: `xContentAction`'s `{targetChannelId, prompt, provider}` (Task 7).
- Produces: `executeContentActions` interpolates `$content.xxx` in the prompt before calling `link`'s new `/internal/content/create-post` endpoint (replacing `/internal/content/ai-rewrite-publish`). `GET /api/llm-providers` proxy added (replacing `/api/skills`).

- [ ] **Step 1: Update `flow/tests/unit/queue-content.test.ts`**

Every test graph using `aiRewritePublish` gets `actionType: "xContentAction"` with `prompt`/`provider` fields instead of `skillId`, and every assertion on the outbound `fetch` call's URL/body updates from `/internal/content/ai-rewrite-publish` + `{contentId, sourceChannelId, targetChannelId, skillId, flowId}` to `/internal/content/create-post` + `{contentId, interpolatedPrompt, provider, targetChannelId, flowId}`. Add one new test asserting interpolation:

```ts
  it("interpolates $content.xxx fields from the payload into the prompt before calling link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithInterpolation = JSON.stringify({
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-1", prompt: "Rewrite: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-interp', 1, 'interp flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithInterpolation).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-interp", channelId: "src-chan", payload: { content_text: "original post text" } }),
      env
    );

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.interpolatedPrompt).toBe("Rewrite: original post text");

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-interp'`).run();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Update `flow/tests/unit/scheduled-content.test.ts`** the same way (any `aiRewritePublish`-shaped test graphs/actions become `xContentAction` with `prompt`/`provider`, and the retry-action JSON payloads used in the exhaustion/reschedule tests update their `type`/fields to match).

- [ ] **Step 3: Run both to verify they fail**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npx vitest run tests/unit/queue-content.test.ts tests/unit/scheduled-content.test.ts
```

Expected: FAIL — `executeContentActions` still handles `aiRewritePublish` and calls the old endpoint/body shape.

- [ ] **Step 4: Rewrite the `xContentAction` branch of `executeContentActions` in `flow/src/index.ts`**

Find:

```ts
    } else if (action.type === "aiRewritePublish") {
      const targetChannelId = action.targetChannelId as string;
      const skillId = action.skillId as string;
      const res = await fetch(`${env.LINK_URL}/internal/content/ai-rewrite-publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ contentId, sourceChannelId: channelId, targetChannelId, skillId, flowId: flowId || null }),
      });
      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: "content_action_ai_rewrite_publish", contentId, targetChannelId, skillId, status: res.status, ok: body.ok }));
```

Replace with:

```ts
    } else if (action.type === "xContentAction") {
      const targetChannelId = action.targetChannelId as string;
      const provider = action.provider as string;
      const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
      const res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ contentId, interpolatedPrompt, provider, targetChannelId, flowId: flowId || null }),
      });
      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: "content_action_x_content_action", contentId, targetChannelId, provider, status: res.status, ok: body.ok }));
```

(The rest of that branch — rate-limit handling, `resumeFromNode` call, nested `executeContentActions`, `content_flow_executions`/`content_flow_pending` writes — is unchanged; only the fetch URL/body and the log event name/fields above it change.)

- [ ] **Step 5: Replace the `/api/skills` proxy with `/api/llm-providers`**

Find:

```ts
// Proxy skills from content worker
app.get("/api/skills", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/skills`);
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

Replace with:

```ts
// Proxy configured LLM providers from content worker (tenant-scoped, forwards the session cookie)
app.get("/api/llm-providers", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/llm-credentials`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/unit/queue-content.test.ts tests/unit/scheduled-content.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck + full regression run**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
npx vitest run
```

Expected: no new errors, all tests pass (frontend files still reference `aiRewritePublish`/`api.skills` — fixed in Task 9, those don't affect backend test/typecheck results here since they're separate files with their own typecheck surface... actually frontend IS included in this module's single `tsc` run per `tsconfig.json`'s `include`. Expect frontend-file errors here; Task 9 fixes them. Confirm no *backend* (`src/`) errors remain).

- [ ] **Step 8: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts flow/tests/unit/scheduled-content.test.ts
git commit -m "feat(flow): interpolate \$content.xxx into xContentAction's prompt, call link's new create-post endpoint, add /api/llm-providers proxy"
```

---

## Task 9: `flow` frontend — `XContentActionInspector`, renames

**Files:**
- Modify: `flow/frontend/nodes/ActionNode.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/lib/api.ts`

**Interfaces:**
- Consumes: `GET /api/llm-providers` (Task 8), `ContentActionMetadata_X` (Task 1, imported directly).
- Produces: a working `xContentAction` node + Inspector with Operation/Prompt/Provider/Target Platform/Target Account fields. Leaf task for this plan's frontend surface.

- [ ] **Step 1: Rename in `flow/frontend/nodes/ActionNode.tsx`**

Find:

```tsx
const EXTERNAL_API_ACTIONS = ["xAction", "repost", "aiRewritePublish"];
```

Replace with:

```tsx
const EXTERNAL_API_ACTIONS = ["xAction", "repost", "xContentAction"];
```

Find:

```tsx
  } else if (actionType === "aiRewritePublish") {
    const channelId = data.channelId as string;
    label = "AI Rewrite & Publish";
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = "✨";
```

Replace with:

```tsx
  } else if (actionType === "xContentAction") {
    const channelId = data.channelId as string;
    label = "X Content Action";
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = "✨";
```

- [ ] **Step 2: Rename in `flow/frontend/store/flow-editor.ts`**

Find:

```ts
const ACTION_TYPES = ["addToList", "xAction", "repost", "aiRewritePublish", "updateContentStatus"];
```

Replace with:

```ts
const ACTION_TYPES = ["addToList", "xAction", "repost", "xContentAction", "updateContentStatus"];
```

Find:

```ts
      } else if (type === "aiRewritePublish") {
        data = { actionType: type, channelType: "", channelId: "", skillId: "" };
```

Replace with:

```ts
      } else if (type === "xContentAction") {
        data = { actionType: type, channelType: "", channelId: "", prompt: "", provider: "default" };
```

- [ ] **Step 3: Rename in `flow/frontend/components/Sidebar.tsx`**

Find:

```tsx
          <DraggableItem type="aiRewritePublish" label="AI Rewrite & Publish" description="Rewrite and publish to another channel" color="border-accent bg-accent/50" icon="✨" />
```

Replace with:

```tsx
          <DraggableItem type="xContentAction" label="X Content Action" description="Generate (or post as-is) and publish to another channel" color="border-accent bg-accent/50" icon="✨" />
```

- [ ] **Step 4: Add `api.llmProviders.list()` to `flow/frontend/lib/api.ts`**

Find the `skills` entry in the exported `api` object (added in the prior plan's Task 16):

```ts
  skills: {
    list: (): Promise<{ skills: SkillOption[] }> => request("/api/skills"),
  },
```

Replace with:

```ts
  llmProviders: {
    list: (): Promise<{ providers: { provider: string; model: string }[] }> => request("/api/llm-providers"),
  },
```

(Remove the now-unused `SkillOption` interface if nothing else references it.)

- [ ] **Step 5: Rewrite `AiRewritePublishInspector` → `XContentActionInspector` in `flow/frontend/components/Inspector.tsx`**

Find the dispatch line:

```tsx
  if (actionType === "aiRewritePublish") {
    return <AiRewritePublishInspector nodeId={nodeId} data={data} />;
  }
```

Replace with:

```tsx
  if (actionType === "xContentAction") {
    return <XContentActionInspector nodeId={nodeId} data={data} />;
  }
```

Find the whole `AiRewritePublishInspector` function and replace it with:

```tsx
import { ContentActionMetadata_X } from "../../../metadata/x";
import { t as localizeLabel } from "../../../metadata/locale";

const CONTENT_ACTION_OPERATIONS = ContentActionMetadata_X.filter((m) => m.flowType === "action");

function XContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channelType, setChannelType] = useState<string>(data.channelType || "");
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);

  useEffect(() => {
    if (!channelType) { setChannels([]); return; }
    api.channels.list(channelType).then(setChannels).catch(() => setChannels([]));
  }, [channelType]);

  useEffect(() => {
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">X Content Action</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <Select
            value={data.operation || "create-post"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { operation: e.target.value })}
            className="w-full text-sm"
          >
            {CONTENT_ACTION_OPERATIONS.map((op) => (
              <option key={op.sourceContentType} value={op.sourceContentType}>
                {op.label ? localizeLabel(op.label, "en") : op.sourceContentType}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">Prompt</Label>
          <Textarea
            value={data.prompt || ""}
            onChange={(e: TextareaChange) => updateNodeData(nodeId, { prompt: e.target.value })}
            placeholder="Rewrite this in a punchy tone: $content.content_text"
            rows={5}
            className="w-full text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">Use $content.title, $content.content_text etc.</p>
        </div>
        <div>
          <Label className="text-xs block mb-1">Provider</Label>
          <Select
            value={data.provider || "default"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { provider: e.target.value })}
            className="w-full text-sm"
          >
            <option value="default">Default (free built-in model)</option>
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
            ))}
            <option value="none">None (post prompt text as-is)</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">Target Platform</Label>
          <Select
            value={channelType}
            onChange={(e: SelectChange) => { setChannelType(e.target.value); updateNodeData(nodeId, { channelType: e.target.value, channelId: "" }); }}
            className="w-full text-sm"
          >
            <option value="">Select platform...</option>
            {CONTENT_CHANNEL_TYPES.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
          </Select>
        </div>
        {channelType && (
          <div>
            <Label className="text-xs block mb-1">Target Account</Label>
            {channels.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No accounts linked for this platform</p>
            ) : (
              <Select
                value={data.channelId || ""}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="">Select account...</option>
                {channels.map((ch) => <option key={ch.id} value={ch.id}>@{ch.username}</option>)}
              </Select>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

(`CONTENT_CHANNEL_TYPES` is the existing `const CONTENT_CHANNEL_TYPES = ["X", "TIKTOK"];` already defined above the old `AiRewritePublishInspector` — keep it as-is, it's still used.)

- [ ] **Step 6: Typecheck**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: clean. If `metadata/locale.ts`'s `t` export collides with anything already imported under that name in `Inspector.tsx`, alias it (as shown above, `t as localizeLabel`) rather than renaming the shared export.

- [ ] **Step 7: Manual verification**

Run `npm run dev:worker`/`npm run dev`, open a Content Flow, add an "X Content Action" node, confirm Operation/Prompt/Provider/Target Platform/Target Account all render and the Provider dropdown only shows providers actually configured on `content`'s settings page (plus the always-present Default/None), confirm typing in the Prompt textarea and switching Provider persists via `updateNodeData` (flow marks itself "Unsaved").

- [ ] **Step 8: Commit**

```bash
git add flow/frontend/nodes/ActionNode.tsx flow/frontend/store/flow-editor.ts flow/frontend/components/Sidebar.tsx flow/frontend/components/Inspector.tsx flow/frontend/lib/api.ts
git commit -m "feat(flow): XContentActionInspector (operation/prompt/provider), rename aiRewritePublish to xContentAction throughout frontend"
```

---

## Task 10: `link` — `recordPublishedContent`'s `ref` shape

**Files:**
- Modify: `link/src/services/content.ts`
- Modify: `link/tests/services/content.test.ts`

**Interfaces:**
- Produces: `recordPublishedContent`'s `ref` parameter type changes from `{generatedFromContentId, skillId}` to `{generatedFromContentId, flowId}`. Consumed by Task 11.

- [ ] **Step 1: Update the existing test**

Find the `recordPublishedContent` test's `ref` argument and expected `raw_data` JSON — replace `{generatedFromContentId: "source-content-1", skillId: "punchy-social"}` with `{generatedFromContentId: "source-content-1", flowId: "flow-1"}` throughout that test.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/content.test.ts
```

Expected: FAIL — the method signature still types `ref` as `{generatedFromContentId, skillId}`.

- [ ] **Step 3: Update the method signature in `link/src/services/content.ts`**

Find:

```ts
  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; skillId: string }
  ): Promise<void> {
```

Replace with:

```ts
  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; flowId: string }
  ): Promise<void> {
```

(The method body is unchanged — it already just does `JSON.stringify(ref)`, agnostic to the ref's exact keys.)

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/services/content.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: `src/routes-internal.ts` now shows a type error (still passes `skillId` — Task 11 fixes it). No other new errors.

- [ ] **Step 6: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "feat(link): recordPublishedContent's ref references flowId instead of skillId"
```

---

## Task 11: `link` — real `/internal/content/create-post` handler

**Files:**
- Modify: `link/src/routes-internal.ts`
- Modify: `link/tests/services/routes-internal-content.test.ts`

**Interfaces:**
- Consumes: `content`'s simplified `/internal/generate` (Task 5), `recordPublishedContent`'s new `ref` shape (Task 10).
- Produces: `POST /internal/content/create-post` replacing `/internal/content/ai-rewrite-publish` — no more tenant-D1 content-row query; `provider: "none"` skips calling `content` entirely.

- [ ] **Step 1: Rewrite the relevant tests in `link/tests/services/routes-internal-content.test.ts`**

Replace every test that POSTs to `/internal/content/ai-rewrite-publish` with `/internal/content/create-post`, using the new body shape `{contentId, interpolatedPrompt, provider, targetChannelId, flowId}` (no `sourceChannelId`, no `skillId`). Remove the "missing source content row" test entirely (there's no longer a content-row lookup in this handler). Add a new test for `provider: "none"`:

```ts
  it("posts the interpolated prompt as-is when provider is 'none', without calling content's /internal/generate", async () => {
    await env.LINK_DB.prepare(`DELETE FROM channels WHERE id = 'tgt-chan-none'`).run();
    await env.LINK_DB.prepare(
      `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, is_active, created_at, updated_at)
       VALUES ('tgt-chan-none', 'X', ?, 'x-user-none', 1, 1, datetime('now'), datetime('now'))`
    ).bind(JSON.stringify({ x_user_id: "x-user-none", access_token: "tok", refresh_token: null })).run();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-none-1", text: "plain text post" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", interpolatedPrompt: "plain text post", provider: "none", targetChannelId: "tgt-chan-none" }),
      }),
      testEnv
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the X call, no /internal/generate call
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("api.x.com");
    vi.unstubAllGlobals();
  });
```

Update the "generates, posts to X, and records" test to send a request body of `{contentId: "content-1", interpolatedPrompt: "...", provider: "default", targetChannelId: "tgt-chan", flowId: "flow-1"}` (not `skillId`/`sourceChannelId`), and update its argument-correctness assertion on the recorded `raw_data` JSON to expect `{generatedFromContentId: "content-1", flowId: "flow-1"}` instead of the old `{generatedFromContentId, skillId}` shape.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/routes-internal-content.test.ts
```

Expected: FAIL — the route is still `/content/ai-rewrite-publish` with the old body/logic.

- [ ] **Step 3: Rewrite the handler in `link/src/routes-internal.ts`**

Find the entire `router.post("/content/ai-rewrite-publish", ...)` handler (from the comment above it through its closing `});`) and replace with:

```ts
  // Real X publish path: content's generated (or literal, for provider:"none") text gets
  // posted to the target channel. TikTok publish is out of scope this phase (see design
  // spec's non-goals) — targetChannelId resolving to a TIKTOK channel_type falls through
  // to the generic ok:false path below.
  router.post("/content/create-post", async (c) => {
    const { contentId, interpolatedPrompt, provider, targetChannelId, flowId } = await c.req.json<{
      contentId: string; interpolatedPrompt: string; provider: "default" | "openai" | "anthropic" | "none"; targetChannelId: string; flowId?: string | null;
    }>();

    const targetChannel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(targetChannelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!targetChannel) return c.json({ ok: false }, 200);

    if (targetChannel.channel_type !== "X") {
      console.log(JSON.stringify({ event: "create_post_unsupported_platform", contentId, targetChannelId, channelType: targetChannel.channel_type }));
      return c.json({ ok: false }, 200);
    }

    let text = interpolatedPrompt;
    if (provider !== "none") {
      const genRes = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId: targetChannel.tenant_id, prompt: interpolatedPrompt, provider }),
      });
      if (!genRes.ok) {
        console.error(JSON.stringify({ event: "create_post_generate_failed", contentId, targetChannelId, provider, status: genRes.status }));
        return c.json({ ok: false }, 200);
      }
      const generated = await genRes.json<{ text: string }>();
      text = generated.text;
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(targetChannel.tenant_id).first<{ d1_database_id: string | null }>();
    if (!tenantRow?.d1_database_id) return c.json({ ok: false }, 200);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(targetChannelId);
    const postResult = await createPost(accessToken, text);

    console.log(JSON.stringify({ event: "create_post_x_post", contentId, targetChannelId, provider, ok: postResult.ok, rateLimited: !!postResult.rateLimited }));

    if (postResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!postResult.ok || !postResult.id) {
      return c.json({ ok: false }, 200);
    }

    const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, targetChannel.tenant_id);
    await contentService.recordPublishedContent(targetChannelId, "X", postResult.id, text, {
      generatedFromContentId: contentId,
      flowId: flowId || "",
    });

    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/services/routes-internal-content.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + full regression run**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
npx vitest run
```

Expected: no new errors, all tests pass (`/x/repost` stub and every other route in this file untouched).

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts
git commit -m "feat(link): real create-post handler (no source-content query, provider:none skips generate)"
```

---

## Task 12: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run every module's full test suite**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run
cd ../flow && npx vitest run
cd ../link && npx vitest run
```

Expected: all pass, zero failures.

- [ ] **Step 2: Typecheck all three modules**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npm run typecheck 2>&1 | grep -v "shared/frontend"
cd ../flow && npm run typecheck 2>&1 | grep -v "shared/frontend"
cd ../link && npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: clean beyond the pre-existing `shared/frontend` react-types baseline noise.

- [ ] **Step 3: Apply the new D1 migration to the remote dev database**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && wrangler d1 migrations apply uniscrm-content-dev --env dev --remote
```

- [ ] **Step 4: Build and deploy all three workers**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vite build --mode development && wrangler deploy --env dev
cd ../link && npx vite build --mode development && wrangler deploy --env dev
cd ../flow && npx vite build --mode development && wrangler deploy --env dev
```

(Or push to `origin/main` and let CI deploy, if GitHub Actions billing is resolved by the time this runs — check `gh run list --workflow=deploy-dev.yml --limit 1` first.)

- [ ] **Step 5: Browser verification** (real logged-in session via `tabs_context_mcp`, per project convention)

1. `content-dev.uni-scrm.com` — confirm the settings page shows two provider cards (OpenAI, Anthropic), both "Not connected" initially; connect one with a test key + model, confirm it flips to "connected" and shows the model; disconnect it, confirm it flips back.
2. `flow-dev.uni-scrm.com` — open a Content Flow, add/edit an "X Content Action" node, confirm Operation (Create Post), Prompt (multi-line, accepts `$content.xxx`), Provider (shows Default + None + only actually-configured providers), Target Platform, Target Account all work and persist.
3. Confirm the flow's success/failed branches still render (unchanged from before — this plan didn't touch branch-handle rendering).

- [ ] **Step 6: Report completion** only once Steps 1-5 all pass.
