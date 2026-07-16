# Content Settings: Live Model Selection + Visual Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a real bug where a tenant's saved BYOK model choice is silently ignored at generation time; replace the `content` module's hardcoded, staleness-prone model dropdowns with live-fetched model lists per provider (including a new "Default" card for Cloudflare Workers AI); bring the settings page's cards to visual parity with `link`'s `ChannelCard` usage (real logos, connection dates, consistent button styling).

**Architecture:** `content`'s `generate.ts`/provider classes gain a `model` parameter that's actually threaded through (today it's fetched from storage and dropped on the floor). A new `model-catalog.ts` service calls each provider's own live model-list API — OpenAI's and Anthropic's `GET /v1/models` with the tenant's freshly-typed key, and Cloudflare's account-level `GET /accounts/{id}/ai/models/search` for Workers AI — behind one new `POST /api/llm-models` route. `tenant_llm_credentials` gains a nullable `encrypted_api_key` column so a `provider: "default"` row can persist a chosen Workers AI model without ever needing a key. The settings page becomes a 3-card grid (OpenAI, Anthropic, Default), all still built on the existing `ChannelCard` component, now with real icons, a `Connected {date}` line, and a full-width actions footer matching `link`'s channel cards.

**Tech Stack:** Cloudflare Workers (Hono), D1, `uniscrm-byok` encryption, React, `lucide-react` (already resolvable from `content/frontend` via the repo-root hoisted `node_modules` — confirmed, no new dependency needed), Tailwind (via `shared/frontend/ui`).

## Global Constraints

- Every file touched lives under `content/` (no `flow`/`link` changes — this plan doesn't touch the flow node's Provider dropdown, which already correctly shows `default`/configured-BYOK/`none` and is out of scope here).
- No silent fallback for BYOK providers: if `openai`/`anthropic` credentials are missing, `generateContent` must keep throwing (unchanged behavior from the prior plan) — this plan only fixes the ignored `model` field, it does not relax that rule.
- `default` (Workers AI) never requires an API key, before or after this plan.
- Destructive dev migrations remain acceptable for `tenant_llm_credentials` — dev has no real tenant data (same precedent as the prior plan's `0002` migration).
- The live model-list feature must degrade gracefully: a fetch failure (bad key, network error, unexpected response shape) must never crash the settings page or block Connect/Save — fall back to letting the user type a model id by hand.
- `content`'s Cloudflare account-level API call (`ai/models/search`) requires a new `CF_ACCOUNT_ID` var and a new `CF_API_TOKEN` secret in `content`'s Worker — **provisioning that secret is a manual, out-of-band step the user performs in the Cloudflare dashboard** (broadening the scope of the existing `CF_D1_API_TOKEN` used by `link`/other modules, then handing the value to be set via `wrangler secret put CF_API_TOKEN`). Task 3's code must work correctly once that secret exists; Task 5's full deployment verification is blocked on it and should say so plainly rather than skipping silently.
- Do not reproduce exact copyrighted brand logo artwork for OpenAI/Anthropic from memory — use clearly-labeled `lucide-react` icons with distinct brand-ish accent colors instead (same spirit as `link/frontend/lib/channelLogos.tsx`'s pattern of one small icon component per provider, but using library icons here rather than hand-drawn brand marks, since exact path data for these specific logos isn't something to guess at).
- `listConfiguredProviders` MUST stay BYOK-only (`openai`/`anthropic`, never `"default"`). It has an existing consumer outside this plan's file list: the already-shipped `flow/frontend/components/Inspector.tsx` (line ~538) maps this exact list with a two-branch `p.provider === "openai" ? "OpenAI" : "Anthropic"` ternary and separately hardcodes its own `default`/`none` options. If a `"default"` row ever appeared in this list's output, that Inspector would render a duplicate, mislabeled `value="default"` option — a real regression in already-deployed, already-working code. `default`'s model must be surfaced to the settings page through a **separate** field (`defaultModel`, composed by the GET route, not by broadening the service function) so `flow`'s existing contract with this endpoint is never touched. Confirmed via grep: `flow/src/index.ts`'s `/api/llm-providers` proxy forwards `content`'s response `text()` verbatim, so adding a new top-level field is inert there; no other consumer of `listConfiguredProviders` or `GET /api/llm-credentials` exists in the repo.

---

### Task 1: Fix the ignored `model` field (bug fix, ships independently)

**Files:**
- Modify: `content/src/providers/interface.ts`
- Modify: `content/src/providers/openai.ts`
- Modify: `content/src/providers/anthropic.ts`
- Modify: `content/src/services/generate.ts`
- Modify: `content/tests/providers/openai.test.ts`
- Modify: `content/tests/providers/anthropic.test.ts`
- Modify: `content/tests/generate.test.ts`

**Context:** Today, `generate.ts` calls `getTenantLlmCredentials` (which returns `{apiKey, model}`), but then constructs `OpenAiProvider(credentials.apiKey)` / `AnthropicProvider(credentials.apiKey)` — the `model` field is fetched and then dropped. Both provider classes hardcode their own `MODEL` constant internally. So a tenant who picks `gpt-4o` in Settings still always gets `gpt-4o-mini` at generation time. This task makes `model` a real parameter, threaded end to end.

**Interfaces:**
- Produces: `LlmProvider.generate(prompt: string, model: string): Promise<string>` — the new interface signature every provider class implements. `WorkersAiProvider` is touched in Task 2 (its default-model lookup needs the schema from that task first) — for this task, only update its call site in `generate.ts` to pass the existing hardcoded constant positionally, keeping `WorkersAiProvider.generate`'s own signature a one-arg `generate(prompt)` for now (Task 2 changes it).

- [ ] **Step 1: Update the failing tests first**

In `content/tests/providers/openai.test.ts`, change the call `provider.generate("user prompt")` to `provider.generate("user prompt", "gpt-4o")` in the first test, and add an assertion that the request body's `model` field reflects the passed-in model:

```ts
  it("calls the chat completions endpoint with the given key, prompt, and model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiProvider("sk-test");
    const text = await provider.generate("user prompt", "gpt-4o");

    expect(text).toBe("generated text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });
```

The second test (`"throws with the response body on a non-ok response"`) just needs its `provider.generate("u")` call updated to `provider.generate("u", "gpt-4o-mini")`.

Do the same in `content/tests/providers/anthropic.test.ts` — same two changes, adding a `model` argument and asserting `body.model` reflects it.

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/providers/openai.test.ts tests/providers/anthropic.test.ts
```

Expected: FAIL — `generate` still only takes one argument, and the request bodies still hardcode `MODEL`.

- [ ] **Step 3: Update the interface**

`content/src/providers/interface.ts`:

```ts
export interface LlmProvider {
  generate(prompt: string, model: string): Promise<string>;
}
```

- [ ] **Step 4: Update `openai.ts`**

Remove the module-level `const MODEL = "gpt-4o-mini";` and change the method signature and body:

```ts
import type { LlmProvider } from "./interface";

export class OpenAiProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0].message.content;
  }
}
```

- [ ] **Step 5: Update `anthropic.ts`**

Same pattern — remove `const MODEL = "claude-3-5-haiku-latest";`, add a `model` parameter, use it in the request body:

```ts
import type { LlmProvider } from "./interface";

export class AnthropicProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { content: { type: string; text: string }[] };
    return body.content[0].text;
  }
}
```

- [ ] **Step 6: Update `generate.ts`'s BYOK branch to pass `credentials.model`**

Find:

```ts
  const provider: LlmProvider =
    params.provider === "openai"
      ? new OpenAiProvider(credentials.apiKey)
      : new AnthropicProvider(credentials.apiKey);

  return provider.generate(params.prompt);
```

Replace with:

```ts
  const provider: LlmProvider =
    params.provider === "openai"
      ? new OpenAiProvider(credentials.apiKey)
      : new AnthropicProvider(credentials.apiKey);

  return provider.generate(params.prompt, credentials.model);
```

(The `params.provider === "default"` branch above this in the file is untouched by this task — Task 2 changes it.)

- [ ] **Step 7: Update `generate.test.ts`'s BYOK assertions**

In the `"uses the tenant's OpenAI BYOK credentials"` test, add an assertion that the request body's model matches the mocked credentials' `model` field:

```ts
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o-mini");
```

Same addition in the `"uses the tenant's Anthropic BYOK credentials"` test, asserting `body.model === "claude-3-5-haiku-latest"`.

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run tests/providers/openai.test.ts tests/providers/anthropic.test.ts tests/generate.test.ts
```

Expected: PASS (the `"uses Workers AI for provider: 'default'"` test is untouched by this task and should still pass unchanged).

- [ ] **Step 9: Commit**

```bash
git add content/src/providers/interface.ts content/src/providers/openai.ts content/src/providers/anthropic.ts content/src/services/generate.ts content/tests/providers/openai.test.ts content/tests/providers/anthropic.test.ts content/tests/generate.test.ts
git commit -m "fix(content): thread the tenant's saved model choice into BYOK generate calls

Previously fetched from storage and silently dropped -- every OpenAI/Anthropic
BYOK call always used the provider class's own hardcoded model regardless of
what the tenant picked in Settings."
```

---

### Task 2: Nullable API key + persisted `default` model + `createdAt`

**Files:**
- Create: `content/migrations/0003_nullable_api_key_for_default_provider.sql`
- Modify: `content/src/services/llm-credentials.ts`
- Modify: `content/src/providers/workers-ai.ts`
- Modify: `content/src/services/generate.ts`
- Modify: `content/tests/llm-credentials.test.ts`
- Modify: `content/tests/generate.test.ts`
- Modify: `content/tests/providers/workers-ai.test.ts`
- Modify: `content/tests/routes-api.test.ts`

**Context:** Today `tenant_llm_credentials.encrypted_api_key` is `NOT NULL`, so there's no way to persist a per-tenant model choice for `provider: "default"` (Workers AI never has an API key). This task makes the column nullable and lets a `provider: "default"` row exist with `encrypted_api_key = NULL`, storing only a model choice. `generateContent`'s `"default"` branch starts reading that stored choice (falling back to the existing hardcoded model if the tenant never set one, so nothing breaks for tenants who haven't touched this yet).

**`listConfiguredProviders` stays BYOK-only** (see this plan's Global Constraints) — it must keep excluding `"default"` rows so `flow`'s already-shipped Inspector (an out-of-plan consumer) never sees one. `content/tests/routes-api.test.ts`'s existing GET assertions also need updating in this task: they use `toEqual` for the exact response shape, and adding `createdAt` per entry breaks that exact match immediately (this must be fixed here, in Task 2, not left to surface as a mystery failure in Task 5's full suite run).

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `getDefaultModel(env, tenantId): Promise<string>` and `setDefaultModel(env, tenantId, model): Promise<void>`, both exported from `llm-credentials.ts`. `listConfiguredProviders`'s return type gains `createdAt: string` per entry, still filtered to `openai`/`anthropic` only — consumed by Task 4's frontend and by Task 4's GET route change (which adds a separate top-level `defaultModel` field, not by broadening this function). `WorkersAiProvider.generate(prompt: string, model: string): Promise<string>` — consumed by Task 3/4 only incidentally; `generate.ts` is the only caller changed in this task.

- [ ] **Step 1: Write the new migration**

`content/migrations/0003_nullable_api_key_for_default_provider.sql`:

```sql
DROP TABLE IF EXISTS tenant_llm_credentials;
CREATE TABLE tenant_llm_credentials (
  tenant_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider)
);
```

(Destructive — acceptable per this plan's Global Constraints, same as the prior `0002` migration. `encrypted_api_key` drops `NOT NULL`; everything else is unchanged.)

- [ ] **Step 2: Update `content/tests/llm-credentials.test.ts`'s schema-setup and add failing tests**

Update the `beforeEach`'s `CREATE TABLE IF NOT EXISTS` statement to match the new nullable column (`encrypted_api_key TEXT,` instead of `encrypted_api_key TEXT NOT NULL,`).

Add these new tests at the end of the `describe` block:

```ts
  it("getDefaultModel returns the hardcoded fallback when the tenant never set one", async () => {
    expect(await getDefaultModel(testEnv as any, 42)).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("setDefaultModel persists a model choice with no API key, getDefaultModel returns it", async () => {
    await setDefaultModel(testEnv as any, 42, "@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(await getDefaultModel(testEnv as any, 42)).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");

    const row = await env.CONTENT_DB.prepare(
      `SELECT encrypted_api_key FROM tenant_llm_credentials WHERE tenant_id = 42 AND provider = 'default'`
    ).first<{ encrypted_api_key: string | null }>();
    expect(row?.encrypted_api_key).toBeNull();
  });

  it("listConfiguredProviders excludes 'default' even when a default model is set, and includes createdAt for openai/anthropic", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-openai", "gpt-4o-mini");
    await setDefaultModel(testEnv as any, 42, "@cf/meta/llama-4-scout-17b-16e-instruct");
    const list = await listConfiguredProviders(testEnv as any, 42);
    expect(list.find((p) => p.provider === "default")).toBeUndefined();
    expect(list).toEqual([{ provider: "openai", model: "gpt-4o-mini", createdAt: expect.any(String) }]);
  });
```

(This is the critical regression guard for this task: `flow/frontend/components/Inspector.tsx` — outside this plan's scope, already shipped — maps this exact list assuming it only ever contains `openai`/`anthropic`. If `listConfiguredProviders` ever started returning a `"default"` row, that Inspector would render a duplicate, mislabeled provider option. This test exists specifically to catch that regression, not just to describe current behavior.)

Add `getDefaultModel, setDefaultModel` to the existing import from `../src/services/llm-credentials`.

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/llm-credentials.test.ts
```

Expected: FAIL — `getDefaultModel`/`setDefaultModel` don't exist yet, and `listConfiguredProviders` doesn't select `created_at`.

- [ ] **Step 4: Rewrite `llm-credentials.ts`**

```ts
import type { Env } from "../types";
import { encrypt, decrypt } from "./crypto";

export type LlmProviderName = "openai" | "anthropic";

export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

export async function getDefaultModel(env: Env, tenantId: number): Promise<string> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT model FROM tenant_llm_credentials WHERE tenant_id = ? AND provider = 'default'"
  ).bind(tenantId).first<{ model: string }>();
  return row?.model ?? DEFAULT_WORKERS_AI_MODEL;
}

export async function setDefaultModel(env: Env, tenantId: number, model: string): Promise<void> {
  const now = new Date().toISOString();
  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, model, created_at, updated_at)
     VALUES (?, 'default', NULL, ?, ?, ?)
     ON CONFLICT(tenant_id, provider) DO UPDATE SET
       model = excluded.model,
       updated_at = excluded.updated_at`
  ).bind(tenantId, model, now, now).run();
}

export async function listConfiguredProviders(
  env: Env,
  tenantId: number
): Promise<{ provider: string; model: string; createdAt: string }[]> {
  // Deliberately excludes provider = 'default': flow/frontend/components/Inspector.tsx
  // (outside this plan's scope, already shipped) maps this exact list assuming it only
  // ever contains BYOK providers (openai/anthropic) -- see this plan's Global Constraints.
  const rows = await env.CONTENT_DB.prepare(
    "SELECT provider, model, created_at FROM tenant_llm_credentials WHERE tenant_id = ? AND provider != 'default'"
  ).bind(tenantId).all<{ provider: string; model: string; created_at: string }>();
  return rows.results.map((r) => ({ provider: r.provider, model: r.model, createdAt: r.created_at }));
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

(`LlmProviderName` stays `"openai" | "anthropic"` — it's used for BYOK-only functions. `"default"` is handled by its own dedicated `getDefaultModel`/`setDefaultModel` pair rather than being folded into `LlmProviderName`, since it never takes an `apiKey` and shouldn't type-check as if it could.)

- [ ] **Step 5: Update `content/src/providers/workers-ai.ts` to accept a `model` parameter**

```ts
import type { LlmProvider } from "./interface";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<string> {
    const result = (await this.ai.run(model, {
      messages: [{ role: "user", content: prompt }],
      stream: false,
    })) as { response: string };
    return result.response;
  }
}
```

- [ ] **Step 6: Update `content/tests/providers/workers-ai.test.ts`**

Find the existing test(s) calling `provider.generate("prompt")` (single argument) and update to pass a model explicitly, e.g. `provider.generate("prompt", "@cf/meta/llama-3.3-70b-instruct-fp8-fast")`, and assert `this.ai.run` was called with that exact model string as its first argument (adjust the existing assertion's expected model literal to come from the test's own variable rather than a separately-hardcoded string, so the test can't silently drift from what's actually passed).

- [ ] **Step 7: Update `generate.ts`'s `"default"` branch**

Find:

```ts
import * as credentialsModule from "./llm-credentials";

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  if (params.provider === "default") {
    return new WorkersAiProvider(env.AI).generate(params.prompt);
  }
```

Replace with:

```ts
import * as credentialsModule from "./llm-credentials";

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  if (params.provider === "default") {
    const model = await credentialsModule.getDefaultModel(env, params.tenantId);
    return new WorkersAiProvider(env.AI).generate(params.prompt, model);
  }
```

- [ ] **Step 8: Update `generate.test.ts`'s `"default"` test**

The existing test mocks `env` as `{ AI: { run: aiRun } }` with no `CONTENT_DB` — `getDefaultModel` now queries `CONTENT_DB`, so the mock needs one. Update:

```ts
  it("uses Workers AI for provider: 'default', falling back to the hardcoded model when the tenant never set one", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const text = await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, baseParams);
    expect(text).toBe("punchy text");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      expect.objectContaining({ messages: expect.arrayContaining([{ role: "user", content: baseParams.prompt }]) })
    );
  });

  it("uses the tenant's stored default-model choice for provider: 'default' when one is set", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => ({ model: "@cf/meta/llama-4-scout-17b-16e-instruct" }) }) }) };
    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, baseParams);
    expect(aiRun).toHaveBeenCalledWith("@cf/meta/llama-4-scout-17b-16e-instruct", expect.anything());
  });
```

(Replaces the old single `"uses Workers AI for provider: 'default'"` test with these two.)

- [ ] **Step 9: Update `content/tests/routes-api.test.ts`'s GET assertions for the new `createdAt` field**

This task adds `createdAt` to every `listConfiguredProviders` entry, which breaks this file's two existing `toEqual` assertions on the exact GET response shape. Update:

The `"GET returns an empty list when authed but nothing configured"` test's assertion stays `{ providers: [] }` (unaffected — no entries to have a `createdAt`).

The `"PUT saves a provider, GET lists it (with model, never the key)"` test's final assertion:

```ts
    expect(await getRes.json()).toEqual({ providers: [{ provider: "openai", model: "gpt-4o-mini" }] });
```

becomes:

```ts
    expect(await getRes.json()).toEqual({ providers: [{ provider: "openai", model: "gpt-4o-mini", createdAt: expect.any(String) }] });
```

Also update this file's `beforeAll` schema-setup `CREATE TABLE IF NOT EXISTS` statement to match the new nullable column (`encrypted_api_key TEXT,` instead of `encrypted_api_key TEXT NOT NULL,`), same change as Step 2 made in `llm-credentials.test.ts`.

- [ ] **Step 10: Run all affected tests**

```bash
npx vitest run tests/llm-credentials.test.ts tests/generate.test.ts tests/providers/workers-ai.test.ts tests/routes-api.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add content/migrations/0003_nullable_api_key_for_default_provider.sql content/src/services/llm-credentials.ts content/src/providers/workers-ai.ts content/src/services/generate.ts content/tests/llm-credentials.test.ts content/tests/generate.test.ts content/tests/providers/workers-ai.test.ts content/tests/routes-api.test.ts
git commit -m "feat(content): persist a per-tenant default-provider model choice

tenant_llm_credentials.encrypted_api_key becomes nullable so a provider:
'default' row can store a chosen Workers AI model with no API key. Falls
back to the existing hardcoded model when a tenant never sets one."
```

---

### Task 3: Live model-catalog service + `/api/llm-models` route

**Files:**
- Create: `content/src/services/model-catalog.ts`
- Create: `content/tests/model-catalog.test.ts`
- Modify: `content/src/types.ts`
- Modify: `content/src/index.ts`
- Modify: `content/wrangler.toml`
- Create: `content/tests/routes-api-models.test.ts`

**Context:** Replaces the hardcoded `PROVIDER_MODELS` list (currently only in the frontend, deleted in Task 4) with live calls to each provider's own model-list API. OpenAI's `/v1/models` returns an untyped superset (chat models, embeddings, whisper, tts, dall-e, moderation, deprecated snapshots) with no capability field — this task applies a best-effort prefix/keyword filter to approximate "chat-capable text models," which is inherently a heuristic and may need periodic revisiting (this is called out explicitly rather than presented as a perfect solution). Anthropic's `/v1/models` is clean (chat models only). Cloudflare's `ai/models/search` supports a `task` filter for text-generation models specifically.

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly (this is a new, independent read path) other than reusing `Env`.
- Produces: `listOpenAiModels(apiKey: string): Promise<string[]>`, `listAnthropicModels(apiKey: string): Promise<string[]>`, `listWorkersAiModels(env: Env): Promise<string[]>`, all exported from `content/src/services/model-catalog.ts`. `POST /api/llm-models` route, body `{ provider: "openai" | "anthropic" | "default"; apiKey?: string }` → `{ models: string[] }` on success, `{ error: string }` with a non-2xx status on failure. Consumed by Task 4's frontend.

- [ ] **Step 1: Write the failing tests**

`content/tests/model-catalog.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { listOpenAiModels, listAnthropicModels, listWorkersAiModels } from "../src/services/model-catalog";

describe("model-catalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("listOpenAiModels", () => {
    it("fetches with the given key and filters to chat-capable models, sorted", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          data: [
            { id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o1-mini" },
            { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "dall-e-3" },
            { id: "tts-1" }, { id: "text-moderation-latest" },
          ],
        }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listOpenAiModels("sk-test");

      expect(models).toEqual(["gpt-4o", "gpt-4o-mini", "o1-mini"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.headers.Authorization).toBe("Bearer sk-test");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
      await expect(listOpenAiModels("sk-bad")).rejects.toThrow(/OpenAI models list failed: 401/);
    });
  });

  describe("listAnthropicModels", () => {
    it("fetches with the given key and returns sorted ids", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-latest" }, { id: "claude-3-5-haiku-latest" }] }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listAnthropicModels("sk-ant-test");

      expect(models).toEqual(["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
      await expect(listAnthropicModels("sk-bad")).rejects.toThrow(/Anthropic models list failed: 401/);
    });
  });

  describe("listWorkersAiModels", () => {
    it("fetches the account's text-generation model catalog using CF_ACCOUNT_ID + CF_API_TOKEN", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          result: [
            { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", task: { name: "Text Generation" } },
            { name: "@cf/meta/llama-4-scout-17b-16e-instruct", task: { name: "Text Generation" } },
            { name: "@cf/openai/whisper", task: { name: "Automatic Speech Recognition" } },
          ],
        }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listWorkersAiModels({ CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token" } as any);

      expect(models).toEqual(["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/accounts/acct-1/ai/models/search");
      expect(init.headers.Authorization).toBe("Bearer cf-token");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
      await expect(listWorkersAiModels({ CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "bad" } as any)).rejects.toThrow(/Workers AI models list failed: 403/);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run tests/model-catalog.test.ts
```

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `content/src/services/model-catalog.ts`**

```ts
import type { Env } from "../types";

const NON_CHAT_KEYWORDS = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|davinci|babbage|search)/i;
const CHAT_ID_PREFIX = /^(gpt-|o[0-9]|chatgpt)/i;

export async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data
    .map((m) => m.id)
    .filter((id) => CHAT_ID_PREFIX.test(id) && !NON_CHAT_KEYWORDS.test(id))
    .sort();
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id).sort();
}

export async function listWorkersAiModels(env: Env): Promise<string[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?task=Text%20Generation`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Workers AI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { name: string; task?: { name: string } }[] };
  return body.result
    .filter((m) => !m.task || /text generation/i.test(m.task.name))
    .map((m) => m.name)
    .sort();
}
```

**Note for the implementer:** the exact response shape of Cloudflare's `ai/models/search` endpoint (field names `name`/`task.name` above) should be double-checked against current Cloudflare API docs during implementation — treat this as a best-effort first pass, not a verified contract. If the real shape differs, adjust the parsing accordingly; the calling route (Step 5) already treats any thrown error as a soft failure the frontend falls back gracefully from, so getting this slightly wrong is not catastrophic, but it's worth a quick doc check rather than shipping unverified.

- [ ] **Step 4: Add `CF_ACCOUNT_ID` / `CF_API_TOKEN` to `content/src/types.ts`**

```ts
export interface Env {
  CONTENT_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  INTERNAL_SECRET: string;
  ENCRYPTION_KEY: { get(): Promise<string> };
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
}
```

- [ ] **Step 5: Add the route in `content/src/index.ts`**

Add the import:

```ts
import { listOpenAiModels, listAnthropicModels, listWorkersAiModels } from "./services/model-catalog";
```

Add the route (inside the `sessionAuth`-protected group — place it near the other `/api/llm-credentials` routes, reusing the existing `/api/llm-credentials/*` `sessionAuth` middleware registration is NOT applicable here since this is a different path; add its own middleware registration following the same "the bare path IS covered, no `/*` needed unless there's a sub-path" pattern already established):

```ts
app.use("/api/llm-models", sessionAuth);

app.post("/api/llm-models", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey } = await c.req.json<{ provider: "openai" | "anthropic" | "default"; apiKey?: string }>();

  try {
    if (provider === "default") {
      return c.json({ models: await listWorkersAiModels(c.env) });
    }
    if (!apiKey) return c.json({ error: "apiKey required for this provider" }, 400);
    const models = provider === "openai" ? await listOpenAiModels(apiKey) : await listAnthropicModels(apiKey);
    return c.json({ models });
  } catch (err) {
    console.error(JSON.stringify({ event: "llm_models_list_failed", tenantId, provider, error: String(err) }));
    return c.json({ error: "Could not fetch model list" }, 502);
  }
});
```

(`tenantId` isn't used in the OpenAI/Anthropic branches — the request is scoped by session auth for access control, not because the model list itself is tenant-specific for those two providers. It's kept in the log line for traceability.)

- [ ] **Step 6: Write `content/tests/routes-api-models.test.ts`**

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("POST /api/llm-models", () => {
  afterEach(() => vi.unstubAllGlobals());

  function authedFetchMock(modelsResponse: Response) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/auth/me")) {
        return Promise.resolve(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "90" } }), { status: 200 }));
      }
      return Promise.resolve(modelsResponse);
    });
  }

  it("returns 401 when the session check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=bad", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-x" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when apiKey is missing for openai/anthropic", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response("unused", { status: 200 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai" }),
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("returns models on a successful openai fetch", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-x" }),
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["gpt-4o"] });
  });

  it("returns 502 with an error message when the upstream fetch throws", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response("bad key", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-bad" }),
      }),
      env
    );
    expect(res.status).toBe(502);
    expect((await res.json() as any).error).toBeTruthy();
  });

  it("does not require apiKey for provider: 'default'", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response(JSON.stringify({ result: [{ name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", task: { name: "Text Generation" } }] }), { status: 200 })));
    const testEnv = { ...env, CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token" };
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] });
  });
});
```

- [ ] **Step 7: Add `CF_ACCOUNT_ID` to `content/wrangler.toml`**

Add to both `[env.dev.vars]` and `[env.production.vars]` (plaintext, non-secret, same value already used by `link`):

```toml
CF_ACCOUNT_ID = "b34f3ff4aec4c36584672d5bf1320757"
```

`CF_API_TOKEN` is a `wrangler secret` (like `link`'s `CF_D1_API_TOKEN`) — it does not appear in `wrangler.toml`. Note in a code comment near the new route or in the commit message that deploying this to a live environment requires running `wrangler secret put CF_API_TOKEN --env dev` (and `--env production`) once the token value is available — this plan's Task 5 tracks that as a blocking prerequisite for full deployment, not something to skip silently.

- [ ] **Step 8: Run all new/affected tests**

```bash
npx vitest run tests/model-catalog.test.ts tests/routes-api-models.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add content/src/services/model-catalog.ts content/tests/model-catalog.test.ts content/src/types.ts content/src/index.ts content/wrangler.toml content/tests/routes-api-models.test.ts
git commit -m "feat(content): live model-list fetching for openai/anthropic/default

New POST /api/llm-models proxies each provider's own model-list API
(OpenAI/Anthropic's /v1/models with the tenant's key, Cloudflare's
ai/models/search for Workers AI) instead of a hardcoded, staleness-prone
list. Requires new CF_ACCOUNT_ID var + CF_API_TOKEN secret (not yet
provisioned in dev/production -- see Task 5)."
```

---

### Task 4: Settings page visual overhaul + dynamic model dropdowns

**Files:**
- Create: `content/frontend/lib/providerLogos.tsx`
- Modify: `content/frontend/lib/api.ts`
- Modify: `content/frontend/pages/SettingsPage.tsx`
- Modify: `content/src/index.ts`
- Modify: `content/tests/routes-api.test.ts`

**Context:** Brings the 2-card (OpenAI/Anthropic) settings page to visual parity with `link`'s `ChannelCard` usage and adds a third card for `default` (previously invisible/unconfigurable). Replaces the hardcoded `PROVIDER_MODELS` dropdown with a live fetch via Task 3's new route, with a graceful manual-text-input fallback on fetch failure.

No test file for the frontend piece of this task — this codebase has no frontend component-test framework (established convention from the prior plan's Task 9); verification is Task 5's browser check. The backend route change (Step 1) does get a test update, since it changes an exact-match response shape.

**Interfaces:**
- Consumes: `POST /api/llm-models` (Task 3), `listConfiguredProviders`'s `createdAt` field (Task 2), `getDefaultModel`/`setDefaultModel` (Task 2).
- Produces: `GET /api/llm-credentials`'s response shape changes from `{ providers }` to `{ providers, defaultModel }` — per this plan's Global Constraints, `providers` itself stays BYOK-only (`listConfiguredProviders` is not broadened); `defaultModel` is a new, separate top-level field composed by this route. Consumed by Step 4's `SettingsPage.tsx` (its `default` card reads `defaultModel`, not a `providers.find(...)` lookup) and inert for `flow`'s existing `/api/llm-providers` proxy (confirmed via grep in this plan's Global Constraints — it forwards the raw response body regardless of shape).

- [ ] **Step 1: Add a `default` PUT path and a `defaultModel` field on GET, in `content/src/index.ts`**

Find the existing GET and PUT handlers:

```ts
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
```

Replace with:

```ts
app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers = await listConfiguredProviders(c.env, tenantId);
  const defaultModel = await getDefaultModel(c.env, tenantId);
  return c.json({ providers, defaultModel });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model } = await c.req.json<{ provider: "openai" | "anthropic" | "default"; apiKey?: string; model: string }>();
  if (!provider || !model) return c.json({ error: "provider, model required" }, 400);
  if (provider === "default") {
    await setDefaultModel(c.env, tenantId, model);
    return c.json({ ok: true });
  }
  if (!apiKey) return c.json({ error: "apiKey required for this provider" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model);
  return c.json({ ok: true });
});
```

Add `getDefaultModel, setDefaultModel` to the existing import from `./services/llm-credentials`.

`DELETE /api/llm-credentials/:provider` is left untouched — `default` never has a "Disconnect" action in the frontend (there's nothing to disconnect, it's a free built-in model; the frontend only ever calls PUT for it).

**Update `content/tests/routes-api.test.ts` for the new `defaultModel` field** (another exact-match break, same reasoning as Task 2's Step 9 — fix it in the task that causes it, not in Task 5's full run):

- `"GET returns an empty list when authed but nothing configured"` test's assertion becomes `expect(await res.json()).toEqual({ providers: [], defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });`
- `"PUT saves a provider, GET lists it (with model, never the key)"` test's final assertion becomes `expect(await getRes.json()).toEqual({ providers: [{ provider: "openai", model: "gpt-4o-mini", createdAt: expect.any(String) }], defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });`

Run `npx vitest run tests/routes-api.test.ts` to confirm PASS before moving on.

- [ ] **Step 2: Write `content/frontend/lib/providerLogos.tsx`**

```tsx
// Small, distinctly-colored icon badges per provider. Deliberately not exact brand
// artwork (unverified from memory) -- lucide-react icons with a brand-ish accent
// color instead, same spirit as link/frontend/lib/channelLogos.tsx's one-icon-per-
// channel pattern.
import { Sparkles, Brain, Cloud } from "lucide-react";

export function OpenAiLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
      <Sparkles className="w-5 h-5" aria-label="OpenAI" />
    </div>
  );
}

export function AnthropicLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-orange-500/10 text-orange-600">
      <Brain className="w-5 h-5" aria-label="Anthropic" />
    </div>
  );
}

export function WorkersAiLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
      <Cloud className="w-5 h-5" aria-label="Cloudflare Workers AI" />
    </div>
  );
}
```

(`ChannelCard`'s own `logo` slot already wraps its child in a `w-10 h-10 rounded-xl ... [&>svg]:w-5 [&>svg]:h-5` container — these components render as the slot's full-bleed content rather than duplicating that wrapper, matching how `XLogo`/`TikTokLogo` are plain `<svg>` roots. Since these three are `<div>`-wrapped for the background tint, verify visually in Task 5 that they don't double up on sizing with `ChannelCard`'s wrapper; adjust the inner `w-5 h-5`/outer sizing if they look cramped or oversized next to the real `XLogo`/`TikTokLogo` cards.)

- [ ] **Step 3: Update `content/frontend/lib/api.ts`**

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

export type ProviderName = "openai" | "anthropic" | "default";

export interface ProviderCredentialInfo {
  // BYOK-only, matches listConfiguredProviders' contract (see this plan's Global
  // Constraints) -- "default" never appears in the `providers` array, it's carried
  // separately in `defaultModel` below.
  provider: "openai" | "anthropic";
  model: string;
  createdAt: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[]; defaultModel: string }> => request("/api/llm-credentials"),
    save: (provider: ProviderName, model: string, apiKey?: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
  llmModels: {
    list: (provider: ProviderName, apiKey?: string): Promise<{ models: string[] }> =>
      request("/api/llm-models", { method: "POST", body: JSON.stringify({ provider, apiKey }) }),
  },
};
```

(Note the `save` signature's argument order changes — `apiKey` moves to last and becomes optional, since `default` never has one. Step 4 updates the one call site.)

- [ ] **Step 4: Rewrite `content/frontend/pages/SettingsPage.tsx`**

```tsx
// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api, type ProviderCredentialInfo, type ProviderName } from "../lib/api";
import { OpenAiLogo, AnthropicLogo, WorkersAiLogo } from "../lib/providerLogos";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  default: "Default (Cloudflare Workers AI)",
};

const PROVIDER_LOGOS: Record<ProviderName, React.ReactNode> = {
  openai: <OpenAiLogo />,
  anthropic: <AnthropicLogo />,
  default: <WorkersAiLogo />,
};

function ModelPicker({
  provider,
  apiKey,
  model,
  onChange,
}: {
  provider: ProviderName;
  apiKey: string;
  model: string;
  onChange: (model: string) => void;
}) {
  const [options, setOptions] = useState<string[] | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    if (provider !== "default" && !apiKey) {
      setOptions(null);
      return;
    }
    let cancelled = false;
    setFetchFailed(false);
    api.llmModels.list(provider, apiKey || undefined)
      .then((res) => { if (!cancelled) setOptions(res.models); })
      .catch(() => { if (!cancelled) { setOptions(null); setFetchFailed(true); } });
    return () => { cancelled = true; };
  }, [provider, apiKey]);

  if (options && options.length > 0) {
    return (
      <Select value={model} onChange={(e: any) => onChange(e.target.value)} className="w-full text-sm">
        {!options.includes(model) && model && <option value={model}>{model}</option>}
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
    );
  }

  // Graceful fallback: manual entry when the live list hasn't loaded, is empty, or failed.
  return (
    <div className="space-y-1">
      <Input value={model} onChange={(e: any) => onChange(e.target.value)} placeholder="e.g. gpt-4o" className="w-full text-sm" />
      {fetchFailed && <p className="text-[11px] text-muted-foreground">Couldn't load the live model list -- type the model id manually.</p>}
    </div>
  );
}

function ProviderForm({
  provider,
  initialModel,
  requiresApiKey,
  onSaved,
  onCancel,
}: {
  provider: ProviderName;
  initialModel?: string;
  requiresApiKey: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel || "");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (requiresApiKey && !apiKey) return;
    if (!model) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, model, requiresApiKey ? apiKey : undefined);
      toast({ title: `${PROVIDER_LABELS[provider]} ${requiresApiKey ? "key" : "model"} saved` });
      onSaved();
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {requiresApiKey && (
        <div>
          <Label className="text-xs block mb-1">API Key</Label>
          <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
        </div>
      )}
      <div>
        <Label className="text-xs block mb-1">Model</Label>
        <ModelPicker provider={provider} apiKey={apiKey} model={model} onChange={setModel} />
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || (requiresApiKey && !apiKey) || !model}>{saving ? "Saving..." : "Save"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderCredentialInfo[]>([]);
  const [defaultModel, setDefaultModelState] = useState<string>("");
  const [editing, setEditing] = useState<ProviderName | null>(null);
  const { toast } = useToast();

  const reload = () => {
    api.llmCredentials.list()
      .then((res) => { setProviders(res.providers); setDefaultModelState(res.defaultModel); })
      .catch(() => {});
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

  const providerOrder: ProviderName[] = ["openai", "anthropic", "default"];

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Content Generation Settings</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {providerOrder.map((provider) => {
          // "default" never appears in `providers` (BYOK-only, see this plan's Global
          // Constraints) -- its model comes from the separate `defaultModel` field.
          const configured = provider === "default" ? undefined : providers.find((p) => p.provider === provider);
          const requiresApiKey = provider !== "default";
          const currentModel = provider === "default" ? defaultModel : configured?.model;

          return (
            <ChannelCard
              key={provider}
              logo={PROVIDER_LOGOS[provider]}
              name={PROVIDER_LABELS[provider]}
              tagline={
                provider === "default"
                  ? `Model: ${defaultModel}`
                  : configured
                    ? `Model: ${configured.model}`
                    : "No key configured for this provider"
              }
              status={provider === "default" || configured ? "connected" : "disconnected"}
              createdAt={configured?.createdAt}
              extra={
                editing === provider ? (
                  <ProviderForm
                    provider={provider}
                    initialModel={currentModel}
                    requiresApiKey={requiresApiKey}
                    onSaved={() => { setEditing(null); reload(); }}
                    onCancel={() => setEditing(null)}
                  />
                ) : undefined
              }
              actions={
                editing === provider ? undefined : (
                  <div className="flex gap-2 w-full">
                    <Button className="flex-1" onClick={() => setEditing(provider)}>
                      {provider === "default" ? "Change model" : configured ? "Edit" : "Connect"}
                    </Button>
                    {requiresApiKey && configured && (
                      <Button className="flex-1" variant="destructive" onClick={() => handleDisconnect(provider as "openai" | "anthropic")}>
                        Disconnect
                      </Button>
                    )}
                  </div>
                )
              }
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        No key configured for OpenAI or Anthropic? Flow nodes can still use the free built-in model ("default") or post text with no AI at all ("none").
      </p>
    </div>
  );
}
```

**Notes for the implementer:**
- Verify `shared/frontend/ui/button`'s `Button` component actually supports a `variant="destructive"` prop (the prior plan's Task 6 review confirmed it's `cva`-based with a `variant`/`size` API — confirm `destructive` is one of the defined variants; if not, use whatever the closest existing red/warning variant is called).
- The `actions` footer now renders full-width buttons (`flex-1` on a `flex w-full` row) to match `ChannelCard`'s own `link` channel cards, replacing the previous small inline `size="sm"` buttons.
- `default`'s card never shows a "Disconnect" action (nothing to disconnect) — only "Change model".

- [ ] **Step 5: Self-review**

- [ ] Does `ModelPicker` gracefully fall back to a manual `Input` (not crash, not show an empty unusable dropdown) when `api.llmModels.list` rejects?
- [ ] Does the `default` card render even when the tenant has never saved a model choice (no row exists yet)?
- [ ] Does saving `default`'s model call `PUT /api/llm-credentials` with no `apiKey` in the body (check the network payload, not just that it doesn't crash)?
- [ ] Are OpenAI/Anthropic's `Connect`/`Edit`/`Disconnect` behaviors otherwise unchanged from before this task (same flows, just restyled)?
- [ ] Does `providers.find((p) => p.provider === provider)` never get called with `provider === "default"` in a way that would look up a nonexistent entry — confirm the `configured` variable is explicitly `undefined` for `"default"` (via the ternary), not left to an always-missing `.find()` call.

- [ ] **Step 6: Commit**

```bash
git add content/frontend/lib/providerLogos.tsx content/frontend/lib/api.ts content/frontend/pages/SettingsPage.tsx content/src/index.ts content/tests/routes-api.test.ts
git commit -m "feat(content): settings page visual parity + dynamic model dropdowns

Real icon badges (was plain text initials), a third Default (Workers AI)
card with a persisted model choice, live-fetched model lists per provider
with a graceful manual-entry fallback, full-width action buttons matching
link's ChannelCard usage, and a Connected-since date line."
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full `content` test suite**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/content && npx vitest run
```

Expected: all pass, zero failures.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck 2>&1 | grep -v "shared/frontend"
```

Expected: clean beyond the pre-existing `shared/frontend` react-types baseline noise (established in every prior task of both earlier plans in this session).

- [ ] **Step 3: Check whether the `CF_API_TOKEN` secret has been provisioned**

This plan's Global Constraints flagged that `content`'s new `ai/models/search` call needs a Cloudflare API token with `Workers AI:Read` scope, reusing/broadening the existing `CF_D1_API_TOKEN` value per the user's decision earlier in this session. Before deploying:

- Ask whether the token's scope has been broadened in the Cloudflare dashboard yet, and if so, get the value.
- If provided: `wrangler secret put CF_API_TOKEN --env dev` (and `--env production` if deploying there too), pasting the value when prompted.
- If not yet provided: apply migration + deploy everything else in this plan anyway (Tasks 1/2/4's fixes and UI work are fully independent of this token), but the `default` card's live model dropdown will fail its fetch and fall back to manual entry until the secret exists — note this plainly rather than blocking the rest of the deployment on it.

- [ ] **Step 4: Apply the new migration to remote dev**

```bash
wrangler d1 migrations apply uniscrm-content-dev --env dev --remote
```

- [ ] **Step 5: Build and deploy**

```bash
npx vite build --mode development && wrangler deploy --env dev
```

- [ ] **Step 6: Browser verification** (real logged-in session via `tabs_context_mcp`, per project convention)

1. `content-dev.uni-scrm.com/settings` (or wherever the settings route resolves) — confirm 3 cards render: OpenAI, Anthropic, Default. Confirm the icons are distinct colored badges (not plain text initials).
2. Connect OpenAI with a test key: confirm the model field either shows a live-fetched dropdown (if the key happens to be valid) or gracefully falls back to a manual text `Input` with the "couldn't load" hint (if the test key is invalid, which is the expected/likely case for a fabricated test key) -- either behavior is correct, confirm it doesn't crash or hang.
3. Confirm `Connected {date}` appears once a provider is connected.
4. Click "Change model" on the Default card: confirm it doesn't require an API key field, and saving a model persists (reload the page, confirm it shows the saved model).
5. Disconnect OpenAI: confirm it reverts cleanly, dev left in a clean state (no lingering test credentials).
6. After setting a custom Default model via the new "Change model" action, open the flow editor's `xContentAction` node Inspector (from the prior plan) and confirm its Provider dropdown still shows exactly one `"Default (free built-in model)"` option — not a duplicate/mislabeled second `value="default"` entry. This is the regression this plan's Global Constraints and Task 2's dedicated test guard against (`listConfiguredProviders` must never return a `"default"` row); this step is the end-to-end confirmation that the guard actually holds against the real deployed `flow` frontend, not just the unit test.

- [ ] **Step 7: Report completion** only once Steps 1-6 all pass (or Step 3's token gate is explicitly and plainly deferred, not silently skipped).
