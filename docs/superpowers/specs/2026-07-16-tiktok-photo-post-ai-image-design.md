# TikTok Photo-Post Content Action with AI Image Generation

## Context

`metadata/tiktok.ts` already declares a `photo-post` `ContentMetadata` entry (`flowType: "action"`) with three props: `title` (`aiType: "TEXT"`), `description` (`aiType: "TEXT"`), `message_image` (`aiType: "IMAGE"`, maps to TikTok's `source_info.photo_images[]`). No code consumes `aiType` yet — it was added as prep work. `content`'s `/internal/generate` only produces text today; there is no image-generation capability anywhere in the codebase, and no object storage (R2) binding in any module.

The existing `xContentAction` node (X-only: `create-post`/`repost-post`) is not touched by this design — TikTok gets its own node type, per explicit product decision, rather than generalizing `xContentAction` to be multi-channel.

TikTok's photo-post publish path (`/v2/post/publish/content/init/`) is entirely new integration work: today `link`'s TikTok code only reads (`video.list` polling), and the connected OAuth scope (`user.info.basic,video.list`) has no publish permission at all.

## Non-goals (this phase)

- Video posts (only photo-post).
- Public visibility / `DIRECT_POST` mode — the TikTok developer app is not yet audited, so `DIRECT_POST` would be forced to `SELF_ONLY`. This design uses `MEDIA_UPLOAD` (draft-to-inbox) instead: the flow action generates content and hands it to the user's TikTok app inbox; a human opens the app and taps Post to actually publish. This is a different automation model than every other action in this flow system today (X create-post/repost fully auto-publish) — accepted tradeoff given app-audit status.
- Per-tenant image-model selection in a settings page. Image models are fixed constants (see below); no UI to change them this phase.
- Proactive "needs reconnect" detection for existing TikTok channels missing the new OAuth scope. A photo-post attempt against an unreconnected channel simply fails at the TikTok API call and takes the existing failed-branch/error-log path, same as any other third-party API error.
- Status polling after publish. Per `flow/CLAUDE.md`'s existing third-party-action convention (branch decided by HTTP response: 2xx → success, 4xx/5xx/timeout → failed), the `init` call's own response decides the branch. No follow-up call to check final delivery status.

## 1. Node: `tiktokContentAction`

New, standalone action type (not a variant of `xContentAction`). **Metadata-driven fields**: rather than hardcoding Title/Description/Image as fixed node fields, the Inspector renders one prompt input per entry in `metadata/tiktok.ts`'s `photo-post` `contentProps` (`title`/TEXT, `description`/TEXT, `message_image`/IMAGE), typed by each entry's `aiType`. This keeps the node in step with the project's metadata-driven convention — adding/removing a TEXT or IMAGE prop on that metadata entry changes the Inspector without touching component code. Node data shape:

```ts
{
  actionType: "tiktokContentAction",
  channelId: string,           // TikTok channel to post from

  prompts: Record<string, string>,   // keyed by contentProps propId, e.g. { title: "...", description: "...", message_image: "..." } — $content.xxx interpolation, like xContentAction's prompt
  textProvider: "default" | "openai" | "anthropic" | "none",
  textSkillId: string,         // "none" or a content skill catalog id — applies to every TEXT-typed prop

  imageCount: number,          // 1-9 — applies to the (one) IMAGE-typed prop
  imageProvider: "default" | "openai",   // no "anthropic" (no image API), no "none" (a post needs an image)
  imageSkillId: string,        // "none" or a content skill catalog id
}
```

**Inspector panel** (`TikTokContentActionInspector`, new component alongside `XContentActionInspector` in `Inspector.tsx`):

1. **Target Account** — channel picker filtered to `channelType: "TIKTOK"` (`api.channels.list("TIKTOK")`), same pattern as `xContentAction`'s Target Account.
2. For each entry in `ContentMetadata_TikTok.find(m => m.sourceContentType === "photo-post")!.contentProps`: a `Textarea` labeled with that prop's `label` (looked up from `metadata/props.ts`'s `PROPS` registry by `propId`), bound to `data.prompts[propId]`, `$content.xxx` interpolation hint — same style as `xContentAction`'s Prompt field, rendered once per prop rather than as fixed Title/Description/Image fields.
3. **Text Provider** — `Select`: `default` (Cloudflare Workers AI) / `openai` / `anthropic` (only BYOK providers actually configured for the tenant appear, via the existing `api.llmProviders.list()`) / `none` (post interpolated prompt text literally). Applies to every `aiType: "TEXT"` prop's generation call. Identical semantics to `xContentAction`'s Provider.
4. **Text Skill** — `Select`, reusing the existing `api.skills.list()` catalog and `none` default. Applies to every TEXT prop (one shared value, not per-field).
5. **Image Count** — numeric input, 1-9, default 1. Applies to the `aiType: "IMAGE"` prop (`message_image` today — photo-post has exactly one image prop; a future metadata entry with multiple image props is out of scope, YAGNI).
6. **Image Provider** — `Select`: `default` (Cloudflare Workers AI, flux-1-schnell) / `openai` (BYOK, gpt-image-1). No `none` option — an image field can't be satisfied by literal text.
7. **Image Skill** — independent `Select` from Text Skill, same catalog. Its cached content (if any) is folded directly into the image prop's prompt string, uncapped — a skill whose content is too long for the image provider simply produces a provider error, handled like any other generation failure (explicit accepted tradeoff, no special-casing).

`link`'s new `/internal/tiktok/photo-post` route (§3) is not fully metadata-generic — it's inherently specific to the `photo-post` operation already, so it reads `prompts.title`/`prompts.description`/`prompts.message_image` by their known propIds (matching TikTok's actual `post_info.title`/`post_info.description`/`source_info.photo_images` fields) rather than re-deriving field names from metadata at the `link` layer. The metadata-driven behavior is scoped to the flow node's UI and data shape, not threaded further into `link`'s TikTok-specific publish logic.

`hasBranches: true` for this action type (calls a third-party API) — add `"tiktokContentAction"` alongside `"xAction"`/`"xContentAction"` wherever `isExternalApi`/branch-rendering is checked (`flow/src/engine.ts`'s `buildActionData`, and the node-rendering code that draws success/failed output handles).

## 2. Image generation (new, in `content`)

New provider abstraction, parallel to the existing text `LlmProvider` interface:

```ts
// content/src/providers/image-interface.ts
export interface ImageProvider {
  generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}
```

- `content/src/providers/workers-ai-image.ts` (`WorkersAiImageProvider`): calls `env.AI.run(model, { prompt, steps: 4 })`. **flux-1-schnell's response is `{ image: string }`, a base64-encoded JPEG** (not raw binary/ArrayBuffer, unlike the text models' response shape) — decode with `Uint8Array.fromBase64`/manual base64 decode into bytes, `contentType: "image/jpeg"`. Default model constant: `@cf/black-forest-labs/flux-1-schnell` (no `width`/`height` params — this model has no documented resolution controls beyond `steps`; output size is whatever the model produces natively).
- `content/src/providers/openai-image.ts` (`OpenAiImageProvider`): `POST https://api.openai.com/v1/images/generations` with `{ model: "gpt-image-1", prompt, size: "1024x1024" }`, response format `b64_json`, decoded to bytes. Uses the tenant's existing `openai` BYOK API key (`getTenantLlmCredentials(env, tenantId, "openai")`) — ignores that row's `model` field (that's the tenant's configured *text* model; images always use the fixed `gpt-image-1` constant).

New service `content/src/services/generate-image.ts`:

```ts
export interface GenerateImageParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai";
  skillId?: string;
}
export async function generateImage(env: Env, params: GenerateImageParams): Promise<{ bytes: ArrayBuffer; contentType: string }>
```

Skill content (if `skillId` set and cached) is appended to `prompt` as plain text before calling the provider — no system-role equivalent for image APIs, no truncation.

New internal route in `content/src/routes-internal.ts`:

```
POST /internal/generate-image
Body: { tenantId: number, prompt: string, provider: "default"|"openai", skillId?: string }
Response: 200 with body = raw image bytes, header Content-Type: <contentType>
          502 on generation failure (provider error, missing BYOK credentials, etc.)
```

No new D1 table — per top-level `CLAUDE.md`'s rule against storing external payloads in the DB, image bytes pass straight through and are never persisted in `content`.

## 3. Storage & TikTok publish (new, in `link`)

All external-channel interaction lives in `link`, per this repo's module boundary — `content` never talks to TikTok directly.

- **New R2 bucket binding** on `link`: `MEDIA_BUCKET` (resource name `uniscrm-link-media-dev` / `uniscrm-link-media` for prod, following the project's `uniscrm`-prefix / env-suffix naming convention). This is a genuinely new Cloudflare resource — accepted, since transient public image hosting has no existing binding to reuse.
- **R2 lifecycle rule**: expire objects after 48 hours (configured on the bucket, not in application code) — plenty of margin for TikTok's pull-based fetch, keeps storage bounded automatically.
- **New public route**, no auth: `GET /public/media/:key` in `link/src/index.ts`, streams the object from `MEDIA_BUCKET` (404 if missing/expired).
- **New service** `link/src/services/tiktok-publish.ts`:
  ```ts
  export async function initPhotoPost(
    accessToken: string,
    photoUrls: string[],
    title: string,
    description: string
  ): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }>
  ```
  Calls `POST https://open.tiktokapis.com/v2/post/publish/content/init/` with `media_type: "PHOTO"`, `post_mode: "MEDIA_UPLOAD"`, `source_info: { source: "PULL_FROM_URL", photo_images: photoUrls, photo_cover_index: 0 }`, `post_info: { title, description }`. `ok` reflects `error.code === "ok"` in the response; a `rate_limit_exceeded` error code maps to `rateLimited: true` (six requests/minute per TikTok's docs), same pattern `x-repost` already uses for X's rate limits.
- **New internal route** `POST /internal/tiktok/photo-post` in `link/src/routes-internal.ts`:
  ```
  Body: { contentId, channelId, prompts: { title, description, message_image },
          textProvider, textSkillId, imageCount, imageProvider, imageSkillId, flowId }
  ```
  `prompts` is keyed by `metadata/tiktok.ts`'s `photo-post` propIds (already interpolated by `flow` before this call) — this route reads `prompts.title`/`prompts.description`/`prompts.message_image` directly by those known names rather than re-deriving field names from metadata (see §1's closing note).
  Handler steps:
  1. Load the channel row (must be `channel_type: "TIKTOK"`), get `tenant_id` and a valid access token (existing `TikTokTokenService.getValidToken`, `link/src/services/tiktok-token.ts`).
  2. Resolve title text: if `textProvider === "none"`, use `prompts.title` literally; else call `content`'s `/internal/generate` with `{tenantId, prompt: prompts.title, provider: textProvider, skillId: textSkillId}`. Same for `prompts.description`.
  3. Generate `imageCount` images: `imageCount` independent calls to `content`'s `/internal/generate-image` with `{tenantId, prompt: prompts.message_image, provider: imageProvider, skillId: imageSkillId}`. Best-effort — a failed call is dropped, not retried.
  4. If zero images succeeded → return `{ ok: false }` (failed branch), do not call TikTok at all.
  5. Store each successful image's bytes into `MEDIA_BUCKET` under a fresh UUID key, build its public URL (`${LINK_URL}/public/media/:key`).
  6. Call `initPhotoPost` with the public URLs + generated title/description.
  7. Log the outcome (`event: "tiktok_photo_post"`, `contentId`, `channelId`, `ok`, `imagesRequested`, `imagesSucceeded`) — success/failure is decided purely by step 6's HTTP response, no polling.

## 4. Flow wiring

- `flow/src/engine.ts`'s `buildActionData`: new branch for `actionType === "tiktokContentAction"`, copying `channelId`, the `prompts` record (as-is, un-interpolated — engine.ts doesn't need to know propId names, it's just a nested object), `textProvider`, `textSkillId`, `imageCount`, `imageProvider`, `imageSkillId` onto `actionData` (mirroring the existing `xContentAction` branch), plus adding `"tiktokContentAction"` to the `isExternalApi` check.
- `flow/src/index.ts`'s `executeContentActions`: new `else if (action.type === "tiktokContentAction")` branch (parallel to the existing `xContentAction` one). Interpolates `$content.xxx` into every value inside `action.prompts` (same regex the existing code uses for `prompt`), builds the request body as `{contentId, channelId, prompts: {...interpolated}, textProvider, textSkillId, imageCount, imageProvider, imageSkillId, flowId}`, calls `link`'s new `/internal/tiktok/photo-post`, and branches success/failed exactly like the existing code path (same `rateLimited` handling, same `resumeFromNode`/`emitContentNodeLogs` flow).

## 5. OAuth scope

`link/src/oauth.ts`'s `/tiktok/connect` route: scope string changes from `user.info.basic,video.list` to `user.info.basic,video.list,video.upload` (per TikTok's docs, `video.upload` is required for the `MEDIA_UPLOAD` post mode). Existing connected channels are untouched — no migration, no forced reconnect prompt. A photo-post attempt against a channel connected before this change fails at TikTok's API (insufficient scope) and surfaces through the handler's normal `{ ok: false }` failed-branch path.

## 6. Manual, one-time steps outside this code

- Verify the domain serving `/public/media/*` (`link-dev.uni-scrm.com` for dev, `link.uni-scrm.com` for prod) with TikTok's domain-verification process (required for `PULL_FROM_URL`) before this feature works end-to-end in each environment.
- `wrangler r2 bucket create uniscrm-link-media-dev` / `uniscrm-link-media` and configure the 48h lifecycle rule, then add the `[[r2_buckets]]` binding block to `link/wrangler.toml`.

## Error handling summary

| Failure point | Behavior |
|---|---|
| Title/description generation fails (provider ≠ none) | Whole action fails (`{ ok: false }`) — text is required for `post_info`. |
| Some image generations fail (1 ≤ N < imageCount succeed) | Proceed with whichever images succeeded — best-effort, per explicit product decision. |
| All image generations fail (0 succeeded) | Whole action fails, no TikTok call made. |
| TikTok `init` call fails (any error code ≠ "ok", excluding rate limit) | Failed branch, error logged. |
| TikTok rate-limited (six req/min exceeded) | Same `rateLimited` retry-queue mechanism as `x-repost`/`create-post` today. |
| Channel missing `video.upload` scope | TikTok API call itself fails → failed branch, no special detection code. |

## Testing

Follow this codebase's existing patterns (`vi.stubGlobal("fetch", ...)` for external calls, `@cloudflare/vitest-pool-workers`'s `env` import for D1/R2/AI bindings):

- `content`: new tests for `WorkersAiImageProvider`/`OpenAiImageProvider` (mock `env.AI.run` / `fetch`), `generateImage` service (skill content folded into prompt, provider dispatch), `/internal/generate-image` route (200 with image bytes + content-type, 502 on failure).
- `link`: new tests for `tiktok-publish.ts` (`initPhotoPost` request shape, rate-limit mapping), `/internal/tiktok/photo-post` route (best-effort partial image success, all-fail short-circuit, R2 object write + public URL construction, TikTok call assembly), `/public/media/:key` route (200 streaming existing object, 404 for missing key), updated `/tiktok/connect` scope string.
- `flow`: `buildActionData` test for the new `tiktokContentAction` branch (field copying, `isExternalApi`/`hasBranches`), `executeContentActions` test for the new branch (prompt interpolation, request body shape, success/failed/rateLimited handling) — mirroring the existing `xContentAction` test coverage in `flow/tests/unit/engine.test.ts` and the `queue-content`/`index` test suites.
