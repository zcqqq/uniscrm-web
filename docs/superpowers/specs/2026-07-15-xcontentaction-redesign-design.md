# `xContentAction` Redesign: BYOK Content Generation, Simplified

## Context

The just-shipped 22-task plan (`docs/superpowers/specs/2026-07-15-content-module-byok-generation-design.md`) built `aiRewritePublish`: a content-domain flow action with a **skill dropdown** (picking a curated system-prompt recipe from `content`'s skill catalog) + target platform/account, calling `content`'s `/internal/generate` (skill + material → text) then `link`'s X `create-post`.

After using it, the design is being simplified based on direct product feedback, modeled on n8n's Basic LLM Chain node (prompt field with expression interpolation, connected to a separate model/credential selector — collapsed here into one node for simplicity) and this codebase's own existing `xAction` pattern (operation dropdown + interpolatable text field, e.g. `create-dm`'s `messageText` supporting `$user.username`/`$event.message_text`).

## What's Changing

- **`aiRewritePublish` → `xContentAction`**: a new action type, still content-domain (triggered by `contentTrigger`), styled after `xAction`'s UI pattern (operation dropdown + relevant fields) rather than a standalone custom node.
- **Skill catalog removed entirely.** No more curated recipes, no `/api/skills`, no skill dropdown. The prompt is now a free-text field directly in the node.
- **Prompt becomes a multi-line textarea** with `$content.xxx` interpolation — substituted by `flow` itself before calling `link`, using the exact same mechanism already used for `xAction`'s `create-dm` `messageText` (`/\$(user|event)\.(\w+)/g` → extended to also match `content`).
- **Provider becomes an explicit per-node dropdown**: `default` (Cloudflare Workers AI, always available) / `openai` / `anthropic` (each only appears in the dropdown if that BYOK key is actually configured for the tenant) / `none` (skip AI entirely — post the interpolated prompt text literally, no LLM call).
- **Tenant LLM credentials become multi-provider**: a tenant can configure an OpenAI key *and* an Anthropic key simultaneously (independent slots), not a single active provider. Settings page UI becomes card-based (reusing the existing `ChannelCard` component from `link/frontend/components/ChannelCard.tsx`), one card per provider, each with an API key field and a simple model dropdown.
- **`content`'s `/internal/generate` contract simplifies**: `{tenantId, prompt, provider} → {text}` — no more `skillId`/`material`/`targetPlatform`. `provider` is explicit, never resolved via smart fallback (the UI only ever offers a provider that's actually configured).
- **`link`'s real handler simplifies**: no longer queries the source `content` row from tenant D1 at all (that was only needed to build the "material" object for the skill system — now moot, since `flow` already resolved `$content.xxx` into the final prompt string before calling `link`). For `provider: "none"`, `link` skips calling `content` entirely.

## 1. Metadata

Extend `ContentMetadata` in `metadata/dataTypes.ts` to match `EventMetadata`'s shape (mirroring the existing `flowType`/`label`/`price` fields `EventMetadata` already has):

```ts
export interface ContentMetadata {
  linkPrefix?: string;
  sourceContentType: string;
  flowType?: string;      // "trigger" or "action" — new
  price?: number;          // new
  label?: LocalizedString; // new
  description?: LocalizedString; // new
  contentProps: PropMapping[];
}
```

Add one entry to `metadata/x.ts` (new export, alongside the existing `EventMetadata_X`):

```ts
export const ContentMetadata_X: ContentMetadata[] = [
  {
    sourceContentType: "create-post",
    flowType: "action",
    label: { en: "Create Post", zh: "新建推文" },
    contentProps: [],
  },
];
```

Only one entry exists today (matches the current X-only, create-post-only scope) — the array structure lets future operations (or TikTok's own metadata file) slot in later without restructuring the node/engine code.

## 2. Node: `xContentAction`

Replaces `aiRewritePublish` as the action type name throughout (`engine.ts`, `flow-editor.ts`, `ActionNode.tsx`, `Inspector.tsx`, `Sidebar.tsx`).

**Node data:** `{ actionType: "xContentAction", operation: "create-post", prompt: string, provider: "default"|"openai"|"anthropic"|"none", channelType: string, channelId: string }`

**Inspector panel, in order:**
1. **Operation** — dropdown sourced from `ContentMetadata_X.filter(m => m.flowType === "action")` (today: one option, "Create Post"). Mirrors how `xAction`'s dropdown is a hardcoded literal list today — this one is metadata-sourced from the start, matching the design intent that more operations arrive later purely by extending the metadata array.
2. **Prompt** — a `Textarea` (not `Input` — prompts are longer than the single-line `messageText` case), placeholder hinting at `$content.title`/`$content.text` interpolation, same style as the existing `create-dm` messageText hint (`"Use $user.name, $event.message_text etc."`).
3. **Provider** — a `Select` populated by fetching the tenant's configured providers (new endpoint, see below) plus the always-present `default`/`none`.
4. **Target Platform** / **Target Account** — unchanged from the current `aiRewritePublish` Inspector (still needed to know which channel to post to).

**Engine (`collectActions`/`buildActionData`):** for `actionType === "xContentAction"`, collect `{prompt, provider, targetChannelId}` (drop `skillId` entirely).

## 3. Interpolation (in `flow`, before calling `link`)

In `executeContentActions` (or a small helper it calls), before firing the request to `link`, interpolate the prompt:

```ts
const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
```

(A separate, dedicated regex for `content` rather than folding into the existing `/\$(user|event)\.(\w+)/g` — the content domain's `payload` shape and the user domain's are unrelated, and keeping them as separate replace calls avoids the two domains' interpolation logic becoming entangled.)

## 4. `link`'s real handler (replaces the current `ai-rewrite-publish` logic)

```
POST /internal/content/create-post
{ contentId, interpolatedPrompt, provider, targetChannelId, flowId? }
```

`contentId` is still the id of the content row that triggered this (already available to `flow` — `executeContentActions` already carries it for `content_flow_executions`/`updateContentStatus`) — it's passed through purely for traceability, not to be queried/loaded by `link` anymore.

1. Load the target channel (unchanged — still needed for the X access token).
2. If `channel_type !== "X"` → `{ok: false}` (TikTok still out of scope).
3. If `provider === "none"` → skip straight to step 5 using `interpolatedPrompt` as the final text.
4. Else → `POST {CONTENT_URL}/internal/generate` with `{tenantId, prompt: interpolatedPrompt, provider}` → `{text}`. Bail `{ok:false}` if not ok.
5. `createPost` (unchanged) with the final text.
6. On success: `recordPublishedContent` with `ref: { generatedFromContentId: contentId, flowId }` (drops `skillId`, keeps the source-content reference for traceability since it's already on hand — no new query needed).

No more tenant-D1 content-row query in this handler — the entire "material" concept is gone.

## 5. `content`: skill removal + generate contract change

- **Delete:** `content/src/skills/*`, the skill-related exports/routes/tests (Task 2, and the skill-related parts of Tasks 6/7/8).
- **`content/src/services/generate.ts`** becomes: `generateContent(env, {tenantId, prompt, provider}): Promise<string>` — no skill lookup, no material-shape building. `provider` dispatch: `"default"` → `WorkersAiProvider`; `"openai"`/`"anthropic"` → look up that specific provider's credentials (must exist — the caller already only offers configured providers, but the function still throws clearly if missing, rather than silently falling back, matching the "no silent downgrade" principle from the design discussion).
- **`/internal/generate`** route body becomes `{tenantId, prompt, provider}`.

## 6. Multi-provider BYOK credentials

**Schema change** — `content/migrations/000X_multi_provider_credentials.sql`:

```sql
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

(A destructive migration is acceptable here — this is a dev-only feature with no real tenant data yet, per the project's "重要关联数据用逻辑删除" rule applying to *production* data, not pre-launch schema iteration.)

**Service (`llm-credentials.ts`)** — reworked to key everything by `(tenantId, provider)`:
- `getTenantLlmCredentials(env, tenantId, provider): Promise<{apiKey, model} | null>` — decrypts, for one specific provider.
- `setTenantLlmCredentials(env, tenantId, provider, apiKey, model): Promise<void>` — upsert on `(tenant_id, provider)`.
- `listConfiguredProviders(env, tenantId): Promise<{provider: string, model: string}[]>` — no decryption, just which providers exist + their model (drives both the settings page's card statuses and the flow node's provider dropdown).
- `deleteTenantLlmCredentials(env, tenantId, provider): Promise<void>` — new, needed for a "disconnect" action on the card UI.

**Routes** — `GET /api/llm-credentials` returns the list (`listConfiguredProviders`, no decryption); `PUT /api/llm-credentials` takes `{provider, apiKey, model}`; new `DELETE /api/llm-credentials/:provider`.

**Settings page** — rebuilt around `ChannelCard` (`link/frontend/components/ChannelCard.tsx`, reused directly — it's a generic, already-polished component: logo/name/status-dot/actions-footer/extra-slot). One card per provider (OpenAI, Anthropic):
- `status`: `"connected"` if configured, `"disconnected"` otherwise.
- `actions`: a "Configure"/"Edit" button opening a small form (API key + model dropdown) inline or in a dialog; a "Disconnect" button when connected.
- Model dropdown: a short curated list per provider (e.g. OpenAI: `gpt-4o-mini`, `gpt-4o`; Anthropic: `claude-3-5-haiku-latest`, `claude-3-5-sonnet-latest`) — simple, not a live-fetched model list.

**`flow`'s new proxy**: `GET /api/llm-providers` (mirroring the existing `/api/skills`/`/api/channels` proxy pattern) → forwards to `content`'s `GET /api/llm-credentials`, used to populate the node's Provider dropdown with only the configured providers plus the always-present `default`/`none`.

## Non-goals (unchanged from the prior design)

- TikTok publish still out of scope.
- Image/video attachments still out of scope.
- Credit/pricing charges for `default` (Workers AI) usage — deferred; `xContentAction` costs nothing in platform credits this phase, matching how BYOK-provider usage already costs nothing (tenant's own key/cost) and keeping `none` (plain text post) free as well. Revisit if/when a credit model for Workers-AI-backed actions is needed elsewhere.

## Testing

Every already-shipped test touching the removed/changed surfaces needs updating, not just new tests:
- `content`: delete `tests/skills.test.ts`, `tests/providers/*` stay (providers themselves are unchanged), `tests/generate.test.ts` rewritten for the new `{tenantId, prompt, provider}` contract, `tests/routes-internal.test.ts` and `tests/routes-api.test.ts` rewritten for the new request/response shapes, new `tests/llm-credentials.test.ts` cases for multi-provider get/set/list/delete.
- `flow`: `engine.test.ts`'s `aiRewritePublish` tests become `xContentAction` tests (drop skillId, add prompt/provider); a new interpolation test for `$content.xxx` in the content-domain execution path.
- `link`: `routes-internal-content.test.ts`'s `ai-rewrite-publish` tests move to the new `create-post` route path and drop the source-content-row mocking (no longer queried).
