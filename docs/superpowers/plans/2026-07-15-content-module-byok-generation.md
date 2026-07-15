# Content Module: BYOK Content Generation + X Auto-Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `content` worker (tenant BYOK LLM keys + curated skill catalog + generation endpoint), wire it into `flow`'s `aiRewritePublish` action end-to-end (skill selection, real branch resolution, retry), and implement `link`'s real X `create-post` publish so "see my new X post → AI-rewrite → publish to X" works without human intervention.

**Architecture:** `contentTrigger` → `aiRewritePublish` action (flow, already shipped) → `link` `/internal/content/ai-rewrite-publish` (replacing its `501` stub) → `content` `/internal/generate` → back to `link` → X `create-post` → new target `content` row + source `content.status` update via `flow`'s (newly fixed) branch resolution.

**Tech Stack:** Cloudflare Workers (Hono), D1, `@cloudflare/vitest-pool-workers`, React + Zustand + `@xyflow/react` (flow frontend only), `uniscrm-byok` (AES-256-GCM encryption).

**Spec:** `docs/superpowers/specs/2026-07-15-content-module-byok-generation-design.md`

## Global Constraints

- Every task touching `flow/src/*`, `link/src/*`, or `content/src/*` must pass `tsc --noEmit` in that module before being considered done.
- No changes to existing `flows`, `flow_executions`, `flow_pending`, `rate_limits`, `content_flow_executions` schemas — additive only. `content_flow_pending`'s existing-but-unused `retry_action`/`retry_count` columns get populated for the first time; the column definitions themselves are unchanged.
- `repost`'s branch-resolution/stub behavior is explicitly untouched — this plan only fixes `aiRewritePublish`'s runtime behavior in `executeContentActions`/`resumeFromNode`.
- No full external API response payloads (X, OpenAI, Anthropic) get written to any D1 table — log via `console.log`, store only IDs/references in `raw_data`.
- Text-only X posts this phase — no image/video attachment.
- Follow the resource-naming convention throughout: Cloudflare component names prefixed `uniscrm-content`, `-dev` suffix for the dev environment, no suffix for production.
- Frontend: no inline CSS, use `shared/frontend/ui/*` components (`Button`, `Input`, `Label`, `Select`, `Card`).
- Global CLAUDE.md dev-server + browser verification requirement applies at the end (Task 22).

---

## Task 1: Scaffold the `content` worker

**Files:**
- Create: `content/wrangler.toml`
- Create: `content/package.json`
- Create: `content/tsconfig.json`
- Create: `content/vite.config.ts`
- Create: `content/src/types.ts`
- Create: `content/src/index.ts`
- Create: `content/migrations/0001_init.sql`
- Create: `content/frontend/index.html`
- Create: `content/frontend/main.tsx`
- Create: `content/frontend/env.d.ts`
- Create: `content/frontend/index.css`
- Create: `content/.gitignore`

**Interfaces:**
- Produces: a deployable, empty-but-working Cloudflare Worker (`GET /health` → `200`), own D1 database binding `CONTENT_DB`, own `AI` binding, own `ENCRYPTION_KEY` Secrets Store binding. Consumed by every later task in this module.

- [ ] **Step 1: Create the D1 databases (dev + prod) via wrangler**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
wrangler d1 create uniscrm-content-dev
wrangler d1 create uniscrm-content
```

Record the `database_id` UUIDs each command prints — they go into `content/wrangler.toml` below (replace the `REPLACE_WITH_DEV_DB_ID` / `REPLACE_WITH_PROD_DB_ID` placeholders with the real values before committing).

- [ ] **Step 2: Create the Secrets Store secret for the encryption master key (dev + prod)**

Generate two independent master keys (never reuse `link`'s X-BYOK key — separate trust domain per the design spec):

```bash
cd link && node -e "import('uniscrm-byok').then(m => console.log(m.generateMasterKey()))"
```

Run it twice (once per environment) and store each result via:

```bash
wrangler secrets-store secret create 358a0014b2254c2eafb877e4182fd977 --name uniscrm-content-encryption-key-dev --scopes workers
wrangler secrets-store secret create 358a0014b2254c2eafb877e4182fd977 --name uniscrm-content-encryption-key --scopes workers
```

(Reusing the same Secrets Store instance ID `358a0014b2254c2eafb877e4182fd977` that `link`'s `ENCRYPTION_KEY` already lives in — it's a container for multiple independently-named secrets, not a single-secret store.) Paste each generated key when prompted.

- [ ] **Step 3: Write `content/wrangler.toml`**

```toml
name = "content"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = true

[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
invocation_logs = true

[env.dev]
name = "content-dev"
routes = [{ pattern = "content-dev.uni-scrm.com", custom_domain = true }]

[env.dev.vars]
WEB_URL = "https://web-dev.uni-scrm.com"
INTERNAL_SECRET = "dev-internal-secret"

[[env.dev.d1_databases]]
binding = "CONTENT_DB"
database_name = "uniscrm-content-dev"
database_id = "REPLACE_WITH_DEV_DB_ID"
migrations_dir = "migrations"

[env.dev.ai]
binding = "AI"

[[env.dev.secrets_store_secrets]]
binding = "ENCRYPTION_KEY"
store_id = "358a0014b2254c2eafb877e4182fd977"
secret_name = "uniscrm-content-encryption-key-dev"

[env.production]
name = "content"
routes = [{ pattern = "content.uni-scrm.com", custom_domain = true }]

[env.production.vars]
WEB_URL = "https://web.uni-scrm.com"
INTERNAL_SECRET = "prod-internal-secret-change-me"

[[env.production.d1_databases]]
binding = "CONTENT_DB"
database_name = "uniscrm-content"
database_id = "REPLACE_WITH_PROD_DB_ID"
migrations_dir = "migrations"

[env.production.ai]
binding = "AI"

[[env.production.secrets_store_secrets]]
binding = "ENCRYPTION_KEY"
store_id = "358a0014b2254c2eafb877e4182fd977"
secret_name = "uniscrm-content-encryption-key"
```

- [ ] **Step 4: Write `content/package.json`**

```json
{
  "name": "content",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "dev:worker": "wrangler dev --env dev",
    "build": "vite build",
    "deploy:dev": "vite build --mode development && wrangler deploy --env dev",
    "deploy:prod": "vite build && wrangler deploy --env production",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "uniscrm-byok": "github:zcqqq/uniscrm-byok#v1.0.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.18.0",
    "@cloudflare/workers-types": "^4.20250410.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.8.0",
    "vitest": "^4.1.0",
    "vite": "^6.0.0",
    "wrangler": "^4.10.0"
  }
}
```

- [ ] **Step 5: Write `content/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "jsx": "react-jsx",
    "types": ["@cloudflare/workers-types/2023-07-01"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "frontend/**/*.ts", "frontend/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 6: Write `content/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  envDir: "../..",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api/auth": "http://localhost:8788",
      "/api": "http://localhost:8793",
    },
  },
});
```

- [ ] **Step 7: Write `content/migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
  tenant_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 8: Write `content/src/types.ts`**

```ts
export interface Env {
  CONTENT_DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  WEB_URL: string;
  INTERNAL_SECRET: string;
  ENCRYPTION_KEY: { get(): Promise<string> };
}
```

- [ ] **Step 9: Write a minimal `content/src/index.ts`**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();
app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
```

- [ ] **Step 10: Write `content/frontend/index.html`, `main.tsx`, `env.d.ts`, `index.css`**

```html
<!-- content/frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Content</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

```tsx
// content/frontend/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```ts
// content/frontend/env.d.ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEB_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

```css
/* content/frontend/index.css */
@import "tailwindcss";
@import "../../shared/frontend/index.css";
@source "../../shared/frontend";
```

(`App.tsx` is created in Task 9 once there's a page to route to — `main.tsx` importing it is forward-referenced, this task's build isn't run standalone until then.)

- [ ] **Step 11: Add `content/.gitignore`**

```
node_modules/
dist/
.wrangler/
```

- [ ] **Step 12: Apply the migration locally and verify**

```bash
cd content && npm install
wrangler d1 migrations apply uniscrm-content-dev --local
wrangler d1 execute uniscrm-content-dev --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_llm_credentials'"
```

Expected: `tenant_llm_credentials` listed.

- [ ] **Step 13: Typecheck**

```bash
cd content && npm run typecheck
```

Expected: fails on the missing `./App` import in `main.tsx` — that's expected until Task 9. Comment out the `App` import and render temporarily if you want a clean typecheck here, or proceed knowing Task 9 resolves it (recommended: proceed, this is a scaffold task and the full module isn't wired until later tasks land).

- [ ] **Step 14: Commit**

```bash
git add content/wrangler.toml content/package.json content/package-lock.json content/tsconfig.json content/vite.config.ts content/migrations content/src/types.ts content/src/index.ts content/frontend/index.html content/frontend/main.tsx content/frontend/env.d.ts content/frontend/index.css content/.gitignore
git commit -m "feat(content): scaffold content worker (own D1, own encryption key)"
```

---

## Task 2: Skill catalog

**Files:**
- Create: `content/src/skills/interface.ts`
- Create: `content/src/skills/punchy-social.ts`
- Create: `content/src/skills/professional-tone.ts`
- Create: `content/src/skills/index.ts`
- Test: `content/tests/skills.test.ts`

**Interfaces:**
- Produces: `SKILL_CATALOG: Skill[]`, `getSkill(skillId: string): Skill | undefined` — consumed by Task 6 (`generate.ts`) and Task 8 (`GET /api/skills`).

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/skills.test.ts
import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, getSkill } from "../src/skills";

describe("skill catalog", () => {
  it("has at least two curated skills, each with an id/label/systemPrompt", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(2);
    for (const skill of SKILL_CATALOG) {
      expect(skill.id).toBeTruthy();
      expect(skill.label).toBeTruthy();
      expect(skill.systemPrompt.length).toBeGreaterThan(20);
    }
  });

  it("getSkill returns the matching skill by id", () => {
    const skill = getSkill("punchy-social");
    expect(skill?.label).toBe("Punchy Social Rewrite");
  });

  it("getSkill returns undefined for an unknown id", () => {
    expect(getSkill("does-not-exist")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd content && npx vitest run tests/skills.test.ts
```

Expected: FAIL — `../src/skills` doesn't exist yet.

- [ ] **Step 3: Write the skill interface**

```ts
// content/src/skills/interface.ts
export interface Skill {
  id: string;
  label: string;
  systemPrompt: string;
}
```

- [ ] **Step 4: Write the two curated skills**

```ts
// content/src/skills/punchy-social.ts
import type { Skill } from "./interface";

export const PUNCHY_SOCIAL: Skill = {
  id: "punchy-social",
  label: "Punchy Social Rewrite",
  systemPrompt: `You are a social media copywriter. Rewrite the given source content into a short, punchy post for the target platform.
Rules:
- Keep the core message and any facts/numbers from the source intact — do not invent claims.
- Use an energetic, conversational tone. Short sentences. No corporate jargon.
- No hashtags unless the source content already uses them heavily.
- Stay under 280 characters for X, under 150 words for other platforms.
- Output only the rewritten post text — no preamble, no quotes, no explanation.`,
};
```

```ts
// content/src/skills/professional-tone.ts
import type { Skill } from "./interface";

export const PROFESSIONAL_TONE: Skill = {
  id: "professional-tone",
  label: "Professional Rewrite",
  systemPrompt: `You are a professional communications editor. Rewrite the given source content into a polished, professional post for the target platform.
Rules:
- Keep the core message and any facts/numbers from the source intact — do not invent claims.
- Use clear, measured, third-person-friendly language. No slang, no excessive exclamation points.
- No hashtags.
- Stay under 280 characters for X, under 150 words for other platforms.
- Output only the rewritten post text — no preamble, no quotes, no explanation.`,
};
```

- [ ] **Step 5: Write the registry**

```ts
// content/src/skills/index.ts
import type { Skill } from "./interface";
import { PUNCHY_SOCIAL } from "./punchy-social";
import { PROFESSIONAL_TONE } from "./professional-tone";

export type { Skill };

export const SKILL_CATALOG: Skill[] = [PUNCHY_SOCIAL, PROFESSIONAL_TONE];

export function getSkill(skillId: string): Skill | undefined {
  return SKILL_CATALOG.find((s) => s.id === skillId);
}
```

- [ ] **Step 6: Run the tests**

```bash
cd content && npx vitest run tests/skills.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add content/src/skills content/tests/skills.test.ts
git commit -m "feat(content): add curated skill catalog"
```

---

## Task 3: `uniscrm-byok` crypto shim + LLM credentials service

**Files:**
- Create: `content/src/services/crypto.ts`
- Create: `content/src/services/llm-credentials.ts`
- Create: `content/vitest.config.ts`
- Test: `content/tests/llm-credentials.test.ts`

**Interfaces:**
- Produces: `getTenantLlmCredentials(env, tenantId): Promise<{provider, apiKey} | null>`, `setTenantLlmCredentials(env, tenantId, provider, apiKey): Promise<void>`, `hasTenantLlmCredentials(env, tenantId): Promise<{provider: string} | null>` — consumed by Task 6 (`generate.ts`) and Task 8 (settings routes).

- [ ] **Step 1: Write `content/vitest.config.ts`** (needed before any test using `cloudflare:test` can run)

```ts
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({ configPath: "./wrangler.toml", environment: "dev" })],
  test: {
    globals: true,
    exclude: ["**/node_modules/**"],
  },
});
```

- [ ] **Step 2: Write the failing test**

```ts
// content/tests/llm-credentials.test.ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { generateMasterKey } from "uniscrm-byok";
import { getTenantLlmCredentials, setTenantLlmCredentials, hasTenantLlmCredentials } from "../src/services/llm-credentials";

describe("tenant LLM credentials", () => {
  const testMasterKey = generateMasterKey();
  const testEnv = { ...env, ENCRYPTION_KEY: { get: async () => testMasterKey } };

  beforeEach(async () => {
    await env.CONTENT_DB.prepare(`DELETE FROM tenant_llm_credentials`).run();
  });

  it("returns null when no credentials are set for the tenant", async () => {
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toBeNull();
  });

  it("round-trips provider + api key through encryption", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123");
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toEqual({ provider: "openai", apiKey: "sk-test-123" });
  });

  it("upserts on a second call for the same tenant (single active provider+key)", async () => {
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-old");
    await setTenantLlmCredentials(testEnv as any, 42, "anthropic", "sk-new");
    const creds = await getTenantLlmCredentials(testEnv as any, 42);
    expect(creds).toEqual({ provider: "anthropic", apiKey: "sk-new" });

    const count = await env.CONTENT_DB.prepare(`SELECT COUNT(*) as c FROM tenant_llm_credentials WHERE tenant_id = 42`).first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("hasTenantLlmCredentials reports provider without decrypting", async () => {
    expect(await hasTenantLlmCredentials(testEnv as any, 42)).toBeNull();
    await setTenantLlmCredentials(testEnv as any, 42, "openai", "sk-test-123");
    expect(await hasTenantLlmCredentials(testEnv as any, 42)).toEqual({ provider: "openai" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd content && npx vitest run tests/llm-credentials.test.ts
```

Expected: FAIL — `../src/services/llm-credentials` doesn't exist yet.

- [ ] **Step 4: Write the crypto shim**

```ts
// content/src/services/crypto.ts
export { encrypt, decrypt, generateMasterKey } from "uniscrm-byok";
```

- [ ] **Step 5: Write the credentials service**

```ts
// content/src/services/llm-credentials.ts
import type { Env } from "../types";
import { encrypt, decrypt } from "./crypto";

export type LlmProviderName = "openai" | "anthropic";

export interface LlmCredentials {
  provider: LlmProviderName;
  apiKey: string;
}

export async function getTenantLlmCredentials(env: Env, tenantId: number): Promise<LlmCredentials | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT provider, encrypted_api_key FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).first<{ provider: string; encrypted_api_key: string }>();
  if (!row) return null;

  const masterKey = await env.ENCRYPTION_KEY.get();
  const apiKey = await decrypt(row.encrypted_api_key, masterKey);
  return { provider: row.provider as LlmProviderName, apiKey };
}

export async function setTenantLlmCredentials(
  env: Env,
  tenantId: number,
  provider: LlmProviderName,
  apiKey: string
): Promise<void> {
  const masterKey = await env.ENCRYPTION_KEY.get();
  const encryptedApiKey = await encrypt(apiKey, masterKey);
  const now = new Date().toISOString();

  await env.CONTENT_DB.prepare(
    `INSERT INTO tenant_llm_credentials (tenant_id, provider, encrypted_api_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       provider = excluded.provider,
       encrypted_api_key = excluded.encrypted_api_key,
       updated_at = excluded.updated_at`
  ).bind(tenantId, provider, encryptedApiKey, now, now).run();
}

export async function hasTenantLlmCredentials(env: Env, tenantId: number): Promise<{ provider: string } | null> {
  const row = await env.CONTENT_DB.prepare(
    "SELECT provider FROM tenant_llm_credentials WHERE tenant_id = ?"
  ).bind(tenantId).first<{ provider: string }>();
  return row ?? null;
}
```

- [ ] **Step 6: Run the tests**

```bash
cd content && npx vitest run tests/llm-credentials.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
cd content && npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add content/vitest.config.ts content/src/services/crypto.ts content/src/services/llm-credentials.ts content/tests/llm-credentials.test.ts
git commit -m "feat(content): tenant BYOK LLM credentials (encrypted storage)"
```

---

## Task 4: Provider abstraction — interface + Workers AI fallback

**Files:**
- Create: `content/src/providers/interface.ts`
- Create: `content/src/providers/workers-ai.ts`
- Test: `content/tests/providers/workers-ai.test.ts`

**Interfaces:**
- Produces: `interface LlmProvider { generate(systemPrompt: string, userPrompt: string): Promise<string> }`, `class WorkersAiProvider implements LlmProvider` — consumed by Task 5 (other providers) and Task 6 (`generate.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/providers/workers-ai.test.ts
import { describe, it, expect, vi } from "vitest";
import { WorkersAiProvider } from "../../src/providers/workers-ai";

describe("WorkersAiProvider", () => {
  it("calls env.AI.run with the llama model, non-streaming, and returns the response text", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "generated text" });
    const provider = new WorkersAiProvider({ run: aiRun } as any);

    const text = await provider.generate("system prompt", "user prompt");

    expect(text).toBe("generated text");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "user prompt" },
        ],
        stream: false,
      }
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd content && npx vitest run tests/providers/workers-ai.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the interface**

```ts
// content/src/providers/interface.ts
export interface LlmProvider {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}
```

- [ ] **Step 4: Write the Workers AI provider**

```ts
// content/src/providers/workers-ai.ts
import type { LlmProvider } from "./interface";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

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
}
```

- [ ] **Step 5: Run the tests**

```bash
cd content && npx vitest run tests/providers/workers-ai.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add content/src/providers/interface.ts content/src/providers/workers-ai.ts content/tests/providers/workers-ai.test.ts
git commit -m "feat(content): LlmProvider interface + Workers AI fallback provider"
```

---

## Task 5: OpenAI and Anthropic providers

**Files:**
- Create: `content/src/providers/openai.ts`
- Create: `content/src/providers/anthropic.ts`
- Test: `content/tests/providers/openai.test.ts`
- Test: `content/tests/providers/anthropic.test.ts`

**Interfaces:**
- Produces: `class OpenAiProvider implements LlmProvider`, `class AnthropicProvider implements LlmProvider`, both `constructor(apiKey: string)` — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

```ts
// content/tests/providers/openai.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai";

describe("OpenAiProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the chat completions endpoint with the given key and prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiProvider("sk-test");
    const text = await provider.generate("system prompt", "user prompt");

    expect(text).toBe("generated text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new OpenAiProvider("sk-bad");
    await expect(provider.generate("s", "u")).rejects.toThrow("OpenAI generate failed: 401");
  });
});
```

```ts
// content/tests/providers/anthropic.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic";

describe("AnthropicProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the messages endpoint with the given key and prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "generated text" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider("sk-ant-test");
    const text = await provider.generate("system prompt", "user prompt");

    expect(text).toBe("generated text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    const body = JSON.parse(init.body);
    expect(body.system).toBe("system prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new AnthropicProvider("sk-ant-bad");
    await expect(provider.generate("s", "u")).rejects.toThrow("Anthropic generate failed: 401");
  });
});
```

- [ ] **Step 2: Run to verify both fail**

```bash
cd content && npx vitest run tests/providers/openai.test.ts tests/providers/anthropic.test.ts
```

Expected: FAIL — modules don't exist.

- [ ] **Step 3: Write the OpenAI provider**

```ts
// content/src/providers/openai.ts
import type { LlmProvider } from "./interface";

const MODEL = "gpt-4o-mini";

export class OpenAiProvider implements LlmProvider {
  constructor(private apiKey: string) {}

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

    if (!res.ok) {
      throw new Error(`OpenAI generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0].message.content;
  }
}
```

- [ ] **Step 4: Write the Anthropic provider**

```ts
// content/src/providers/anthropic.ts
import type { LlmProvider } from "./interface";

const MODEL = "claude-3-5-haiku-latest";

export class AnthropicProvider implements LlmProvider {
  constructor(private apiKey: string) {}

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

    if (!res.ok) {
      throw new Error(`Anthropic generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { content: { type: string; text: string }[] };
    return body.content[0].text;
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
cd content && npx vitest run tests/providers/openai.test.ts tests/providers/anthropic.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add content/src/providers/openai.ts content/src/providers/anthropic.ts content/tests/providers/openai.test.ts content/tests/providers/anthropic.test.ts
git commit -m "feat(content): OpenAI and Anthropic BYOK providers"
```

---

## Task 6: Generation orchestration

**Files:**
- Create: `content/src/services/generate.ts`
- Test: `content/tests/generate.test.ts`

**Interfaces:**
- Consumes: `getTenantLlmCredentials` (Task 3), `LlmProvider`/`OpenAiProvider`/`AnthropicProvider`/`WorkersAiProvider` (Tasks 4-5), `getSkill` (Task 2).
- Produces: `generateContent(env: Env, params: { tenantId: number; skillId: string; material: { title?: string; content_text?: string; summary?: string }; targetPlatform: "X" | "TIKTOK" }): Promise<string>` — throws `Error("Unknown skill: <id>")` if the skill isn't found; falls back to Workers AI on missing/failing BYOK credentials. Consumed by Task 7 (`/internal/generate` route).

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/generate.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateContent } from "../src/services/generate";
import * as credentialsModule from "../src/services/llm-credentials";

describe("generateContent", () => {
  afterEach(() => vi.restoreAllMocks());

  const material = { title: "Big launch", content_text: "We shipped a thing today.", summary: undefined };
  const baseParams = { tenantId: 1, skillId: "punchy-social", material, targetPlatform: "X" as const };

  it("throws for an unknown skillId", async () => {
    await expect(
      generateContent({} as any, { ...baseParams, skillId: "nope" })
    ).rejects.toThrow("Unknown skill: nope");
  });

  it("uses the tenant's BYOK provider when credentials exist", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ provider: "openai", apiKey: "sk-test" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "byok text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, baseParams);

    expect(text).toBe("byok text");
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.anything());
    vi.unstubAllGlobals();
  });

  it("falls back to Workers AI when the tenant has no BYOK credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "fallback text" });

    const text = await generateContent({ AI: { run: aiRun } } as any, baseParams);

    expect(text).toBe("fallback text");
  });

  it("falls back to Workers AI when the BYOK call throws", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ provider: "openai", apiKey: "sk-bad" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const aiRun = vi.fn().mockResolvedValue({ response: "fallback text" });

    const text = await generateContent({ AI: { run: aiRun } } as any, baseParams);

    expect(text).toBe("fallback text");
    vi.unstubAllGlobals();
  });

  it("includes the skill's systemPrompt and the material as the user prompt", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "text" });

    await generateContent({ AI: { run: aiRun } } as any, baseParams);

    const [, callArgs] = aiRun.mock.calls[0];
    expect(callArgs.messages[0].content).toContain("Punchy");
    expect(callArgs.messages[1].content).toContain("Big launch");
    expect(callArgs.messages[1].content).toContain("We shipped a thing today.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd content && npx vitest run tests/generate.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `generate.ts`**

```ts
// content/src/services/generate.ts
import type { Env } from "../types";
import { getSkill } from "../skills";
import { getTenantLlmCredentials } from "./llm-credentials";
import { WorkersAiProvider } from "../providers/workers-ai";
import { OpenAiProvider } from "../providers/openai";
import { AnthropicProvider } from "../providers/anthropic";
import type { LlmProvider } from "../providers/interface";

export interface GenerateParams {
  tenantId: number;
  skillId: string;
  material: { title?: string; content_text?: string; summary?: string };
  targetPlatform: "X" | "TIKTOK";
}

function buildUserPrompt(material: GenerateParams["material"], targetPlatform: string): string {
  const parts = [`Target platform: ${targetPlatform}`];
  if (material.title) parts.push(`Title: ${material.title}`);
  if (material.content_text) parts.push(`Content: ${material.content_text}`);
  if (material.summary) parts.push(`Summary: ${material.summary}`);
  return parts.join("\n");
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const skill = getSkill(params.skillId);
  if (!skill) throw new Error(`Unknown skill: ${params.skillId}`);

  const userPrompt = buildUserPrompt(params.material, params.targetPlatform);

  const credentials = await getTenantLlmCredentials(env, params.tenantId);
  if (credentials) {
    const provider: LlmProvider =
      credentials.provider === "openai"
        ? new OpenAiProvider(credentials.apiKey)
        : new AnthropicProvider(credentials.apiKey);
    try {
      return await provider.generate(skill.systemPrompt, userPrompt);
    } catch (err) {
      console.error(JSON.stringify({ event: "byok_generate_failed_falling_back", tenantId: params.tenantId, provider: credentials.provider, error: String(err) }));
    }
  }

  const fallback = new WorkersAiProvider(env.AI);
  return fallback.generate(skill.systemPrompt, userPrompt);
}
```

- [ ] **Step 4: Run the tests**

```bash
cd content && npx vitest run tests/generate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd content && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add content/src/services/generate.ts content/tests/generate.test.ts
git commit -m "feat(content): generation orchestration (BYOK with Workers AI fallback)"
```

---

## Task 7: `/internal/generate` route

**Files:**
- Create: `content/src/routes-internal.ts`
- Modify: `content/src/index.ts`
- Test: `content/tests/routes-internal.test.ts`

**Interfaces:**
- Consumes: `generateContent` (Task 6).
- Produces: `POST /internal/generate` behind `X-Internal-Secret`, `{tenantId, skillId, material, targetPlatform} → {text}`. Consumed by `link`'s real ai-rewrite-publish handler (Task 19).

- [ ] **Step 1: Write the failing test**

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
        body: JSON.stringify({ tenantId: 1, skillId: "punchy-social", material: {}, targetPlatform: "X" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns generated text on success (Workers AI fallback, no BYOK key seeded)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({
          tenantId: 999,
          skillId: "punchy-social",
          material: { content_text: "hello world" },
          targetPlatform: "X",
        }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ text: string }>();
    expect(typeof body.text).toBe("string");
  });

  it("returns 400 for an unknown skillId", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, skillId: "nope", material: {}, targetPlatform: "X" }),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd content && npx vitest run tests/routes-internal.test.ts
```

Expected: FAIL — `/internal/generate` doesn't exist (404).

- [ ] **Step 3: Write `content/src/routes-internal.ts`**

```ts
// content/src/routes-internal.ts
import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/generate", async (c) => {
    const { tenantId, skillId, material, targetPlatform } = await c.req.json<{
      tenantId: number;
      skillId: string;
      material: { title?: string; content_text?: string; summary?: string };
      targetPlatform: "X" | "TIKTOK";
    }>();

    if (!tenantId || !skillId || !targetPlatform) {
      return c.json({ error: "tenantId, skillId, targetPlatform required" }, 400);
    }

    try {
      const text = await generateContent(c.env, { tenantId, skillId, material: material || {}, targetPlatform });
      return c.json({ text });
    } catch (err) {
      if (String(err).includes("Unknown skill")) {
        return c.json({ error: String(err) }, 400);
      }
      console.error(JSON.stringify({ event: "generate_failed", tenantId, skillId, error: String(err) }));
      return c.json({ error: "Generation failed" }, 502);
    }
  });

  return router;
}
```

- [ ] **Step 4: Wire it into `content/src/index.ts` behind an internal-secret check**

```ts
// content/src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();
app.use("*", cors());

async function internalAuthMiddleware(c: any, next: any) {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}

app.use("/internal/*", internalAuthMiddleware);
app.route("/internal", internalRoutes());

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
```

- [ ] **Step 5: Run the tests**

```bash
cd content && npx vitest run tests/routes-internal.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd content && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add content/src/routes-internal.ts content/src/index.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): POST /internal/generate endpoint"
```

---

## Task 8: `/api/skills` and `/api/llm-credentials` (tenant-facing routes)

**Files:**
- Modify: `content/src/index.ts`
- Test: `content/tests/routes-api.test.ts`

**Interfaces:**
- Consumes: `SKILL_CATALOG` (Task 2), `getTenantLlmCredentials`/`setTenantLlmCredentials`/`hasTenantLlmCredentials` (Task 3).
- Produces: `GET /api/skills` (public, no auth — static catalog) → `{skills: {id, label}[]}`; `GET /api/llm-credentials` and `PUT /api/llm-credentials` (session-authed via `web`'s `/api/auth/me`, mirroring `insight-segment`'s pattern) → `{provider: string} | null` / `{ok: true}`. Consumed by Task 9 (settings frontend) and Task 16 (flow's skill-picker proxy).

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/routes-api.test.ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("GET /api/skills", () => {
  it("returns the skill catalog without requiring auth", async () => {
    const res = await worker.fetch(new Request("https://content-dev.uni-scrm.com/api/skills"), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ skills: { id: string; label: string }[] }>();
    expect(body.skills.map((s) => s.id)).toContain("punchy-social");
  });
});

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

  it("GET returns null when authed but no credentials set", async () => {
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
    expect(await res.json()).toEqual({ credentials: null });
  });

  it("PUT saves credentials, subsequent GET reports the provider (not the key)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "78" } }), { status: 200 }))
    );

    const putRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", {
        method: "PUT",
        headers: { Cookie: "session=ok", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "openai", apiKey: "sk-test" }),
      }),
      env
    );
    expect(putRes.status).toBe(200);

    const getRes = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-credentials", { headers: { Cookie: "session=ok" } }),
      env
    );
    const body = await getRes.json<{ credentials: { provider: string } | null }>();
    expect(body.credentials).toEqual({ provider: "openai" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd content && npx vitest run tests/routes-api.test.ts
```

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Extend `content/src/index.ts`**

```ts
// content/src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { SKILL_CATALOG } from "./skills";
import { getTenantLlmCredentials, setTenantLlmCredentials, hasTenantLlmCredentials } from "./services/llm-credentials";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

async function internalAuthMiddleware(c: any, next: any) {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}

async function sessionAuth(c: any, next: any) {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const res = await fetch(`${c.env.WEB_URL}/api/auth/me`, { headers: { Cookie: cookie } });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  await next();
}

app.use("/internal/*", internalAuthMiddleware);
app.route("/internal", internalRoutes());

app.get("/health", (c) => c.json({ status: "ok" }));

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

export default app;
```

- [ ] **Step 4: Run the tests**

```bash
cd content && npx vitest run tests/routes-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full content test suite**

```bash
cd content && npx vitest run
```

Expected: all PASS.

- [ ] **Step 6: Typecheck**

```bash
cd content && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add content/src/index.ts content/tests/routes-api.test.ts
git commit -m "feat(content): /api/skills and /api/llm-credentials routes"
```

---

## Task 9: Settings frontend page

**Files:**
- Create: `content/frontend/components/Nav.tsx`
- Create: `content/frontend/lib/api.ts`
- Create: `content/frontend/pages/SettingsPage.tsx`
- Create: `content/frontend/App.tsx`

**Interfaces:**
- Consumes: `GET /api/llm-credentials`, `PUT /api/llm-credentials` (Task 8), shared `Sidebar`/`Button`/`Input`/`Label`/`Select`/`Card` components, shared `authFetch`.
- Produces: a working settings page at `content-dev.uni-scrm.com/` — no further tasks consume this directly, it's a leaf.

- [ ] **Step 1: Write `content/frontend/lib/api.ts`**

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

export interface LlmCredentialsInfo {
  provider: string | null;
}

export const api = {
  llmCredentials: {
    get: (): Promise<{ credentials: { provider: string } | null }> => request("/api/llm-credentials"),
    save: (provider: "openai" | "anthropic", apiKey: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey }) }),
  },
};
```

- [ ] **Step 2: Write `content/frontend/components/Nav.tsx`**

```tsx
// content/frontend/components/Nav.tsx
import { Sidebar } from "../../../shared/frontend/Sidebar";
import { URLS } from "../../../shared/frontend/urls";

const urls = { ...URLS, content: "" };

export function Nav() {
  return <Sidebar urls={urls} currentModule="content" />;
}
```

(Task 10 adds `content` to `URLS`/`SidebarUrls` — this file is written now referencing it, and typechecks once Task 10 lands. If executing tasks in strict order, expect a transient typecheck error here until Task 10 completes; that's expected and resolved by the next task.)

- [ ] **Step 3: Write `content/frontend/pages/SettingsPage.tsx`**

```tsx
// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { Card } from "../../../shared/frontend/ui/card";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/ui/toaster";
import { api } from "../lib/api";

export function SettingsPage() {
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.llmCredentials.get().then((res) => setCurrentProvider(res.credentials?.provider ?? null)).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!apiKey) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, apiKey);
      setCurrentProvider(provider);
      setApiKey("");
      toast({ title: "BYOK key saved" });
    } catch (e) {
      toast({ title: "Failed to save key", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Content Generation Settings</h1>
      <Card className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          {currentProvider
            ? `Currently using your own ${currentProvider} key for generation.`
            : "No key configured — generation falls back to a free built-in model."}
        </p>
        <div>
          <Label className="text-xs block mb-1">Provider</Label>
          <Select value={provider} onChange={(e: any) => setProvider(e.target.value)} className="w-full text-sm">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">API Key</Label>
          <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
        </div>
        <Button onClick={handleSave} disabled={saving || !apiKey}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Write `content/frontend/App.tsx`**

```tsx
// content/frontend/App.tsx
import { Nav } from "./components/Nav";
import { SettingsPage } from "./pages/SettingsPage";
import { Toaster } from "../../shared/frontend/ui/toaster";

export function App() {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <main className="flex-1 overflow-auto bg-background text-foreground">
        <SettingsPage />
      </main>
      <Toaster />
    </div>
  );
}
```

- [ ] **Step 5: Typecheck (expect Task 10's `content` field to be needed — see note in Step 2)**

```bash
cd content && npm run typecheck
```

If this fails only on `SidebarUrls`/`URLS` missing a `content` property, that's expected until Task 10 — proceed to Task 10 before considering this task's typecheck gate satisfied.

- [ ] **Step 6: Commit**

```bash
git add content/frontend/lib/api.ts content/frontend/components/Nav.tsx content/frontend/pages/SettingsPage.tsx content/frontend/App.tsx
git commit -m "feat(content): BYOK settings page"
```

---

## Task 10: Wire `content` into the shared nav

**Files:**
- Modify: `shared/frontend/urls.ts`
- Modify: `shared/frontend/Sidebar.tsx`
- Modify: `insight-segment/frontend/components/Nav.tsx`

**Interfaces:**
- Produces: `URLS.content`, `SidebarUrls.content: string`, a new "AI Generation Settings" menu item under the existing "Content" group in every module's sidebar (via the existing `...URLS` spread in `flow`/`analytics`'s local `Nav.tsx` wrappers — no changes needed there).

- [ ] **Step 1: Add `content` to `shared/frontend/urls.ts`**

```ts
const isDev = typeof window !== "undefined" && window.location.hostname.includes("-dev");

export const URLS = {
  web: isDev ? "https://web-dev.uni-scrm.com" : "https://web.uni-scrm.com",
  link: isDev ? "https://link-dev.uni-scrm.com" : "https://link.uni-scrm.com",
  flow: isDev ? "https://flow-dev.uni-scrm.com" : "https://flow.uni-scrm.com",
  analytics: isDev ? "https://analytics-dev.uni-scrm.com" : "https://analytics.uni-scrm.com",
  segment: isDev ? "https://segment-dev.uni-scrm.com" : "https://segment.uni-scrm.com",
  content: isDev ? "https://content-dev.uni-scrm.com" : "https://content.uni-scrm.com",
};
```

- [ ] **Step 2: Add `content` to `SidebarUrls` and a new menu item in `shared/frontend/Sidebar.tsx`**

Find the `SidebarUrls` interface:

```ts
export interface SidebarUrls {
  web: string;
  link: string;
  insightSegment: string;
  analytics: string;
  flow: string;
}
```

Replace with:

```ts
export interface SidebarUrls {
  web: string;
  link: string;
  insightSegment: string;
  analytics: string;
  flow: string;
  content: string;
}
```

Find the existing "content" group:

```ts
    {
      id: "content", label: "Content", icon: Icons.Content,
      items: [
        { id: "recommendations", label: "Recommendation", href: `${urls.web}/recommendations` },
        { id: "content", label: "Content Library", href: `${urls.link}/content` },
      ],
    },
```

Replace with (new item added, existing two untouched):

```ts
    {
      id: "content", label: "Content", icon: Icons.Content,
      items: [
        { id: "recommendations", label: "Recommendation", href: `${urls.web}/recommendations` },
        { id: "content", label: "Content Library", href: `${urls.link}/content` },
        { id: "ai-generation", label: "AI Generation Settings", href: urls.content },
      ],
    },
```

- [ ] **Step 3: Update `insight-segment/frontend/components/Nav.tsx`** (the one wrapper that doesn't spread `...URLS`)

```tsx
// insight-segment/frontend/components/Nav.tsx
import { Sidebar } from "../../../shared/frontend/Sidebar";

const urls = {
  web: import.meta.env.VITE_WEB_URL,
  link: import.meta.env.VITE_LINK_URL,
  insightSegment: "",
  flow: import.meta.env.VITE_FLOW_URL,
  content: import.meta.env.VITE_CONTENT_URL,
};

export function Nav() {
  return <Sidebar urls={urls} currentModule="profile" currentPath="/segments" />;
}
```

(`VITE_CONTENT_URL` is already declared in `insight-segment/frontend/env.d.ts` — no change needed there.)

- [ ] **Step 4: Typecheck every frontend that imports `Sidebar`**

```bash
cd flow && npm run typecheck
cd ../analytics && npm run typecheck
cd ../insight-segment && npm run typecheck
cd ../content && npm run typecheck
```

Expected: no errors in any of the four (the `content` module's own `Nav.tsx` from Task 9, referencing `URLS.content` and `SidebarUrls.content`, now resolves).

- [ ] **Step 5: Commit**

```bash
git add shared/frontend/urls.ts shared/frontend/Sidebar.tsx insight-segment/frontend/components/Nav.tsx
git commit -m "feat(nav): add content module to the shared sidebar"
```

---

## Task 11: CI wiring for the `content` module

**Files:**
- Modify: `.github/workflows/deploy-dev.yml`
- Modify: `.github/workflows/deploy-prod.yml`
- Modify: `/Users/zc/Documents/UniSCRM/uniscrm-web/CLAUDE.md`

**Interfaces:**
- Produces: `content` deploys automatically on merge to `main` (dev) and via manual dispatch (prod), same as every other module.

- [ ] **Step 1: Add `content` to `deploy-dev.yml`'s three matrices**

In the `sync-secrets` job's matrix, after the `trend-skill` entry:

```yaml
          - module: content
            config: content/wrangler.toml
```

In the `migrate` job's matrix, after the `trend-skill` entry:

```yaml
          - db: uniscrm-content-dev
            config: content/wrangler.toml
```

In the `deploy` job's matrix module list, change:

```yaml
        module: [web, link, flow, admin, analytics, insight-segment, profile, trend-skill]
```

to:

```yaml
        module: [web, link, flow, admin, analytics, insight-segment, profile, trend-skill, content]
```

- [ ] **Step 2: Apply the identical three edits to `deploy-prod.yml`** (matrix entries use `uniscrm-content` for the DB name there, no `-dev` suffix, matching every other prod matrix row)

```yaml
          - module: content
            config: content/wrangler.toml
```

```yaml
          - db: uniscrm-content
            config: content/wrangler.toml
```

```yaml
        module: [web, link, flow, admin, analytics, insight-segment, profile, trend-skill, content]
```

- [ ] **Step 3: Add `content` to root `CLAUDE.md`'s module list**

Find:

```
- admin: 租户管理，billing。
- flow: 基于reactflow的事件触发工作流。
- analytics: 多种SQL即席分析、和可视化报表。
- insight-segment: 基于profile的SQL规则分群。
- link: 统一渠道模块。social/content/commerce/lists统一在一个Worker中。
- metadata: event/user/flow等实体基于元数据配置。
- operation: 生产环境运维相关，可以存储一些修复数据的临时脚本。
- profile: maigret container做跨渠道查询。
- shared: 不是模块/worker。包含UI组件等所有模块通用的组件。
- web: 登录页及通用功能如设置等。
```

Add one line (alphabetical-ish placement matching the existing list's rough grouping, right after `admin`):

```
- admin: 租户管理，billing。
- content: 租户BYOK LLM key管理 + 内置skill配方 + 内容生成(/internal/generate)，供flow的aiRewritePublish action调用。
- flow: 基于reactflow的事件触发工作流。
- analytics: 多种SQL即席分析、和可视化报表。
- insight-segment: 基于profile的SQL规则分群。
- link: 统一渠道模块。social/content/commerce/lists统一在一个Worker中。
- metadata: event/user/flow等实体基于元数据配置。
- operation: 生产环境运维相关，可以存储一些修复数据的临时脚本。
- profile: maigret container做跨渠道查询。
- shared: 不是模块/worker。包含UI组件等所有模块通用的组件。
- web: 登录页及通用功能如设置等。
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-dev.yml .github/workflows/deploy-prod.yml CLAUDE.md
git commit -m "ci(content): wire content module into deploy-dev/deploy-prod matrices"
```

---

## Task 12: `skillId` on the `aiRewritePublish` action

**Files:**
- Modify: `flow/src/engine.ts:261-263`
- Modify: `flow/frontend/store/flow-editor.ts:130-131`
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Produces: `collectActions` includes `actionData.skillId` on `aiRewritePublish` actions; new `aiRewritePublish` nodes default to `skillId: ""`. Consumed by Task 14 (`executeContentActions` forwards it to `link`) and Task 16 (Inspector UI).

- [ ] **Step 1: Extend the existing test**

Find in `flow/tests/unit/engine.test.ts`:

```ts
  it("collects an aiRewritePublish action carrying its target channel", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "tiktok-chan-1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([
      { type: "aiRewritePublish", nodeId: "a1", hasBranches: true, targetChannelId: "tiktok-chan-1" },
    ]);
  });
```

Replace with:

```ts
  it("collects an aiRewritePublish action carrying its target channel and skill", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "tiktok-chan-1", skillId: "punchy-social" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([
      { type: "aiRewritePublish", nodeId: "a1", hasBranches: true, targetChannelId: "tiktok-chan-1", skillId: "punchy-social" },
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: FAIL — `skillId` missing from the actual result.

- [ ] **Step 3: Add `skillId` in `collectActions`**

In `flow/src/engine.ts`, find:

```ts
      if (actionType === "aiRewritePublish") {
        actionData.targetChannelId = targetNode.data.channelId as string;
      }
```

Replace with:

```ts
      if (actionType === "aiRewritePublish") {
        actionData.targetChannelId = targetNode.data.channelId as string;
        actionData.skillId = targetNode.data.skillId as string;
      }
```

- [ ] **Step 4: Run the tests**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: PASS.

- [ ] **Step 5: Default `skillId` in `flow-editor.ts`'s `addNode`**

In `flow/frontend/store/flow-editor.ts`, find:

```ts
      } else if (type === "aiRewritePublish") {
        data = { actionType: type, channelType: "", channelId: "" };
```

Replace with:

```ts
      } else if (type === "aiRewritePublish") {
        data = { actionType: type, channelType: "", channelId: "", skillId: "" };
```

- [ ] **Step 6: Typecheck**

```bash
cd flow && npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add flow/src/engine.ts flow/frontend/store/flow-editor.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): add skillId to aiRewritePublish action data"
```

---

## Task 13: Fix `resumeFromNode`'s action-branch handling (shared `buildActionData` helper)

**Files:**
- Modify: `flow/src/engine.ts`
- Test: `flow/tests/unit/engine.test.ts`

**Context:** `resumeFromNode`'s branch-edge handling currently builds a bare `{type: actionType}` for any `action`-type branch target — it doesn't populate `nodeId`, `hasBranches`, or any actionType-specific fields (`status` for `updateContentStatus`, `targetChannelId`/`skillId` for `aiRewritePublish`, etc.), and it never continues traversal past a non-branching action target. This means `updateContentStatus` downstream of `aiRewritePublish`'s success/failed handle would fire with `action.status` undefined today — the exact bug this plan's branch-resolution work (Task 14) depends on being fixed. Extract `collectActions`' per-node-type actionData construction into a shared helper both functions call, and make `resumeFromNode` continue traversal past non-branching action targets, matching `collectActions`' existing behavior.

**Interfaces:**
- Produces: `buildActionData(targetNode: FlowNode): ActionResult` (module-private in `engine.ts`) — used by both `collectActions` and `resumeFromNode`. `resumeFromNode`'s action-branch-target handling now recurses via `collectActions` for non-branching actions, exactly like `collectActions` already does for its own non-branching actions.

- [ ] **Step 1: Write the failing test**

```ts
// Add to flow/tests/unit/engine.test.ts
describe("resumeFromNode: action branch targets get full actionData", () => {
  it("populates status on an updateContentStatus branch target (not just {type})", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "chan-1", skillId: "punchy-social" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "a1", target: "a2", sourceHandle: "success" }],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "published" },
    ]);
  });

  it("continues traversal past a non-branching action branch target", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "chan-1" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
        { id: "a3", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "a1", target: "a2", sourceHandle: "success" },
        { id: "e2", source: "a2", target: "a3" },
      ],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "published" },
      { type: "addToList", nodeId: "a3", hasBranches: false, listId: "l1" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: FAIL — current `resumeFromNode` produces `{ type: "updateContentStatus" }` with no `status`/`nodeId`/`hasBranches`, and doesn't include `a3` at all.

- [ ] **Step 3: Extract `buildActionData` and use it in both functions**

In `flow/src/engine.ts`, find `collectActions`' action-node branch:

```ts
    if (targetNode.type === "action") {
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
      actions.push(actionData);
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });

      if (!isExternalApi) {
        collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      }
      continue;
    }
```

Replace with (extracting the actionData construction, keeping everything else identical):

```ts
    if (targetNode.type === "action") {
      const actionData = buildActionData(targetNode);
      actions.push(actionData);
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });

      if (!actionData.hasBranches) {
        collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      }
      continue;
    }
```

Add the extracted helper function right above `collectActions`'s definition:

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

Now find `resumeFromNode`'s branch-edge handling:

```ts
  if (branch) {
    const branchEdges = graph.edges.filter((e) => e.source === nodeId && e.sourceHandle === branch);
    for (const edge of branchEdges) {
      const target = graph.nodes.find((n) => n.id === edge.target);
      if (!target) continue;
      if (target.type === "action") {
        nodeLogs.push({ nodeId: target.id, direction: "enter" });
        const actionType = target.data.actionType as string;
        const actionData: ActionResult = { type: actionType };
        if (actionType === "addToList") actionData.listId = target.data.listId as string;
        if (actionType === "xAction") { actionData.xEvent = target.data.xEvent as string; actionData.channelId = target.data.channelId as string; if (target.data.messageText) actionData.messageText = target.data.messageText as string; }
        actions.push(actionData);
        nodeLogs.push({ nodeId: target.id, direction: "exit" });
      } else {
        collectActions(graph, target.id, payload, actions, pendingWaits, nodeLogs);
      }
    }
  } else {
    collectActions(graph, nodeId, payload, actions, pendingWaits, nodeLogs);
  }
```

Replace with:

```ts
  if (branch) {
    const branchEdges = graph.edges.filter((e) => e.source === nodeId && e.sourceHandle === branch);
    for (const edge of branchEdges) {
      const target = graph.nodes.find((n) => n.id === edge.target);
      if (!target) continue;
      if (target.type === "action") {
        nodeLogs.push({ nodeId: target.id, direction: "enter" });
        const actionData = buildActionData(target);
        actions.push(actionData);
        nodeLogs.push({ nodeId: target.id, direction: "exit" });
        if (!actionData.hasBranches) {
          collectActions(graph, target.id, payload, actions, pendingWaits, nodeLogs);
        }
      } else {
        collectActions(graph, target.id, payload, actions, pendingWaits, nodeLogs);
      }
    }
  } else {
    collectActions(graph, nodeId, payload, actions, pendingWaits, nodeLogs);
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: all PASS, including the two new tests.

- [ ] **Step 5: Typecheck**

```bash
cd flow && npm run typecheck
```

- [ ] **Step 6: Run the full flow test suite (regression check)**

```bash
cd flow && npx vitest run
```

Expected: all PASS — this refactor must not change behavior for `xAction`/`addToList`/existing `updateContentStatus` collection paths.

- [ ] **Step 7: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "fix(flow): resumeFromNode branch targets get full actionData, not just {type}"
```

---

## Task 14: Branch resolution in `executeContentActions` for `aiRewritePublish`

**Files:**
- Modify: `flow/src/index.ts`
- Modify: `flow/src/types.ts`
- Test: `flow/tests/unit/queue-content.test.ts`

**Context:** `executeContentActions` currently fires the `aiRewritePublish` fetch and only logs `res.status` — the graph's `success`/`failed` branch is never resolved. This task makes it call `resumeFromNode` on the outcome and recursively execute whatever's downstream, and handle X-side rate-limiting the same way `xAction` already does.

**Interfaces:**
- Consumes: `resumeFromNode`/`buildActionData` fix (Task 13), `CONTENT_URL` (added to `Env` here, bound in Task 20).
- Produces: `executeContentActions(graph: FlowGraph, actions: ActionResult[], contentId, channelId, tenantId, env, payload, flowId): Promise<{ rateLimited: {action: ActionResult; retryAt: string}[] }>` — signature changes (adds `graph` as first param, returns a result instead of `void`). Consumed by the `queue()` and `scheduled()` call sites (this task updates both) and by Task 15 (the `content_flow_pending` retry sweep).

**Note on `Env`:** this task does **not** touch `flow/src/types.ts` — `CONTENT_URL` is not consumed by `flow` directly, since `flow` only ever calls `LINK_URL` (never `content` directly); `link` is the one that calls `content`'s `/internal/generate`. `flow`'s `Env` does gain a `CONTENT_URL` field, but only in Task 16, for the unrelated `/api/skills` proxy route. Don't add it here — Task 16 adds it against the file's then-current state.

- [ ] **Step 1: Extend the failing test**

Add to `flow/tests/unit/queue-content.test.ts` (reuses the file's existing `makeBatch`/table-creation `beforeEach` — add `content_flow_pending` to the `beforeEach`'s `CREATE TABLE IF NOT EXISTS` block if not already present, it already is per the existing file):

```ts
describe("queue(): aiRewritePublish branch resolution", () => {
  const graphWithBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "target-chan-1", skillId: "punchy-social" }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });

  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-branch1', 1, 'branch flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-branch1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-branch1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-branch1'`).run();
    vi.unstubAllGlobals();
  });

  it("resolves the success branch and runs updateContentStatus(published) when link returns ok:true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-1", channelId: "src-chan", payload: {} }),
      env
    );

    // updateContentStatus tries to look up the tenant's d1_database_id and no-ops if missing
    // (same pattern the existing queue-content.test.ts beforeEach relies on) — what we're
    // actually asserting here is that the branch resolved and a second content_flow_executions
    // row was recorded for the resumed action, proving resumeFromNode fired.
    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(1);
  });

  it("resolves the failed branch when link returns ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 502 })));

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-2", channelId: "src-chan", payload: {} }),
      env
    );

    const rows = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-branch1'`
    ).first<{ c: number }>();
    expect(rows?.c).toBeGreaterThanOrEqual(1);
  });

  it("schedules a content_flow_pending retry row when link reports rateLimited, instead of resolving a branch immediately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-branch-3", channelId: "src-chan", payload: {} }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT retry_action, retry_count FROM content_flow_pending WHERE flow_id = 'flow-branch1' AND content_id = 'content-branch-3'`
    ).first<{ retry_action: string; retry_count: number }>();
    expect(pending?.retry_count).toBe(0);
    expect(JSON.parse(pending?.retry_action || "{}")).toMatchObject({ type: "aiRewritePublish" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd flow && npx vitest run tests/unit/queue-content.test.ts
```

Expected: FAIL — current `executeContentActions` never calls `resumeFromNode`, so no second `content_flow_executions` row appears and no `content_flow_pending` retry row is written.

- [ ] **Step 3: Rewrite `executeContentActions`**

In `flow/src/index.ts`, find:

```ts
async function executeContentActions(
  actions: ActionResult[],
  contentId: string,
  channelId: string,
  tenantId: string,
  env: Env,
  payload?: Record<string, unknown>,
  flowId?: string
): Promise<void> {
  for (const action of actions) {
    if (action.type === "repost") {
      const res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ channelId, contentId, flowId: flowId || null }),
      });
      console.log(JSON.stringify({ event: "content_action_repost", contentId, channelId, status: res.status }));
    } else if (action.type === "aiRewritePublish") {
      const targetChannelId = action.targetChannelId as string;
      const res = await fetch(`${env.LINK_URL}/internal/content/ai-rewrite-publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ contentId, sourceChannelId: channelId, targetChannelId, flowId: flowId || null }),
      });
      console.log(JSON.stringify({ event: "content_action_ai_rewrite_publish", contentId, targetChannelId, status: res.status }));
    } else if (action.type === "updateContentStatus" && action.status) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        await tdb.run(`UPDATE content SET status = ? WHERE id = ?`, [action.status as string, contentId]);
      }
    }
  }
}
```

Replace with:

```ts
interface ContentActionExecResult {
  rateLimited: { action: ActionResult; retryAt: string }[];
}

async function executeContentActions(
  graph: FlowGraph,
  actions: ActionResult[],
  contentId: string,
  channelId: string,
  tenantId: string,
  env: Env,
  payload: Record<string, unknown> = {},
  flowId?: string
): Promise<ContentActionExecResult> {
  const rateLimited: { action: ActionResult; retryAt: string }[] = [];

  for (const action of actions) {
    if (action.type === "repost") {
      const res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ channelId, contentId, flowId: flowId || null }),
      });
      console.log(JSON.stringify({ event: "content_action_repost", contentId, channelId, status: res.status }));
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

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = body.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
        rateLimited.push(...nested.rateLimited);
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
      }
      for (const wait of resumed.pendingWaits) {
        const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), flowId || "", wait.nodeId, contentId, Number(tenantId),
          JSON.stringify({ ...payload, channel_id: channelId }), executeAt, new Date().toISOString(),
          wait.awaitingEvent || "", wait.conditions ? JSON.stringify(wait.conditions) : ""
        ).run();
      }
    } else if (action.type === "updateContentStatus" && action.status) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        await tdb.run(`UPDATE content SET status = ? WHERE id = ?`, [action.status as string, contentId]);
      }
    }
  }

  return { rateLimited };
}
```

- [ ] **Step 4: Update both call sites to match the new signature**

In the `queue()` handler, find:

```ts
            if (result.actions.length > 0) {
              await executeContentActions(result.actions, contentId, channelId, tenantId, env, payload, flow.id);
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, new Date().toISOString()).run();
              console.log(JSON.stringify({ event: "content_flow_matched", flowId: flow.id, contentId, eventType, actions: result.actions }));
            }
```

Replace with:

```ts
            if (result.actions.length > 0) {
              const { rateLimited } = await executeContentActions(graph, result.actions, contentId, channelId, tenantId, env, payload, flow.id);
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, new Date().toISOString()).run();
              for (const rl of rateLimited) {
                await env.FLOW_DB.prepare(
                  `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                   VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
                ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, JSON.stringify(payload), rl.retryAt, new Date().toISOString(), JSON.stringify(rl.action)).run();
              }
              console.log(JSON.stringify({ event: "content_flow_matched", flowId: flow.id, contentId, eventType, actions: result.actions, rateLimited: rateLimited.length }));
            }
```

In the `scheduled()` handler's `content_flow_pending` sweep, find:

```ts
        if (result.actions.length > 0) {
          const channelId = String(payload.channel_id ?? "");
          await executeContentActions(result.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
        }
```

Replace with:

```ts
        if (result.actions.length > 0) {
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, result.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
          for (const rl of rateLimited) {
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
            ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
          }
        }
```

- [ ] **Step 5: Run the tests**

```bash
cd flow && npx vitest run tests/unit/queue-content.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
cd flow && npm run typecheck
```

- [ ] **Step 7: Run the full flow test suite (regression check — the cron `flow_pending` sweep also calls `executeActions`, unrelated to this signature change; and `scheduled-content.test.ts`'s existing `updateContentStatus`-only wait-resume scenario must still pass)**

```bash
cd flow && npx vitest run
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat(flow): resolve aiRewritePublish's success/failed branch at runtime"
```

---

## Task 15: `content_flow_pending` retry-action handling in `scheduled()`

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/scheduled-content.test.ts`

**Context:** Task 14 now writes `retry_action`/`retry_count` rows into `content_flow_pending` on a rate-limited `aiRewritePublish` response, but the `content_flow_pending` sweep in `scheduled()` doesn't check for `retry_action` at all yet (it only handles `awaiting_event`/plain wait rows) — mirror the `flow_pending` sweep's existing retry-action branch (lines ~932-951), but content-domain.

**Interfaces:**
- Consumes: `executeContentActions` (Task 14).
- Produces: retried `aiRewritePublish` actions get re-attempted up to 5 times before falling through to `resumeFromNode`'s `failed` branch, exactly like the user-domain `xAction` retry behavior.

- [ ] **Step 1: Write the failing test**

```ts
// Add to flow/tests/unit/scheduled-content.test.ts
describe("scheduled(): content_flow_pending retry_action handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-retry1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-retry1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-retry1'`).run();
    vi.unstubAllGlobals();
  });

  const graphWithBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "chan-1", skillId: "punchy-social" }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
    ],
  });

  it("re-attempts a rate-limited retry_action row and reschedules it again if still rate-limited", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-retry1', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "aiRewritePublish", nodeId: "a1", hasBranches: true, targetChannelId: "chan-1", skillId: "punchy-social" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retry-1', 'flow-retry1', '', 'content-retry-1', 1, '{}', ?, datetime('now'), ?, 0)`
    ).bind(past, JSON.stringify(action)).run();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    await worker.scheduled({} as any, env);

    const row = await env.FLOW_DB.prepare(`SELECT retry_count, execute_at FROM content_flow_pending WHERE id = 'pend-retry-1'`).first<{ retry_count: number; execute_at: string }>();
    expect(row?.retry_count).toBe(1);
    expect(row?.execute_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("resolves the branch and clears the row once no longer rate-limited", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-retry1', 1, 'retry flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const action = { type: "aiRewritePublish", nodeId: "a1", hasBranches: true, targetChannelId: "chan-1", skillId: "punchy-social" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-retry-2', 'flow-retry1', '', 'content-retry-2', 1, '{}', ?, datetime('now'), ?, 2)`
    ).bind(past, JSON.stringify(action)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-retry-2'`).first();
    expect(remaining).toBeNull();

    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-retry1' AND content_id = 'content-retry-2'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd flow && npx vitest run tests/unit/scheduled-content.test.ts
```

Expected: FAIL — the current `content_flow_pending` sweep query doesn't select `retry_action`/`retry_count` and has no branch for them, so the retry row is neither rescheduled nor resolved.

- [ ] **Step 3: Add retry-action handling to the `content_flow_pending` sweep**

In `flow/src/index.ts`, find:

```ts
    const contentPending = await env.FLOW_DB.prepare(
      `SELECT id, flow_id, node_id, content_id, tenant_id, payload, awaiting_event FROM content_flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; content_id: string; tenant_id: string; payload: string; awaiting_event: string }>();

    for (const row of contentPending.results) {
      try {
        const claim = await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
        if (!claim.meta.changes) continue;

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();
        if (!flow || flow.status !== "published") continue;

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);
        const branch = row.awaiting_event ? "no" : undefined;
        const result = resumeFromNode(graph, row.node_id, payload, branch);

        if (result.actions.length > 0) {
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, result.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
          for (const rl of rateLimited) {
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
            ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
          }
        }

        for (const wait of result.pendingWaits) {
          const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.content_id, row.tenant_id, row.payload, executeAt, now, wait.awaitingEvent || "").run();
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "content_flow_pending_error", id: row.id, error: String(e) }));
      }
    }
```

Replace with (query now selects `retry_action`/`retry_count`, and a new branch handles them before the existing claim-and-resume logic — mirroring the `flow_pending` sweep's own `retry_action` branch):

```ts
    const contentPending = await env.FLOW_DB.prepare(
      `SELECT id, flow_id, node_id, content_id, tenant_id, payload, awaiting_event, retry_action, retry_count FROM content_flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; content_id: string; tenant_id: string; payload: string; awaiting_event: string; retry_action: string; retry_count: number }>();

    for (const row of contentPending.results) {
      try {
        if (row.retry_action) {
          const action = JSON.parse(row.retry_action) as ActionResult;
          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(row.flow_id)
            .first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            continue;
          }
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const payload = JSON.parse(row.payload);
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, [action], row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);

          if (rateLimited.length > 0 && row.retry_count < 5) {
            await env.FLOW_DB.prepare(
              `UPDATE content_flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
            ).bind(rateLimited[0].retryAt, row.retry_count + 1, row.id).run();
            console.log(JSON.stringify({ event: "content_flow_retry_rescheduled", id: row.id, retryCount: row.retry_count + 1 }));
          } else {
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            if (rateLimited.length > 0) {
              console.log(JSON.stringify({ event: "content_flow_retry_exhausted", id: row.id, retryCount: row.retry_count }));
            }
          }
          continue;
        }

        const claim = await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
        if (!claim.meta.changes) continue;

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();
        if (!flow || flow.status !== "published") continue;

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);
        const branch = row.awaiting_event ? "no" : undefined;
        const result = resumeFromNode(graph, row.node_id, payload, branch);

        if (result.actions.length > 0) {
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, result.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
          for (const rl of rateLimited) {
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
            ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
          }
        }

        for (const wait of result.pendingWaits) {
          const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.content_id, row.tenant_id, row.payload, executeAt, now, wait.awaitingEvent || "").run();
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "content_flow_pending_error", id: row.id, error: String(e) }));
      }
    }
```

- [ ] **Step 4: Run the tests**

```bash
cd flow && npx vitest run tests/unit/scheduled-content.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck + full regression run**

```bash
cd flow && npm run typecheck && npx vitest run
```

Expected: no errors, all PASS.

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/scheduled-content.test.ts
git commit -m "feat(flow): retry rate-limited aiRewritePublish via content_flow_pending"
```

---

## Task 16: Skill picker in `AiRewritePublishInspector` + flow's `/api/skills` proxy

**Files:**
- Modify: `flow/src/index.ts`
- Modify: `flow/frontend/lib/api.ts`
- Modify: `flow/frontend/components/Inspector.tsx`

**Interfaces:**
- Consumes: `content`'s `GET /api/skills` (Task 8).
- Produces: `GET /api/skills` on `flow` (server-side proxy, mirroring the existing `/api/channels` proxy), `api.skills.list()` on the frontend, a skill `<Select>` in `AiRewritePublishInspector` writing `data.skillId`.

- [ ] **Step 1: Add `CONTENT_URL` to `flow`'s `Env`** (flow proxies to content for this one read-only call)

In `flow/src/types.ts`, find:

```ts
  LINK_URL: string;
  INTERNAL_SECRET: string;
```

Replace with:

```ts
  LINK_URL: string;
  CONTENT_URL: string;
  INTERNAL_SECRET: string;
```

- [ ] **Step 2: Add the proxy route in `flow/src/index.ts`**

Find the existing `/api/channels` proxy:

```ts
app.get("/api/channels", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const type = c.req.query("type") || "";
  const res = await fetch(`${linkUrl}/api/channels?type=${type}`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

Add immediately after it:

```ts
app.get("/api/skills", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/skills`);
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 3: Add `api.skills.list()` to `flow/frontend/lib/api.ts`**

Find the `ChannelOption` interface and the `channels` client object; add a sibling `skills` client:

```ts
export interface SkillOption {
  id: string;
  label: string;
}

export const api = {
  // ... existing channels, flows, etc. entries stay as-is ...
  skills: {
    list: (): Promise<{ skills: SkillOption[] }> => request("/api/skills"),
  },
};
```

(Exact placement depends on this file's existing export shape — add `skills` as a new top-level key alongside `channels` in the same exported `api` object, following whatever pattern the file already uses for `channels`/`flows`.)

- [ ] **Step 4: Add the skill picker to `AiRewritePublishInspector` in `flow/frontend/components/Inspector.tsx`**

Find:

```tsx
function AiRewritePublishInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channelType, setChannelType] = useState<string>(data.channelType || "");
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);

  useEffect(() => {
    if (!channelType) { setChannels([]); return; }
    api.channels.list(channelType).then(setChannels).catch(() => setChannels([]));
  }, [channelType]);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">AI Rewrite &amp; Publish</h4>
      <div className="space-y-3">
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

Replace with (adds a `skills` fetch and a new `<Select>` block):

```tsx
function AiRewritePublishInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channelType, setChannelType] = useState<string>(data.channelType || "");
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    if (!channelType) { setChannels([]); return; }
    api.channels.list(channelType).then(setChannels).catch(() => setChannels([]));
  }, [channelType]);

  useEffect(() => {
    api.skills.list().then((res) => setSkills(res.skills)).catch(() => setSkills([]));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">AI Rewrite &amp; Publish</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Skill</Label>
          {skills.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Loading skills...</p>
          ) : (
            <Select
              value={data.skillId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { skillId: e.target.value })}
              className="w-full text-sm"
            >
              <option value="">Select skill...</option>
              {skills.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          )}
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

- [ ] **Step 5: Typecheck**

```bash
cd flow && npm run typecheck
```

- [ ] **Step 6: Manual verification** (no automated frontend tests exist in this module per its established convention — see the framework plan's Global Constraints)

Run `npm run dev:worker` and `npm run dev` in `flow/`, open the flow editor, add an "AI Rewrite & Publish" action node, confirm the Skill dropdown populates from `content`'s `/api/skills` (requires `content`'s dev worker running too, per Task 20's `CONTENT_URL` wiring) and that selecting one persists via `updateNodeData`.

- [ ] **Step 7: Commit**

```bash
git add flow/src/types.ts flow/src/index.ts flow/frontend/lib/api.ts flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): skill picker in AiRewritePublishInspector"
```

---

## Task 17: `link`: X `createPost` method

**Files:**
- Modify: `link/src/services/x-posts-api.ts`
- Test: `link/tests/services/x-posts-api.test.ts`

**Interfaces:**
- Produces: `createPost(accessToken: string, text: string): Promise<{ ok: boolean; id?: string; rateLimited?: boolean }>` — consumed by Task 19.

- [ ] **Step 1: Write the failing test**

Add to `link/tests/services/x-posts-api.test.ts`:

```ts
import { createPost } from "../../src/services/x-posts-api";

describe("createPost", () => {
  it("posts text-only to /2/tweets and returns the new tweet id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "tweet-123", text: "hello" } }), { status: 201 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: true, id: "tweet-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ text: "hello world" });
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok:false on other non-ok statuses without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: false });
  });
});
```

(This file already has `fetchMock`/`beforeEach`/`afterEach` set up at the top, per the existing `fetchPostsPage` tests read during planning — the new `describe` block reuses that same fixture, no new setup needed.)

- [ ] **Step 2: Run it to verify it fails**

```bash
cd link && npx vitest run tests/services/x-posts-api.test.ts
```

Expected: FAIL — `createPost` doesn't exist.

- [ ] **Step 3: Add `createPost` to `link/src/services/x-posts-api.ts`**

Add at the end of the file:

```ts
export interface CreatePostResult {
  ok: boolean;
  id?: string;
  rateLimited?: boolean;
}

export async function createPost(accessToken: string, text: string): Promise<CreatePostResult> {
  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (res.status === 429) {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    return { ok: false };
  }

  const body = (await res.json()) as { data: { id: string; text: string } };
  return { ok: true, id: body.data.id };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd link && npx vitest run tests/services/x-posts-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd link && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add link/src/services/x-posts-api.ts link/tests/services/x-posts-api.test.ts
git commit -m "feat(link): add createPost (X /2/tweets, text-only)"
```

---

## Task 18: `link`: `ContentService.recordPublishedContent`

**Files:**
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts`

**Interfaces:**
- Produces: `recordPublishedContent(channelId: string, channelType: ChannelType, sourceContentId: string, contentText: string, ref: { generatedFromContentId: string; skillId: string }): Promise<void>` — inserts a `status: "published"` content row, no embedding/pipeline side effects (this is an outbound post the tenant already knows about, not synced content needing search/analytics treatment — a deliberate, smaller write path than `upsertContentFromMetadata`). Consumed by Task 19.

- [ ] **Step 1: Write the failing test**

Add to `link/tests/services/content.test.ts` (reusing the file's existing `tenantDb`/`vectorize`/`ai` mocks per its established pattern):

```ts
describe("recordPublishedContent", () => {
  it("inserts a published content row referencing the source content and skill", async () => {
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await svc.recordPublishedContent("target-chan-1", "X", "tweet-123", "generated post text", {
      generatedFromContentId: "source-content-1",
      skillId: "punchy-social",
    });

    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["target-chan-1", "X", "tweet-123", "generated post text", "published"])
    );
    const [, params] = tenantDb.run.mock.calls[tenantDb.run.mock.calls.length - 1];
    const rawData = JSON.parse(params.find((p: unknown) => typeof p === "string" && p.startsWith("{")) || "{}");
    expect(rawData).toEqual({ generatedFromContentId: "source-content-1", skillId: "punchy-social" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd link && npx vitest run tests/services/content.test.ts
```

Expected: FAIL — `recordPublishedContent` doesn't exist.

- [ ] **Step 3: Add the method to `ContentService`**

In `link/src/services/content.ts`, add after the `upsertContentFromMetadata` method (before `list`):

```ts
  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; skillId: string }
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.tenantDb.run(
      `INSERT INTO content (id, channel_id, channel_type, content_type, source_content_id, content_text, status, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, 'TWEET', ?, ?, 'published', ?, ?, ?)`,
      [id, channelId, channelType, sourceContentId, contentText, JSON.stringify(ref), now, now]
    );
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd link && npx vitest run tests/services/content.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd link && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "feat(link): ContentService.recordPublishedContent for AI-generated posts"
```

---

## Task 19: `link`'s real `/internal/content/ai-rewrite-publish` handler

**Files:**
- Modify: `link/src/routes-internal.ts`
- Modify: `link/src/types.ts`
- Test: `link/tests/services/routes-internal-content.test.ts`

**Context:** Replaces the `501` stub with the real implementation: load source content → call `content`'s `/internal/generate` → post to X → record the new content row. Ties together Tasks 7 (content's generate endpoint), 17 (`createPost`), and 18 (`recordPublishedContent`).

**Interfaces:**
- Consumes: `content`'s `POST /internal/generate` (Task 7), `createPost` (Task 17), `ContentService.recordPublishedContent` (Task 18), `XTokenService.getValidToken` (existing, unchanged).
- Produces: `POST /internal/content/ai-rewrite-publish` real behavior — `{ok: true}` / `{ok: false}` / `{ok: false, rateLimited: true, rateLimitReset}`.

- [ ] **Step 1: Add `CONTENT_URL` to `link`'s `Env`**

In `link/src/types.ts`, find:

```ts
  TREND_RETENTION_DAYS: string;
  LINK_URL: string;
  WEB_URL: string;
```

Replace with:

```ts
  TREND_RETENTION_DAYS: string;
  LINK_URL: string;
  CONTENT_URL: string;
  WEB_URL: string;
```

- [ ] **Step 2: Update the existing stub test to describe real behavior (this replaces `routes-internal-content.test.ts`'s ai-rewrite-publish test — the `/x/repost` stub test and the missing-secret test are untouched)**

Find in `link/tests/services/routes-internal-content.test.ts`:

```ts
  it("POST /internal/content/ai-rewrite-publish returns 501 not-implemented", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "chan-1", targetChannelId: "chan-2" }),
      }),
      testEnv
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, notImplemented: true });
  });
```

Replace with:

```ts
  it("POST /internal/content/ai-rewrite-publish generates, posts to X, and records the new content row", async () => {
    await env.LINK_DB.prepare(`DELETE FROM channels WHERE id IN ('src-chan', 'tgt-chan')`).run();
    await env.LINK_DB.prepare(
      `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, is_active, created_at, updated_at)
       VALUES ('tgt-chan', 'X', ?, 'x-user-1', 1, 1, datetime('now'), datetime('now'))`
    ).bind(JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null })).run();
    await env.WEB_DB.prepare(`INSERT INTO tenants (tenant_id, d1_database_id) VALUES (1, 'tenant-db-1') ON CONFLICT DO NOTHING`).run().catch(() => {});

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "generated post text" }), { status: 200 })) // content /internal/generate
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "tweet-999", text: "generated post text" } }), { status: 201 })); // X /2/tweets
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
      }),
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when generation fails", async () => {
    await env.LINK_DB.prepare(`DELETE FROM channels WHERE id IN ('src-chan', 'tgt-chan')`).run();
    await env.LINK_DB.prepare(
      `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, is_active, created_at, updated_at)
       VALUES ('tgt-chan', 'X', ?, 'x-user-1', 1, 1, datetime('now'), datetime('now'))`
    ).bind(JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null })).run();

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("generation error", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "src-chan", targetChannelId: "tgt-chan", skillId: "punchy-social" }),
      }),
      testEnv
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // generate only, no X call
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd link && npx vitest run tests/services/routes-internal-content.test.ts
```

Expected: FAIL — current handler still returns the `501` stub.

- [ ] **Step 4: Replace the stub in `link/src/routes-internal.ts`**

Find:

```ts
  // Stub: real TikTok Content Posting API (and X post-creation for the reverse
  // direction) not implemented yet — same reasoning as /x/repost above.
  router.post("/content/ai-rewrite-publish", async (c) => {
    const { contentId, sourceChannelId, targetChannelId } = await c.req.json<{
      contentId: string; sourceChannelId: string; targetChannelId: string; flowId?: string | null;
    }>();
    console.log(JSON.stringify({ event: "ai_rewrite_publish_stub_called", contentId, sourceChannelId, targetChannelId }));
    return c.json({ ok: false, notImplemented: true }, 501);
  });
```

Replace with (add the necessary imports at the top of the file: `import { ContentService } from "./services/content";`, `import { createPost } from "./services/x-posts-api";`, `import { XTokenService } from "./services/x-token";`, `import { TenantDataDB } from "../../shared/tenant-data-db";` — check the top of the file first and only add ones not already present, per its current imports listed earlier in this plan):

```ts
  // Real X publish path: content-ai's generated text gets posted to the target channel.
  // TikTok publish is out of scope this phase (see design spec's non-goals) — targetChannelId
  // resolving to a TIKTOK channel_type falls through to the generic ok:false path below.
  router.post("/content/ai-rewrite-publish", async (c) => {
    const { contentId, sourceChannelId, targetChannelId, skillId } = await c.req.json<{
      contentId: string; sourceChannelId: string; targetChannelId: string; skillId?: string; flowId?: string | null;
    }>();

    const targetChannel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(targetChannelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!targetChannel) return c.json({ ok: false }, 200);

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(targetChannel.tenant_id).first<{ d1_database_id: string | null }>();
    if (!tenantRow?.d1_database_id) return c.json({ ok: false }, 200);

    const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const sourceRows = await tenantDataDb.query<{ title: string | null; content_text: string | null; summary: string | null }>(
      "SELECT title, content_text, summary FROM content WHERE id = ?",
      [contentId]
    );
    const material = sourceRows[0] || {};

    const genRes = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
      body: JSON.stringify({
        tenantId: targetChannel.tenant_id,
        skillId,
        material: { title: material.title, content_text: material.content_text, summary: material.summary },
        targetPlatform: targetChannel.channel_type,
      }),
    });
    if (!genRes.ok) {
      console.error(JSON.stringify({ event: "ai_rewrite_publish_generate_failed", contentId, targetChannelId, status: genRes.status }));
      return c.json({ ok: false }, 200);
    }
    const { text } = await genRes.json<{ text: string }>();

    if (targetChannel.channel_type !== "X") {
      console.log(JSON.stringify({ event: "ai_rewrite_publish_unsupported_platform", contentId, targetChannelId, channelType: targetChannel.channel_type }));
      return c.json({ ok: false }, 200);
    }

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(targetChannelId);
    const postResult = await createPost(accessToken, text);

    console.log(JSON.stringify({ event: "ai_rewrite_publish_x_post", contentId, targetChannelId, ok: postResult.ok, rateLimited: !!postResult.rateLimited }));

    if (postResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!postResult.ok || !postResult.id) {
      return c.json({ ok: false }, 200);
    }

    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, targetChannel.tenant_id);
    await contentService.recordPublishedContent(targetChannelId, "X", postResult.id, text, {
      generatedFromContentId: contentId,
      skillId: skillId || "",
    });

    return c.json({ ok: true });
  });
```

- [ ] **Step 5: Add the new imports to the top of `link/src/routes-internal.ts`**

Find the existing imports:

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { CreditService, getActiveSubscriptionTier } from "../../shared/credit-service";
import { EventMetadata_X } from "../../metadata/x";
import { dollarsToMicros } from "../../shared/credit";
```

Add two new imports (everything else already present — `XTokenService`/`TenantDataDB` are already imported):

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { CreditService, getActiveSubscriptionTier } from "../../shared/credit-service";
import { EventMetadata_X } from "../../metadata/x";
import { dollarsToMicros } from "../../shared/credit";
import { ContentService } from "./services/content";
import { createPost } from "./services/x-posts-api";
```

- [ ] **Step 6: Run the tests**

```bash
cd link && npx vitest run tests/services/routes-internal-content.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck**

```bash
cd link && npm run typecheck
```

- [ ] **Step 8: Run the full link test suite (regression check)**

```bash
cd link && npx vitest run
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add link/src/routes-internal.ts link/src/types.ts link/tests/services/routes-internal-content.test.ts
git commit -m "feat(link): real ai-rewrite-publish handler (generate + X publish + content row)"
```

---

## Task 20: Wire `CONTENT_URL` into `link` and `flow`'s `wrangler.toml`

**Files:**
- Modify: `link/wrangler.toml`
- Modify: `flow/wrangler.toml`

**Interfaces:**
- Produces: `env.CONTENT_URL` available at runtime in both workers (already declared in each `Env` type by Tasks 16/19), pointing at the `content` worker deployed in Task 1/11.

- [ ] **Step 1: Add `CONTENT_URL` to `link/wrangler.toml`'s dev and production `vars` blocks**

Find (dev):

```toml
[env.dev.vars]
LINK_URL = "https://link-dev.uni-scrm.com"
TREND_RETENTION_DAYS = "30"
WEB_URL = "https://web-dev.uni-scrm.com"
```

Replace with:

```toml
[env.dev.vars]
LINK_URL = "https://link-dev.uni-scrm.com"
CONTENT_URL = "https://content-dev.uni-scrm.com"
TREND_RETENTION_DAYS = "30"
WEB_URL = "https://web-dev.uni-scrm.com"
```

Find (production):

```toml
[env.production.vars]
LINK_URL = "https://link.uni-scrm.com"
TREND_RETENTION_DAYS = "30"
WEB_URL = "https://web.uni-scrm.com"
```

Replace with:

```toml
[env.production.vars]
LINK_URL = "https://link.uni-scrm.com"
CONTENT_URL = "https://content.uni-scrm.com"
TREND_RETENTION_DAYS = "30"
WEB_URL = "https://web.uni-scrm.com"
```

- [ ] **Step 2: Add `CONTENT_URL` to `flow/wrangler.toml`'s dev and production `vars` blocks**

Find (dev):

```toml
[env.dev.vars]
WEB_URL = "https://web-dev.uni-scrm.com"
LINK_URL = "https://link-dev.uni-scrm.com"
CF_ACCOUNT_ID = "b34f3ff4aec4c36584672d5bf1320757"
INTERNAL_SECRET = "dev-internal-secret"
```

Replace with:

```toml
[env.dev.vars]
WEB_URL = "https://web-dev.uni-scrm.com"
LINK_URL = "https://link-dev.uni-scrm.com"
CONTENT_URL = "https://content-dev.uni-scrm.com"
CF_ACCOUNT_ID = "b34f3ff4aec4c36584672d5bf1320757"
INTERNAL_SECRET = "dev-internal-secret"
```

Find (production):

```toml
[env.production.vars]
WEB_URL = "https://web.uni-scrm.com"
LINK_URL = "https://link.uni-scrm.com"
INTERNAL_SECRET = "prod-internal-secret-change-me"
```

Replace with:

```toml
[env.production.vars]
WEB_URL = "https://web.uni-scrm.com"
LINK_URL = "https://link.uni-scrm.com"
CONTENT_URL = "https://content.uni-scrm.com"
INTERNAL_SECRET = "prod-internal-secret-change-me"
```

- [ ] **Step 3: Typecheck both modules**

```bash
cd link && npm run typecheck
cd ../flow && npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add link/wrangler.toml flow/wrangler.toml
git commit -m "config: wire CONTENT_URL into link and flow wrangler.toml"
```

---

## Task 21: Documentation updates

**Files:**
- Modify: `flow/sequence.md`
- Modify: `link/src/services/status.md`

**Interfaces:**
- No code interfaces — CLAUDE.md-mandated diagram updates only.

- [ ] **Step 1: Read the current `flow/sequence.md` and append the real generate+publish+branch-resolution path**

Read the file first (`cat flow/sequence.md`), then add a new `## Content-domain: aiRewritePublish (real generation + publish)` section with a mermaid `sequenceDiagram` block after the existing content-domain section, covering:

```
participant Link
participant Content
participant X as X API

Flow->>Link: POST /internal/content/ai-rewrite-publish
Link->>Content: POST /internal/generate
Content-->>Link: { text }
Link->>X: POST /2/tweets
X-->>Link: { id } | 429 | error
Link-->>Flow: { ok } | { ok:false, rateLimited:true }
Flow->>Flow: resumeFromNode(graph, nodeId, "success"|"failed")
Flow->>Link: (if updateContentStatus resolved) UPDATE content.status
```

(Exact diagram syntax and integration point depend on the existing file's structure — read it first and match its existing style/participant naming rather than introducing a second, disconnected diagram.)

- [ ] **Step 2: Read the current `link/src/services/status.md` and update the automation note**

Read the file first (`cat link/src/services/status.md`), find wherever it notes the `updateContentStatus`-driven transition as scaffolding/not-yet-real, and update that note to state it's now a real, automated write path (per Task 14's branch-resolution fix), not aspirational.

- [ ] **Step 3: Commit**

```bash
git add flow/sequence.md link/src/services/status.md
git commit -m "docs: update sequence/status diagrams for real BYOK generation + publish"
```

---

## Task 22: End-to-end verification

**Files:** none (verification only, per CLAUDE.md's completion gate).

- [ ] **Step 1: Start all three workers' dev servers** (in separate terminals)

```bash
cd content && npm run dev:worker    # port from wrangler.toml's default, or pass --port
cd link && npm run dev:worker
cd flow && npm run dev:worker
```

And their frontends:

```bash
cd content && npm run dev
cd link && npm run dev
cd flow && npm run dev
```

- [ ] **Step 2: Run every module's full test suite one more time**

```bash
cd content && npx vitest run
cd ../link && npx vitest run
cd ../flow && npx vitest run
```

Expected: all PASS across all three.

- [ ] **Step 3: Browser verification** (use a real logged-in session via `tabs_context_mcp`, per this project's established convention — do not fabricate a test account)

1. Navigate to `content-dev.uni-scrm.com`, confirm the "AI Generation Settings" page loads via the shared sidebar, save a (test/dummy) OpenAI key, confirm it round-trips (page reload shows "Currently using your own openai key").
2. Navigate to `flow-dev.uni-scrm.com`, open or create a Content Flow, add a `contentTrigger` → `aiRewritePublish` (select a skill and a target X channel) → verify the Inspector shows both the skill dropdown and target account picker populated.
3. Publish the flow. Trigger it by causing a genuinely new X post to be ingested by the tenant's connected channel (or, if a live X post isn't practical to arrange, confirm via `wrangler tail` / console logs on `content-dev` and `link-dev` that `POST /internal/generate` and `POST /internal/content/ai-rewrite-publish` fire correctly end-to-end when a `content.created` queue message is manually enqueued for a real `contentId`).
4. Confirm in the tenant's D1 (`wrangler d1 execute <tenant db> --command "SELECT status FROM content WHERE id = '<source contentId>'"`) that `status` flips to `published` once the flow completes.

- [ ] **Step 4: Report completion** only once all of Steps 1-3 pass — per this project's CLAUDE.md, dev-server + browser verification is required before declaring the feature done.
