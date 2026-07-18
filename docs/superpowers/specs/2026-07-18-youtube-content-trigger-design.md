# YouTube Content Trigger Design

## Context

The `flow` module has a metadata-driven content-trigger pattern established across three prior sources — X own-posts, X List Posts (watching *other* accounts via [2026-07-15-x-list-posts-trigger-design.md](2026-07-15-x-list-posts-trigger-design.md)), and TikTok content ([2026-07-14-tiktok-content-polling-design.md](2026-07-14-tiktok-content-polling-design.md)). All three poll on a `channel_poll_state` + cron cadence.

This design adds a fourth source, YouTube, with two departures from that precedent: (1) monitored channels are **arbitrary public YouTube channels**, not a tenant's own OAuth'd account — same "watch someone else's content" shape as X List Posts, but with no OAuth step at all, since YouTube channel data is public; (2) ingestion is **push-driven** (YouTube's free WebSub/PubSubHubbub feed), not polled — the first push-based source in this codebase.

The trigger's purpose: watch a handful of YouTube channels, and when a new video meets content criteria (duration in a configurable range; no human face in the thumbnail), feed it into the existing `xContentAction:create-post` action to auto-publish to X. No changes to `xContentAction` or the flow engine's action side — YouTube is purely a new trigger source plugging into machinery that already exists.

## Scope

- New `youtubeContentTrigger` flow node: one node watches exactly one YouTube channel (mirrors X List Posts trigger's "one node, one List" granularity — watching several channels means dragging several nodes, each independently configurable).
- Channel is identified by pasting a channel URL/handle directly into the node's Inspector — no separate "connect channel" page. The node resolves the URL to a channel ID and creates the underlying `channels` row on save.
- New generic content prop `has_face` (0/1), computed once per video from its thumbnail via a Workers AI vision model — usable by the existing `ConditionsEditor` alongside the already-existing `duration` prop. Both are ordinary conditions; no new engine logic for either.
- Ingestion via YouTube's WebSub (PubSubHubbub) push feed, using a system-shared YouTube Data API key (no per-tenant BYOK, no OAuth) to fetch full video details (duration, thumbnail) once a push notification identifies a new video ID.

## Out of scope

- A safety-net poll to catch missed push notifications — explicitly rejected; an occasional missed video is an accepted risk for v1, not silently masked by a fallback mechanism.
- A `content_url` prop for linking back to the source video from the generated X post — not handled this round; the tenant can hand-write a link into the `create-post` prompt if desired, but no `$content` field supports it yet.
- Full-video face detection (frame sampling/download) — only the thumbnail is checked. A faceless thumbnail does not guarantee a faceless video and vice versa; this approximation is accepted, not hidden.
- Any change to `xContentAction`, the flow engine's condition evaluator, or any existing content source (X, TikTok).

## 1. Data model

**`link/src/types.ts`**: add `"YOUTUBE"` to `ChannelType` (currently `"LOCAL" | "NOTION" | "TIKTOK" | "X"`). A watched YouTube channel is a `channels` row with `channel_type = "YOUTUBE"` and no access token — same shape as the existing OAuth-less `NOTION`/`LOCAL` content channels. This reuses `channel_poll_state`-adjacent bookkeeping, dedup indexes, and webhook routing conventions already built for X/TikTok, rather than inventing a parallel "watchlist" entity.

**`metadata/props.ts`**: new prop definition:

```ts
{
  propId: "has_face",
  isInsight: true,
  dataType: "INT",
  entity: ["content"],
  label: { en: "Has Face", zh: "含人脸" },
},
```

Generic, not YouTube-specific — any future video source can populate it the same way.

**`metadata/youtube.ts`** (new file, mirrors `metadata/tiktok.ts`'s shape):

```ts
// https://developers.google.com/youtube/v3/docs/videos/list
import type { ContentMetadata } from "./dataTypes";

export const ContentMetadata_YouTube: ContentMetadata[] = [
  {
    sourceContentType: "watch:get-videos", // https://developers.google.com/youtube/v3/docs/videos/list
    linkPrefix: "items[]",
    contentProps: [
      { propId: "content_type", value: "VIDEO" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.snippet.publishedAt" },
      { propId: "title", dataId: "{linkPrefix}.snippet.title" },
      { propId: "content_text", dataId: "{linkPrefix}.snippet.description" },
      { propId: "cover_image_url", dataId: "{linkPrefix}.snippet.thumbnails.default.url" },
      { propId: "view_count", dataId: "{linkPrefix}.statistics.viewCount" },
      { propId: "like_count", dataId: "{linkPrefix}.statistics.likeCount" },
      // duration and has_face are NOT resolved via resolveProps — see Section 3.
    ],
  },
];
```

Wired into `metadata/index.ts` alongside `ContentMetadata_X`/`ContentMetadata_TikTok`. The `"watch:"` prefix follows the same poll-only-vs-trigger naming convention `own:get-posts` established — this entry has no `flowType`, since it's the raw API response shape, not a directly-selectable flow trigger mode (the trigger is the `youtubeContentTrigger` node itself, not a `mode` value like X's `get-list-posts`).

`duration` is not listed above because the Data API returns it as an ISO-8601 duration string (`contentDetails.duration`, e.g. `"PT4M13S"`) requiring parsing to seconds — this happens in the poller (Section 3), then gets pushed into the props array as a computed value before calling `upsertContentFromMetadata`, the same way `has_face` does.

**`content` table**: add `has_face INTEGER` column. Per the X List Posts design's precedent (no rollout mechanism exists for already-provisioned tenant DBs, and there are no real customers yet), this is applied by updating `admin/src/services/tenant-init-sql.ts`'s `TENANT_DB_INIT_SQL` directly and reprovisioning dev tenant DBs from scratch — not a live migration.

`link/src/services/content.ts`'s `CONTENT_COLUMN_MAP` gains `has_face: "has_face"`.

## 2. Adding a watched channel

The tenant pastes a YouTube channel URL or `@handle` directly into the `youtubeContentTrigger` node's Inspector. On save, `flow` calls a new `link` internal endpoint:

```
POST /internal/youtube/watch
body: { channelUrl: string }
→ { channelId: string, channelName: string, thumbnailUrl: string }
```

This endpoint:
1. Resolves the URL/handle to a YouTube channel ID via the Data API's `channels.list` (`forHandle` or `forUsername` param, or parses a `/channel/UC...` URL directly without an API call).
2. Finds-or-creates the `channels` row (`channel_type = "YOUTUBE"`, `config.youtube_channel_id`).
3. Subscribes to that channel's WebSub feed (Section 3) if not already subscribed.
4. Returns the resolved name/thumbnail so the canvas node can display something more useful than a raw ID.

The node's `data` shape:

```ts
{
  channelId: "",       // link's channels.id (our row, not YouTube's channel ID)
  channelName: "",     // cached display label, refreshed on open
  conditions: [],       // existing generic ConditionsEditor — e.g. duration >= 60 && duration <= 900 && has_face == 0
}
```

## 3. Ingestion: WebSub push + Data API enrichment

**`link/src/webhook.ts`** gains two routes:

- `GET /youtube/websub/:channelId` — WebSub verification handshake: echoes the `hub.challenge` query param back to confirm endpoint ownership.
- `POST /youtube/websub/:channelId` — receives the Atom feed notification (`<yt:videoId>`, `<yt:channelId>`, `<published>` — no duration/thumbnail). For each `<entry>`:
  1. Calls YouTube Data API `videos.list?id={videoId}&part=snippet,contentDetails,statistics` using the system-shared `env.YOUTUBE_API_KEY` (1 quota unit).
  2. Parses `contentDetails.duration` (ISO-8601, e.g. `PT4M13S`) to seconds.
  3. Runs `@cf/moondream/moondream3.1-9B-A2B` against `snippet.thumbnails.default.url`, prompted to answer whether the image contains a human face; parses the response to `has_face: 0 | 1`. On any failure calling this model (timeout, error), defaults `has_face = 1` (fail closed — a detection failure is treated as "assume a face is present," so it's filtered out by a typical `has_face == 0` condition rather than silently let through).
  4. Resolves the rest of the props via `resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix)`, then appends the computed `duration` and `has_face` values.
  5. Calls `ContentService.upsertContentFromMetadata(item, props, channelId, "YOUTUBE")` — dedup on the existing `(channel_id, source_content_id)` unique index (no `list_id` complexity: each channel is its own dedup scope, one node per channel).
  6. On a genuinely-new row, emits `content.created` with `channelId` (our `channels.id`), same event shape every other source already produces.

On YouTube Data API failure (quota exhausted, 403, etc.), log and drop that notification — matches the existing pollers' non-blocking failure style; no retry queue for v1.

## 4. Subscription lifecycle

- **Subscribe**: `POST https://pubsubhubbub.appspot.com/subscribe` with `hub.topic=https://www.youtube.com/xml/feeds/videos.xml?channel_id={youtubeChannelId}`, `hub.callback={our GET/POST /youtube/websub/:channelId URL}`. The hub grants a lease (up to ~10 days); store `websub_lease_expires_at` in the `channels` row's `config`.
- **Renew**: new step in `link/src/cron.ts`. First calls `flow`'s existing `GET /internal/list-watches`-style scan, extended to also report `youtubeContentTrigger` nodes' referenced channel IDs across all published flows. For each `YOUTUBE` channel currently referenced by at least one published flow: if its lease expires within 24h, re-subscribe. For each `YOUTUBE` channel **no longer** referenced by any published flow: unsubscribe (`hub.mode=unsubscribe`) and deactivate the row. This mirrors the X List Posts design's "no persisted registration to explicitly tear down — a pair that stops being referenced simply stops being renewed" behavior, adapted from per-tick polling to periodic lease renewal.
- **Verify**: handled by the `GET /youtube/websub/:channelId` route (Section 3).

## 5. Flow side

- **`flow/nodeTypeRegistry.ts`**: new `youtubeContentTrigger` entry (`domain: "content"`, `generatable: true`), `promptFragment` documenting the `data` shape and that `conditions` support `duration` (seconds) and `has_face` (0/1) — parallel to `xContentTrigger`'s existing fragment.
- **`flow/frontend/nodes/YouTubeContentTriggerNode.tsx`** (new, mirrors `XContentTriggerNode.tsx`): shows the cached channel name/thumbnail + condition-count summary.
- **`flow/frontend/components/Inspector.tsx`**: new `YouTubeContentTriggerInspector` — channel URL input (calls `POST /internal/youtube/watch` via `link`'s proxy through `flow`'s existing internal-call pattern), then the existing generic `ConditionsEditor` over `duration`/`has_face`.
- **`flow/src/engine.ts`**: trigger-node filter gains a `youtubeContentTrigger` branch — event's `channelId` must equal `node.data.channelId` (same shape as X's My Posts mode; no list-id layer needed since one node always maps to exactly one channel).
- **Sidebar / templates**: `CONTENT_FLOW_SIDEBAR_ORDER` gains `youtubeContentTrigger`.

## 6. Data flow (end to end)

YouTube channel publishes a video → WebSub hub `POST`s to `link` → `link` fetches full details via the Data API, runs the face check, upserts content, emits `content.created` → `flow` engine matches `youtubeContentTrigger` nodes on `channelId`, evaluates `conditions` (e.g. `duration >= 60 && duration <= 900 && has_face == 0`) → on pass, the downstream `xContentAction:create-post` node fires exactly as it does for any other content trigger today, generating and publishing via **that flow's own connected X channel** — unrelated to the YouTube channel being watched, using the same "acts via the triggering channel" model already established for TikTok→X flows.

## Testing

- `link/tests/services/youtube-content-api.test.ts`: Data API response parsing, ISO-8601 duration parsing.
- `link/tests/webhook-youtube.test.ts`: WebSub verify-challenge echo, notification parsing, dedup on repeat notification (same video ID posted twice → second does not emit `content.created`), face-check integration with a mocked model response (including the fail-closed default on model error).
- `link/tests/services/youtube-watch.test.ts`: URL/handle resolution, find-or-create channel row, subscribe-on-create.
- `link/tests/cron-youtube-renewal.test.ts`: renews leases nearing expiry for referenced channels, unsubscribes+deactivates unreferenced ones.
- `flow/tests/unit/engine.test.ts`: `youtubeContentTrigger` channel-filter matching (event matches only the node's configured channel; a same-tenant event from a different channel does not match).
- Manual/dev verification: watch a real YouTube channel via a pasted URL, publish (or use an already-published) video meeting the duration+no-face criteria, confirm the flow fires once and does not refire on WebSub's occasional duplicate-delivery retries.

## Non-goals

- Safety-net polling as a backstop for missed push notifications.
- `content_url` prop / auto-linking back to the source video.
- Full-video (multi-frame) face detection.
- Per-tenant BYOK YouTube API keys (system-shared key only, like TikTok).
