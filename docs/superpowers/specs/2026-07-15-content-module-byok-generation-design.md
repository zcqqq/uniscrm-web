# Content Module: BYOK Content Generation + X Auto-Publish Design

## Context

`docs/superpowers/plans/2026-07-14-content-flow-triggers.md` (and its spec, `2026-07-14-content-flow-triggers-design.md`) built the content-domain flow framework: `contentTrigger` node, `repost`/`aiRewritePublish`/`updateContentStatus` action types, `content_flow_pending`/`content_flow_executions` tables, queue dispatch, cron sweep, domain-split Flows UI. Two things were deliberately left as stubs in that plan (see its Global Constraints and Non-goals):

- `link`'s `/internal/content/ai-rewrite-publish` and `/internal/x/repost` return `501 { ok: false, notImplemented: true }` — no real generation or publish happens yet.
- The engine never resolves an external-API action's `success`/`failed` branch at runtime (`collectActions` stops traversing at any `hasBranches: true` node) — so `updateContentStatus`, scaffolded downstream of `aiRewritePublish` in the flow graph, can never actually fire.

**This spec assumes that framework is complete** (all 17 tasks landed, matching the maintainer's direction) and covers the remaining two pieces needed for the flagship scenario — *"see my new X post → AI-rewrite → publish to TikTok/X"* — to work end-to-end:

1. A new **`content` worker**: tenant BYOK LLM keys, a curated skill catalog, and a single generation endpoint.
2. **`link`'s real `/internal/content/ai-rewrite-publish` implementation**, replacing the stub, plus the **flow-engine branch-resolution fix** that makes its `success`/`failed` outcome actually reach `updateContentStatus`.

`repost` (retweeting the tenant's own content) stays out of scope here — it was already a non-goal of the framework plan and is unrelated to AI generation.

## Scope

- BYOK (tenant-supplied OpenAI/Anthropic key) text generation from a curated "skill" prompt recipe + source content, with a Workers AI (Llama) fallback for tenants without a key.
- Real X `create-post` (text-only) wired into the existing `aiRewritePublish` action.
- Making `aiRewritePublish`'s success/failed branch actually resolve at runtime, content-domain only (not touching the existing, separately-shipped `xAction` user-domain path).
- Rate-limit retry for the publish step, reusing `content_flow_pending`'s already-existing-but-unused `retry_action`/`retry_count` columns, mirroring the pattern already shipped for `xAction`.

## Non-goals

- `repost` (real X repost / TikTok Content Posting API) — separate, already deferred.
- TikTok publish — first phase is X-only; TikTok BYOK/generation reuses the same `content` module later without redesign (the `/internal/generate` contract is platform-agnostic; only the `link`-side publish call is X-specific this phase).
- Image/video generation or attachment — text-only posts.
- Tenant-uploaded custom skills — code-constant, platform-curated catalog only.
- Human-in-the-loop approval before publish — fully automatic, consistent with the rest of `flow`'s action model.

## 1. `content` worker — new module

Scaffolded like `insight-segment`: Hono app, own D1 database, own frontend, own `wrangler.toml` with `-dev` suffix convention (`uniscrm-content-dev` / `uniscrm-content`).

```
content/
  src/
    index.ts              # Hono app: /api/* (session-authed) + mounts internalRoutes()
    routes-internal.ts    # POST /internal/generate
    types.ts              # Env, request/response shapes
    services/
      llm-credentials.ts  # encrypt/decrypt/read tenant_llm_credentials
      generate.ts         # orchestrates: load skill, load credentials, pick provider, call it
    providers/
      openai.ts
      anthropic.ts
      workers-ai.ts        # @cf/meta/llama-3.3-70b-instruct-fp8-fast, non-streaming
      interface.ts         # LlmProvider { generate(system, user): Promise<string> }
    skills/
      index.ts             # SKILL_CATALOG: Skill[]
      social-punchy.ts
      professional-rewrite.ts
      ...                  # 2-3 curated skills to start
  migrations/
    0001_init.sql           # tenant_llm_credentials
  frontend/
    pages/SettingsPage.tsx  # provider + key form
    ...
  wrangler.toml
  package.json
```

**Auth split:** `/internal/*` uses the existing `X-Internal-Secret` header convention (same as `link`'s internal routes) — no tenant session involved, since `link` calls it server-to-server. `/api/*` (the settings UI) resolves `tenantId`/`memberId` by calling `web`'s `/api/auth/me` over `fetch` with the forwarded session cookie, exactly like `insight-segment`'s auth middleware.

### Data model

```sql
-- content/migrations/0001_init.sql
CREATE TABLE tenant_llm_credentials (
  tenant_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,           -- 'openai' | 'anthropic'
  encrypted_api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

One row per tenant (single active provider+key — not one row per provider). `encrypted_api_key` uses the `uniscrm-byok` package directly (same tag-pinned GitHub dependency `link` already uses for X BYOK) — content-ai's own master key, bound as `ENCRYPTION_KEY` from a **separate** Secrets Store secret (`uniscrm-content-encryption-key[-dev]`), decoupled from `link`'s X-credential master key even though the encryption primitive is shared code. This keeps the "couple via data, not logic" rule intact: `content` never calls into `link` to encrypt/decrypt.

### Skill catalog

Code constants, not a table — matches the earlier decision (platform-curated, no tenant upload in v1):

```ts
// content/src/skills/interface.ts (conceptually)
interface Skill {
  id: string;
  label: string;
  systemPrompt: string; // curated recipe content, adapted from marketing-skills style guidance
}
```

`content/src/skills/index.ts` exports `SKILL_CATALOG: Skill[]`, consumed by both `GET /api/skills` (for the flow node's dropdown) and `generate.ts` (lookup by `skillId`). Actual skill copy (2-3 to start, e.g. a punchy social rewrite and a professional-tone rewrite) gets authored during implementation, not fixed in this spec.

### Provider abstraction

```ts
interface LlmProvider {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}
```

`generate.ts`'s selection logic:
1. Look up `tenant_llm_credentials` for `tenantId`. If found: decrypt the key, instantiate `openai.ts` or `anthropic.ts` per `provider`, call it. This is genuinely new code — no OpenAI/Anthropic SDK call exists anywhere in this repo today (the only precedent, `flow`'s copilot, uses the Workers AI binding).
2. If not found (or the BYOK call throws): fall back to `workers-ai.ts`, using `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (same model `flow`'s copilot uses), non-streaming — the caller needs the final text before posting, not a stream.

### The one internal endpoint

```
POST /internal/generate
{ tenantId: string, skillId: string, material: { title?, content_text?, summary? }, targetPlatform: "X" | "TIKTOK" }
→ 200 { text: string }
→ 4xx/5xx on skill-not-found / generation failure (no retry logic here — retry lives in flow, see below)
```

No queue, no async — plain request/response, called inline from `link`'s real action handler.

## 2. `link`: real `/internal/content/ai-rewrite-publish`

Replaces the `501` stub. Behind the existing `internalAuthMiddleware` (`X-Internal-Secret`), unchanged.

```
POST /internal/content/ai-rewrite-publish
{ contentId, sourceChannelId, targetChannelId, flowId? }
```

Handler steps:
1. Load the source `content` row (`contentId`) from the tenant's D1 → `{title, content_text, summary}` as material.
2. Resolve `targetChannelId`'s `channel_type` (X or TIKTOK) from the `channels` table.
3. `POST {CONTENT_URL}/internal/generate` with `{tenantId, skillId, material, targetPlatform}` (the `aiRewritePublish` action data now carries `skillId` — see §3). On failure, return `{ ok: false }` immediately — no X call is made.
4. On success (`{text}`): call a new `createPost(accessToken, text)` method on `link/src/services/x-posts-api.ts` — `POST https://api.x.com/2/tweets`, text-only, using the target channel's existing token/BYOK-app-credential resolution (`XTokenService`, `getAppCredentials` — unchanged).
5. On a 2xx from X: insert a new `content` row for the target channel via a new `ContentService.recordPublishedContent(channelId, channelType, sourceTweetId, text, { generatedFromContentId: contentId, skillId })` method — `status: "published"` set directly at insert (it's already a live post, not something awaiting triage). `raw_data` stores only the traceability reference (source `contentId`, `skillId`), never the full X API response payload (logged via `console.log` instead, per the project-wide "no full external payloads in the DB" rule).
6. On a 429 from X: same rate-limit-tracking pattern `xAction` already uses (`rate_limits` table, keyed e.g. `x:create-post:<targetChannelId>`) — return a rate-limited signal to `flow` rather than a hard failure.
7. Return `{ ok: true }` / `{ ok: false }` / `{ ok: false, rateLimited: true, rateLimitReset }` to `flow`.

## 3. `flow`: `skillId` on `aiRewritePublish` + branch resolution

**`skillId` field:** `AiRewritePublishInspector` gains a skill dropdown (fetched from `content`'s `GET /api/skills`), alongside its existing target-platform/channel pickers. `engine.ts`'s `collectActions` picks it up: `actionData.skillId = targetNode.data.skillId as string`, next to the existing `actionData.targetChannelId` line. `flow-editor.ts`'s `addNode` default data for `aiRewritePublish` gains `skillId: ""`.

**Branch resolution (the deferred gap):** `executeContentActions` in `flow/src/index.ts` currently fires the `/internal/content/ai-rewrite-publish` request and only logs `res.status` — it never acts on the outcome. This spec changes that, content-domain only:

- After the fetch, on `ok: true` or `ok: false` (non-rate-limited), call `resumeFromNode(graph, nodeId, payload, ok ? "success" : "failed")` and recursively run whatever actions/pendingWaits that returns through `executeContentActions` again (typically `updateContentStatus`, which is what actually writes the source row's `content.status`).
- On `rateLimited: true`, instead of resolving a branch immediately, insert a row into `content_flow_pending` with `retry_action = JSON.stringify(action)`, `retry_count = 0`, `execute_at = rateLimitReset` — reusing columns the framework plan's migration already created but never populated. The existing `content_flow_pending` cron sweep gains a `retry_action` branch mirroring the one the user-domain `flow_pending` sweep already has (retry up to 5 times, then resolve the `failed` branch on exhaustion).
- The existing, separately-shipped `xAction` (user-domain) branch-resolution gap is **not** touched by this change — same root cause, different domain, out of scope here (flagging again for the record, not re-opening it).

## 4. Documentation updates (CLAUDE.md-mandated)

- **`flow/sequence.md`** (existing, appended by the framework plan's Task 16) — extend the content-domain sequence to show the real `content` worker call and the new branch-resolution / retry loop (previously it only showed a call into a stub).
- **`link/src/services/status.md`** (existing) — note that the `new → pending → published | ignored` transition via `updateContentStatus` is now a real, automated write path (previously documented as scaffolding only).
- No new diagrams for `content` itself: `/internal/generate` is synchronous request/response, not a queue.

## 5. CI / deployment

- Add `content` to the `deploy-dev.yml` / `deploy-prod.yml` module, migrate, and sync-secrets matrices (mirroring how `insight-segment` was onboarded).
- Provision `uniscrm-content-dev` / `uniscrm-content` D1 databases and the `uniscrm-content-encryption-key[-dev]` Secrets Store secret.
- Add `CONTENT_URL` to `link`'s `wrangler.toml` vars (dev/prod), mirroring the existing `LINK_URL` pattern in `flow`'s config.
- Add `content` to root `CLAUDE.md`'s module list.

## Testing

- `content`: unit tests for provider selection (BYOK found → correct provider client; not found → Workers AI fallback; BYOK call throws → falls back), skill lookup, credential encrypt/decrypt round-trip.
- `link`: unit test for the real `/internal/content/ai-rewrite-publish` handler — mocked `content` fetch + mocked X fetch, covering success, generate-failure (no X call made), X-failure, and X-429 (rate-limit path).
- `flow`: unit test extending `queue-content.test.ts`/`scheduled-content.test.ts` for branch resolution — a graph with `aiRewritePublish` → `success`/`failed` handles → `updateContentStatus` on each, asserting the right one fires based on the mocked `link` response; a rate-limited response schedules a `content_flow_pending` retry row instead.
- Manual dev-server + browser verification (per CLAUDE.md): connect an X BYOK channel, configure a flow with a skill + target channel, trigger via a real post, confirm the rewritten post appears on X and the source content's status flips to `published`.
