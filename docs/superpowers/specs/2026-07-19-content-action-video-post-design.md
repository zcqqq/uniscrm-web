# Content Actions: Video Posting (X create-post, TikTok video-post) — Design

## Context

`xContentAction`'s `create-post` operation and `tiktokContentAction` currently publish
text/images only — `create-post` sends `{text}` to `POST /2/tweets`
(`link/src/services/x-posts-api.ts:128-147`), and `tiktokContentAction` always runs a
hardcoded photo-post shape (`metadata/tiktok.ts`'s only action entry, `photo-post`) that
generates AI images and posts them via `POST /v2/post/publish/content/init/` with
`media_type: "PHOTO"` (`link/src/services/tiktok-publish.ts`).

This design adds video support to both, sourced from `$content.processed_video_url` — a
payload field written by an upstream video-processing node in the same content flow
(the sibling **Video Action: Add Subtitle** design,
[2026-07-19-video-action-add-subtitle-design.md](2026-07-19-video-action-add-subtitle-design.md),
not yet implemented). **This design covers only the consumer side** — how
`xContentAction`/`tiktokContentAction` read that field and publish it. Producing the
field is entirely out of scope here.

No AI video generation exists in this codebase and none is introduced by this design —
`processed_video_url` always originates from a video-*processing* node acting on the
triggering content's own video, never a tenant upload and never a freshly AI-generated
clip.

## Key fact established during design

`payload` is already threaded through the whole flow-engine recursion
(`resumeFromNode`/`collectActions`/`executeContentActions` in `flow/src/engine.ts` and
`flow/src/index.ts`) as the **same mutable object reference** — never cloned, never
frozen. A node that does `payload.processed_video_url = url` before calling
`resumeFromNode(graph, nodeId, payload, branch)` already propagates that value to every
downstream node's `$content.*` interpolation. **No engine change is required** for this
data to flow — the sibling video-action design's own resume route is what performs that
write; this design is a pure consumer.

## Decisions

1. **TikTok**: new operation `video-post`, added to `ContentMetadata_TikTok`
   (`metadata/tiktok.ts`) alongside the existing `photo-post`. Mutually exclusive,
   selected via an Operation dropdown (new — `TikTokContentActionInspector` doesn't have
   one today, since only one operation existed). Video is implicit/mandatory for this
   operation — no video checkbox, no video contentProp; the backend always requires
   `payload.processed_video_url` when this operation runs.
2. **TikTok endpoint**: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
   (different from photo's `.../content/init/`), `source_info: {source: "PULL_FROM_URL",
   video_url}`. Same fire-and-forget shape as photo-post today — returns a `publish_id`,
   no status polling (TikTok's servers pull and process the video asynchronously on their
   own side; this codebase doesn't wait for it, matching existing photo-post behavior).
3. **X**: `create-post` gets an optional "attach video" checkbox, modeled as a
   `contentProps` entry reusing the already-defined-but-unused `message_video` prop
   (`metadata/props.ts`, `dataType: "VIDEO"`) with `aiType: "VIDEO"`. Default unchecked.
   Text-only `create-post` behavior is unchanged when unchecked.
4. **Metadata semantics**: `aiType: "VIDEO"` is a new case, distinct from the existing
   `TEXT`/`IMAGE` aiTypes (which both mean "AI-generates content from this prompt").
   `VIDEO` means "reference `$content.processed_video_url` if the author opts in" — never
   AI-generated, never prompted. `XContentActionInspector` renders it as a checkbox, not
   a prompt textarea.
5. **X OAuth scope**: `X_CHANNEL_SCOPES` (`shared/x-scopes.ts`) gains `media.write` — one
   shared array, both `web/worker/api/oauth.ts` and `link/src/oauth.ts` inherit it
   automatically. Already-connected X channels lack this scope (today's `create-post`
   never touches media at all). First video-post attempt on such a channel fails with a
   clear error; the tenant reconnects via the existing Social-page reconnect flow — no
   new UI, no proactive scope check.
6. **Video size cap**: 50MB. Read via a stream: pull ~5MB chunks directly from the R2
   fetch response's `ReadableStream` and `APPEND` each one immediately — never buffer the
   whole file into one `ArrayBuffer` (a 128MB Worker isolate has less headroom than it
   looks once `slice()` copies and the outgoing fetch body are accounted for). The 50MB
   figure bounds total request duration and APPEND call count, not memory footprint.
7. **Missing video at execution time**: if the checkbox is checked (X) or `video-post` is
   selected (TikTok) but `payload.processed_video_url` is absent when the action runs,
   the action fails outright — `failed` branch, no silent fallback to text-only/no-op.
   Same precedent as `videoCondition`'s missing-thumbnail handling.
8. **X async video processing — ownership split**: X's chunked upload FINALIZE step
   returns `processing_info` for video that is frequently not `succeeded` immediately —
   the `media_id` cannot be attached to a tweet until it is. This cannot complete
   synchronously in one Worker request. **`flow` owns the wait/resume** via its existing
   `content_flow_pending` table and per-minute `scheduled()` sweep
   (`flow/wrangler.toml:65,112` — `crons = ["* * * * *"]`, confirmed each run, not
   hourly). **`link` exposes one stateless endpoint** that `flow`'s sweep calls
   repeatedly: given a `media_id`, it checks STATUS, and if `succeeded`, immediately
   posts the tweet and returns the terminal result — so `flow` never needs a second
   "finalize" call.
9. **Poll ceiling**: reuse the existing `retry_count < 5` pattern already used for
   rate-limit retries in the same sweep (`flow/src/index.ts:1257`) — no new threshold.
   Because the sweep only ticks once a minute, 5 retries is roughly 5 minutes of real
   wall-clock time (not X's own `check_after_secs`, which is typically 5-10s but is
   floored by the cron's 1-minute granularity). Exhausted → `failed` branch, consistent
   with `flow/CLAUDE.md`'s "rate limit重试耗尽后才走failed分支" rule generalized to this
   second kind of retry.
10. **Completion bar for this work**: since the producer (video-action node) doesn't
    exist yet, this feature is inert end-to-end — there is nothing to click through in a
    browser. "Done" means passing unit/integration tests with a mocked
    `payload.processed_video_url`. Real browser/e2e verification is explicitly deferred
    until the sibling video-action design is implemented.

## Data model

### `metadata/x-byok.ts` — `create-post` gains a video prop

```ts
{
  sourceContentType: "create-post",
  flowType: "action",
  price: 0.010,
  label: {"en":"Create Post", "zh":"发推文"},
  description: {"en":"Publish a new post via the triggering channel", "zh":"..."},
  contentProps: [
    {propId: "message_text", aiType:"TEXT"},
    {propId: "message_video", aiType:"VIDEO"},
  ],
},
```

### `metadata/tiktok.ts` — new `video-post` entry

```ts
{
  sourceContentType: "video-post", // https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
  flowType: "action",
  label: {"en":"Video Posting", "zh":"发布视频"},
  description: {"en":"Posts the content flow's processed video to TikTok as a draft.", "zh":"将内容流处理后的视频发布为TikTok草稿。"},
  contentProps: [
    {propId: "title", dataId:"post_info.title", aiType:"TEXT"},
    {propId: "description", dataId:"post_info.description", aiType:"TEXT"},
  ],
},
```

No `message_video` prop here — video is implicit to the operation, not a toggle. The
existing `photo-post` entry is unchanged.

### `metadata/dataTypes.ts` / `metadata/props.ts`

No changes — `PropMapping.aiType` already includes `"VIDEO"`, and `message_video` (`dataType:
"VIDEO"`) already exists, unused until now.

## Backend

### `shared/x-scopes.ts`

```ts
export const X_CHANNEL_SCOPES = [
  // ...existing entries...
  "media.write",
];
```

### `link/src/services/x-posts-api.ts` — chunked upload + status

New functions, mirroring the existing style in this file (plain `fetch`, typed result
objects, `rateLimited`/`ok` shape):

- `initMediaUpload(accessToken, totalBytes, mediaType): {mediaId}` —
  `POST https://api.x.com/2/media/upload` with `command=INIT`, `media_category:
  "tweet_video"`.
- `appendMediaChunk(accessToken, mediaId, segmentIndex, chunk: Uint8Array): void` —
  `command=APPEND`, multipart body.
- `finalizeMediaUpload(accessToken, mediaId): {state, checkAfterSecs}` —
  `command=FINALIZE`.
- `getMediaUploadStatus(accessToken, mediaId): {state, checkAfterSecs}` —
  `GET .../media/upload?command=STATUS&media_id=...`.
- `createPost(accessToken, text, mediaId?)` — extended (not replaced) to optionally
  include `media: {media_ids: [mediaId]}` in the request body.

### `link/src/routes-internal.ts` — `POST /internal/content/create-post`

Extended to accept an optional `videoUrl` in the request body. When present:

1. Fetch `videoUrl` (the R2-served `$content.processed_video_url`), reject over 50MB
   (`Content-Length` check before streaming, and a running-byte-count guard during the
   stream as a backstop).
2. `initMediaUpload` → stream ~5MB chunks from the response body, `appendMediaChunk` each
   → `finalizeMediaUpload`.
3. If `state === "succeeded"` (can happen immediately for small/simple clips): proceed
   to `createPost(accessToken, text, mediaId)` as normal, return `{ok: true, id}`.
4. If `state` is `pending`/`in_progress`: return a new response shape
   `{ pending: true, mediaId, checkAfterSecs }` instead of `{ok}` — text and channel
   context are already known to `flow` (it sent them), so nothing else needs echoing.
5. If `state === "failed"` (or the fetch/size check fails): `{ok: false}`, same as any
   other failure today.

### `link/src/routes-internal.ts` — new `POST /internal/content/x-video-status`

Stateless. Body: `{channelId, mediaId, text}`. Looks up the channel's token
(`XTokenService`, same as the existing route), calls `getMediaUploadStatus`:
- `succeeded` → `createPost(accessToken, text, mediaId)`, record published content
  (same `ContentService.recordPublishedContent` call as the existing path), return
  `{ok: true, id}` or `{ok: false}` if the post call itself fails.
- `pending`/`in_progress` → `{pending: true, checkAfterSecs}`.
- `failed`/anything else → `{ok: false}`.

This single endpoint is both "check status" and "finalize+post" — `flow`'s sweep never
needs a second call once it sees `succeeded`.

### `link/src/services/tiktok-publish.ts` — `initVideoPost`

```ts
export async function initVideoPost(
  accessToken: string,
  videoUrl: string,
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }>
```

Same response-parsing shape as `initPhotoPost`, posting to
`https://open.tiktokapis.com/v2/post/publish/video/init/` with `source_info: {source:
"PULL_FROM_URL", video_url: videoUrl}` and `post_info: {title, description}`.

### `link/src/routes-internal.ts` — new `POST /internal/tiktok/video-post`

Parallel to the existing `/internal/tiktok/photo-post`: generates `title`/`description`
via the same `generateText` helper, then calls `initVideoPost` with the (already
interpolated by `flow`) video URL. Same rate-limit/error/`recordPublishedContent`
handling as `photo-post`, with `content_type: "VIDEO_POST"` instead of `"PHOTO_POST"`.

## Engine (`flow`)

### `flow/src/engine.ts` — `buildActionData`

```ts
if (actionType === "xContentAction") {
  actionData.operation = (targetNode.data.operation as string) || "create-post";
  actionData.prompt = targetNode.data.prompt as string;
  actionData.provider = targetNode.data.provider as string;
  actionData.skillId = (targetNode.data.skillId as string) || "none";
  actionData.attachVideo = !!targetNode.data.attachVideo;
}
if (actionType === "tiktokContentAction") {
  actionData.operation = (targetNode.data.operation as string) || "photo-post";
  actionData.channelId = targetNode.data.channelId as string;
  // ...existing fields unchanged...
}
```

### `flow/src/index.ts` — `executeContentActions`

**`xContentAction`, `create-post` branch**: when `action.attachVideo` is true, resolve
`String(payload?.processed_video_url ?? "")`; empty → resume `"failed"` immediately (no
network call). Otherwise pass `videoUrl` to `/internal/content/create-post`. Handle the
new `{pending: true, mediaId, checkAfterSecs}` shape: instead of resolving a branch,
insert a `content_flow_pending` row (see below) and return without calling
`resumeFromNode` yet.

**`tiktokContentAction`**: branch on `action.operation` — `"photo-post"` keeps today's
call to `/internal/tiktok/photo-post` unchanged; `"video-post"` resolves
`payload?.processed_video_url` (empty → immediate `"failed"`, no network call) and calls
the new `/internal/tiktok/video-post` with the interpolated `title`/`description`
prompts and the resolved URL.

### `content_flow_pending` — X video poll rows

No new table, no new column. `retry_action` already carries an arbitrary JSON blob
(today only ever an `ActionResult` for rate-limit retry). This design adds a second
shape, discriminated by a `type` field the sweep checks before assuming the
rate-limit-retry shape:

```json
{ "type": "xVideoStatusPoll", "channelId": "...", "mediaId": "...", "text": "...", "nodeId": "..." }
```

Insert: `execute_at = now + max(checkAfterSecs, 60)s` (floored to the cron's 1-minute
granularity), `retry_count = 0`.

Sweep (`flow/src/index.ts`, the `if (row.retry_action)` branch around line 1243): parse
`retry_action`; if `type === "xVideoStatusPoll"`, call
`/internal/content/x-video-status` instead of `executeContentActions`:
- `{ok: true}` → `resumeFromNode(graph, nodeId, payload, "success")`, delete the row,
  continue exactly like the existing resolved-branch handling (insert
  `content_flow_executions`, process nested actions/waits).
- `{ok: false}` → same, with `"failed"`.
- `{pending: true}` and `retry_count < 5` → `UPDATE ... SET execute_at = ?, retry_count
  = retry_count + 1` (mirrors the existing rate-limit reschedule at line 1257-1261).
- `{pending: true}` and `retry_count >= 5` → resolve `"failed"` (mirrors the existing
  "retries exhausted" block at line 1264-1293), delete the row.

## Frontend (`flow/frontend/components/Inspector.tsx`)

### `XContentActionInspector`

Today's `aiProp` lookup (`selectedOperation?.contentProps.find((p) => p.aiType)`) is
narrowed to `aiType !== "VIDEO"` so it keeps resolving to `message_text` for
`create-post` (VIDEO must never be mistaken for the prompt-textarea prop). A separate
`videoProp` lookup (`aiType === "VIDEO"`) renders, only when present on the selected
operation, a checkbox:

```
[ ] Attach video (uses this flow's processed video, if any)
```

bound to `data.attachVideo` (default `false`/unchecked).

### `TikTokContentActionInspector`

Gains an Operation dropdown (new — mirrors `XContentActionInspector`'s
`OperationSelect`), sourced from `ContentMetadata_TikTok`'s action entries the same way
`CONTENT_ACTION_OPERATIONS` does for X. `photo-post` keeps rendering exactly what it
renders today (title/description prompts, image props, image count, image
provider/skill). `video-post` renders only the title/description prompts (its two
`TEXT` contentProps) — no image fields, no video field (implicit).

## Prompt generation (`flow/nodeTypeRegistry.ts`)

`CONTENT_X_ACTION_BULLETS`'s `hasAiProp` check (line 72,
`m.contentProps.some((p) => p.aiType)`) currently means "has a prompt-driven prop" and
drives the "prompt = free-text instructions for AI generation" guidance line. This must
narrow to `p.aiType === "TEXT" || p.aiType === "IMAGE"` so `create-post`'s new
`message_video` (aiType `VIDEO`) doesn't get miscategorized — `create-post` already has
`message_text` (TEXT), so its guidance text is unaffected either way, but the check
itself needs to be correct for future operations that might have *only* a VIDEO prop.
The bullet for `create-post` gains a mention of the optional video attachment.

`tiktokContentAction`'s `promptFragment` is hand-written today (not derived from
metadata, since only one operation existed). With a second operation, align it with
`xContentAction`'s pattern: derive per-operation bullets from
`ContentMetadata_TikTok`'s action entries the same way `CONTENT_X_ACTION_BULLETS` does,
rather than hand-maintaining prose that will drift as operations are added.

## Testing

Per this repo's TDD convention, each backend function above gets unit tests with mocked
`fetch` (following the existing pattern in `link/tests/services/`). Specifically:
- `x-posts-api.ts`: INIT/APPEND/FINALIZE/STATUS happy path, 429 rate-limit, non-200
  errors, `createPost` with `media_ids`.
- `routes-internal.ts` `/internal/content/create-post`: video present + succeeded
  immediately; video present + pending (returns the new shape); video present + over
  50MB (rejected); no video (existing text-only path, unchanged, regression-tested).
- `routes-internal.ts` `/internal/content/x-video-status`: succeeded → posts + records;
  pending; failed.
- `tiktok-publish.ts` `initVideoPost`: happy path, rate-limit, error.
- `routes-internal.ts` `/internal/tiktok/video-post`: happy path, missing video url
  upstream (shouldn't reach here per engine-level check, but route itself should still
  reject gracefully), rate-limit.
- `engine.ts` `buildActionData`: `attachVideo` and `operation` fields populated
  correctly for both action types.
- `flow/src/index.ts` `executeContentActions`: `create-post` with `attachVideo` true/no
  video in payload → immediate `failed`, no fetch; `attachVideo` true + pending response
  → `content_flow_pending` row inserted with the right shape; `tiktokContentAction`
  `video-post` branch dispatch.
- `flow/src/index.ts` sweep: `xVideoStatusPoll` succeeded/failed/pending-under-limit/
  pending-exhausted, all four outcomes.

Per `CLAUDE.md`'s coding-agent rule, these tests are written/reviewed as part of
implementation, run to green before this feature is reported done. Browser/e2e
self-test is explicitly **not** part of this feature's completion bar (see Decision 10)
— it becomes meaningful once the sibling video-action node exists to actually populate
`processed_video_url`.

## Risks

- **TikTok `PULL_FROM_URL` domain verification**: TikTok requires verifying ownership of
  the URL prefix/domain used for `PULL_FROM_URL`. `photo-post` already uses this
  mechanism successfully in production today via the same `CONTENT_URL` domain, so this
  is presumed already satisfied — but worth a pre-deploy sanity check rather than an
  assumption, since `video-post` hits a different TikTok endpoint.
- **X `media.write` scope rollout**: existing connected X channels will hit a hard
  failure on their first video-post attempt until reconnected. This is accepted
  (Decision 5) but should be communicated if/when this ships, since it's a
  previously-invisible failure mode for a previously-impossible action shape.
- **`media_id` expiry window**: X's INIT response includes `expires_after_secs` for
  unused media. The ~5-minute poll ceiling (Decision 9) is expected to sit well inside
  that window based on typical documented values, but this should be confirmed against
  current X docs at implementation time rather than assumed.
- **Feature is inert until the sibling design ships**: nothing in this design can be
  exercised end-to-end (real video in, real post out) until
  `2026-07-19-video-action-add-subtitle-design.md` is implemented. This is intentional
  (Decision 10), not an oversight — but it means this plan's implementer cannot close
  the loop with a live browser test, only mocked unit/integration coverage.

## Out of scope

- The video-processing node itself (producer of `processed_video_url`) — separate,
  sibling design.
- AI-generated video (no such capability exists or is added here).
- Tenant-uploaded video assets (rejected during grilling in favor of the
  flow-produced-video model).
- Per-step payload-value observability in the flow analytics UI (confirmed during
  design: no payload field of any kind is exposed in the node-click detail drawer today
  — this gap is pre-existing and not something this feature needs to close).
- Any UI for choosing which upstream payload field to reference — the video prop is
  always exactly `$content.processed_video_url`, never user-editable.
