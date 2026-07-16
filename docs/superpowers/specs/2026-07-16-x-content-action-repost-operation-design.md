# X Content Action: Metadata-Driven Repost Operation — Design

**Goal:** Add "Repost" as a metadata-driven Operation of the `xContentAction` flow node (replacing the separate, half-implemented standalone `repost` node type), remove the Target Platform selector from `xContentAction` (X-only for now — TikTok gets its own future node type), and make the existing "Create Post" Operation's Inspector fields metadata-driven too.

## Context

`xContentAction` is a flow node (content-domain automations) that publishes generated or as-is text to an X channel. Today its Inspector hardcodes an "Operation" dropdown that only ever offers one choice ("Create Post"), a Prompt textarea, a Provider dropdown, a Target Platform dropdown (X/TikTok), and a Target Account dropdown.

Separately, a standalone `repost` node type exists in the Sidebar/canvas with zero configuration ("reposts on the same channel content was ingested from"). Its backend (`link`'s `POST /internal/x/repost`) has always been a `501 notImplemented` stub, and its flow-engine call site (`flow/src/index.ts`) never actually resolves the node's success/failed branches — a pre-existing bug, since it's the only content-action branch that skips `resumeFromNode`.

A metadata entry for `repost-post` (`metadata/x-byok.ts`'s `ContentMetadata_X`) already exists with the real X API doc link, but was never wired into the Inspector (which reads a separate, now-removed `ContentActionMetadata_X` array from `metadata/x.ts`).

**Pre-existing groundwork** (uncommitted, from a concurrent session, confirmed safe to build on): `metadata/x-byok.ts`'s `ContentMetadata_X` now holds both `create-post` (`contentProps: [{propId:"message_text", aiType:"TEXT"}]`) and `repost-post` (`contentProps: []`) under `flowType: "action"`; the duplicate `ContentActionMetadata_X` in `metadata/x.ts` has been deleted; `PropMapping.aiType` (`"TEXT"|"IMAGE"|"VIDEO"`) has been added to `metadata/dataTypes.ts`; `message_text`'s `PROPS` label was renamed to `{en:"Text", zh:"文本"}`.

## Domain model

See `CONTEXT.md`'s new **Operation** entry: an Operation (`ContentMetadata` entry, `flowType:"action"`) is a distinct concept from a node's **action type** (`data.actionType`, e.g. `"xContentAction"`). One action type can host multiple Operations, distinguished by `data.operation` (the `sourceContentType`).

## Behavior

### Operation dropdown

`XContentActionInspector` switches its import from the deleted `ContentActionMetadata_X` to `ContentMetadata_X` (from `metadata/x-byok`), filtered by `flowType === "action"`. This yields exactly two options today: "Create Post" (`create-post`) and "Repost" (`repost-post`), each localized via existing `label` fields.

### Field visibility, driven by metadata

For the selected operation, compute `aiProp = operation.contentProps.find(p => p.aiType)`.

- **`aiProp` present** (`create-post`): render, in this order —
  1. **Provider** — `<Select>`, no `<Label>` element (per request #3), directly above Prompt.
  2. **Prompt** — `<Textarea>`, label text sourced from `PROPS.find(p => p.propId === aiProp.propId)?.label` (resolves to "Text"/"文本" for `message_text`), same placeholder/helper text as today.
  3. **Target Account** — existing channel picker, but `channelType` is no longer a user selection — it's hardcoded to `"X"` internally (no Target Platform `<Select>` rendered at all).
- **`aiProp` absent** (`repost-post`): render nothing beyond the Operation dropdown. No Provider, no Prompt, no Target Account — matches request #1's "no additional UI parameters."

This is a single derived boolean gating one JSX block, not a per-operation-name switch — the same check naturally covers any future operation that reuses the `aiType` convention.

### Data flow for Repost

Repost does not let the user pick a target channel. Its account comes from the *triggering* channel (`channelId`, already threaded through `executeContentActions` from the queue message) — i.e. exactly the old standalone `repost` node's behavior, just reachable via `xContentAction`'s Operation dropdown now. Its tweet id comes from `payload.source_content_id`, which is already populated in every `content.created` queue message (`get-posts` and `get-list-posts` `ContentMetadata_X` entries both map `source_content_id`) — no manual `$content.` interpolation, no schema change.

### Backend (`flow` module)

- `engine.ts`'s `buildActionData` starts forwarding `operation` (currently dropped) alongside `targetChannelId`/`prompt`/`provider` for `xContentAction` actions.
- `index.ts`'s `executeContentActions`: the standalone `action.type === "repost"` branch is deleted. Inside the `xContentAction` branch, split on `action.operation`:
  - `"repost-post"` → call `link`'s `/internal/x/repost` with `{ channelId, contentId, tweetId: payload?.source_content_id, flowId }` (using the *source* `channelId`, not `targetChannelId` — there is none).
  - anything else (default `"create-post"`) → existing `/internal/content/create-post` call, unchanged.
  - Both converge on the same `body.ok`/`rateLimited` → `resumeFromNode` branch-resolution logic already used by `create-post` — fixing, as a side effect, the old repost branch's bug of never resolving success/failed.
- `engine.ts`: remove `"repost"` from the `isExternalApi` set (the type no longer exists).

### Backend (`link` module)

- New `repostPost(accessToken, sourceUserId, tweetId)` in `x-posts-api.ts`: `POST https://api.x.com/2/users/{sourceUserId}/repost` with body `{ tweet_id: tweetId }`, same 429/rate-limit handling shape as `createPost`.
- Rewrite `POST /internal/x/repost` in `routes-internal.ts` (replacing the 501 stub): accept `{ channelId, contentId, tweetId, flowId }`, look up the channel row (`config.x_user_id`, matching `/internal/x/action`'s existing pattern), get a valid access token via `XTokenService`, call `repostPost()`, return `{ ok, rateLimited?, rateLimitReset? }` matching `create-post`'s response shape.
- No credit-charging — matches `create-post`'s existing behavior (content-domain actions don't charge credits today); this stays consistent rather than introducing a new gate unilaterally.

### Frontend node type deletion

Standalone `repost` node type removed entirely — confirmed via direct read-only query against both dev (`uniscrm-flow-dev`) and prod (`uniscrm-flow`) D1 that zero existing flows reference it, so no migration/back-compat concern:
- `ActionNode.tsx`: remove the `"repost"` label/description/icon branch; remove `"repost"` from `EXTERNAL_API_ACTIONS`.
- `Sidebar.tsx`: remove the Repost `DraggableItem`.
- `flow-editor.ts`: remove `"repost"` from `ACTION_TYPES`; remove its `addNode` data branch.

## Non-goals

- TikTok content actions (explicitly deferred to a future, separate node type per request #2).
- Any new generic "operations" registry/admin UI — this stays TypeScript-literal metadata, consistent with the rest of `/metadata/`.
- Credit-charging for content-domain actions (unchanged, out of scope).
- Fixing `source_content_id`'s missing `entity: ["content"]` tag (it's excluded from the content field-picker UI) — unrelated to this task since Repost never surfaces a manual field picker.
