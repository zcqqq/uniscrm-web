# YouTube Trigger: Channel → Subscription Design

**Goal:** Redesign `youtubeContentTrigger` to pick a live YouTube subscription (from the tenant's OAuth-connected account) directly, mirroring how `xContentTrigger`'s List Posts mode picks an X List — instead of the current model, where "watching" a channel first creates a persistent `channels`-table row.

**Depends on:** `docs/superpowers/specs/2026-07-19-content-trigger-no-d1-write-design.md` (spec #2) — this spec's YouTube ingestion path uses spec #2's `recordTriggerContentSeen`/dedup mechanism instead of writing a `content` D1 row per video. Implement spec #2 first, or alongside; this spec's engine-matching and ingestion sections assume spec #2's `ContentService` methods already exist.

## Why the current model is wrong

Today, `youtubeContentTrigger.data = { channelId, channelName, conditions }`, where `channelId` is a row id in the shared `channels` table with `channel_type = 'YOUTUBE'` — one such row is created per external YouTube channel a tenant chooses to watch, via `POST /youtube/subscriptions/:youtubeChannelId/watch` → `findOrCreateWatchedChannel` (`link/src/services/youtube-account.ts`).

`xContentTrigger`'s List Posts mode (`data = { channelId, mode, listId, listName, conditions }`) never does this: `channelId` there is the connected X account's own `channels` row (one per tenant), and `listId`/`listName` are values fetched live from X's API (`GET /api/channels/x/:channelId/lists`) — an X List is never itself a `channels` row. YouTube subscriptions are the same kind of thing as X Lists: a value discovered from the tenant's connected account, not an entity requiring its own persistent identity in the `channels` table. The per-subscription `channels` row was scope creep from treating "watching" as equivalent to "connecting."

## New node data shape

```ts
// youtubeContentTrigger
data: {
  channelId: string;              // the tenant's connected YOUTUBE_ACCOUNT row id (channels table)
  subscriptionChannelId: string;  // raw YouTube channel id of the subscription being watched
  subscriptionChannelName: string;// display name, cached alongside for the Inspector/canvas label
  conditions: Condition[];
}
```

Directly parallel to `xContentTrigger`'s `{channelId, mode, listId, listName, conditions}`, minus `mode` (YouTube has exactly one trigger mode, so no discriminator is needed).

## Deleted entirely

- `link/src/services/youtube-account.ts`: `findOrCreateWatchedChannel`.
- `link/src/routes-channels.ts`: `POST /youtube/subscriptions/:youtubeChannelId/watch`.
- The `YOUTUBE` `channel_type` value and every per-subscription `channels` row it produced. `YOUTUBE_ACCOUNT` (the one-row-per-tenant OAuth connection) is untouched — it remains the only YouTube-related row in `channels`.

No data migration for existing dev rows/flows using the old model — manually clear dev `channels` rows with `channel_type = 'YOUTUBE'` and any published flow referencing the old `data.channelId` semantics, then re-test fresh. (Confirmed acceptable: dev-only, no prod tenants yet.)

## `link/src/routes-channels.ts`: `GET /youtube/subscriptions`

Simplified — no more cross-referencing watched-channel rows:

```ts
router.get("/youtube/subscriptions", async (c) => {
  const tenantId = c.get("tenantId" as never) as number;
  const accountRow = await c.env.LINK_DB
    .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
    .bind(tenantId)
    .first<{ id: string; config: string }>();
  if (!accountRow) return c.json({ connected: false, accountChannelId: null, subscriptions: [] });

  const config = JSON.parse(accountRow.config) as {
    subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
  };
  return c.json({
    connected: true,
    accountChannelId: accountRow.id,
    subscriptions: config.subscriptions || [],
  });
});
```

`already_watching` is dropped — nothing to cross-reference against anymore; every subscription is equally selectable at all times, exactly like X Lists.

`GET /youtube/status` is unchanged (still reports connection state + cached subscription count for the Social page).

## New table: `youtube_websub_leases` (link DB, migration `0007`)

WebSub is a push protocol requiring a stable callback URL and a renewable lease — unlike X Lists (polled, stateless), so it needs *some* durable identity even though subscriptions are no longer `channels` rows. This table is that identity, decoupled from `channels` entirely:

```sql
CREATE TABLE youtube_websub_leases (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  account_channel_id TEXT NOT NULL,   -- FK: channels.id (the YOUTUBE_ACCOUNT row)
  youtube_channel_id TEXT NOT NULL,   -- raw subscription channel id (== node's subscriptionChannelId)
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_youtube_leases_account_channel ON youtube_websub_leases(account_channel_id, youtube_channel_id);
CREATE INDEX idx_youtube_leases_tenant ON youtube_websub_leases(tenant_id);
```

## WebSub callback and ingestion (`link/src/webhook-youtube.ts`)

Callback URL changes from `/youtube/websub/:channelId` to `/youtube/websub/:accountChannelId/:youtubeChannelId`.

**GET (verification handshake):** on receiving `hub.lease_seconds`, upsert into `youtube_websub_leases` (keyed on `(account_channel_id, youtube_channel_id)`) instead of writing into a `channels.config` blob:
```sql
INSERT INTO youtube_websub_leases (id, tenant_id, account_channel_id, youtube_channel_id, lease_expires_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT(account_channel_id, youtube_channel_id) DO UPDATE SET
  lease_expires_at = excluded.lease_expires_at, updated_at = datetime('now')
```
`tenant_id` for the insert comes from looking up `channels WHERE id = :accountChannelId AND channel_type = 'YOUTUBE_ACCOUNT'`.

**POST (video push):** tenant lookup changes from `channels WHERE id = ? AND channel_type = 'YOUTUBE'` to joining `youtube_websub_leases` → `channels` on `account_channel_id`:
```sql
SELECT c.tenant_id
FROM youtube_websub_leases l
JOIN channels c ON c.id = l.account_channel_id
WHERE l.account_channel_id = ? AND l.youtube_channel_id = ? AND c.is_active = 1
```
Then ingestion (`link/src/services/pollers/youtube-content.ts`'s `ingestYouTubeVideo`) is called with both `accountChannelId` and `subscriptionChannelId` (renaming `YouTubeIngestContext.channelId` accordingly), and — per spec #2 — calls `ContentService.recordTriggerContentSeen(accountChannelId, subscriptionChannelId, videoId)` followed by, if new, `emitContentTriggerEvent(accountChannelId, "YOUTUBE", "subscriptionChannelId", subscriptionChannelId, resolvedProps)` instead of `upsertContentFromMetadata`. The `content.created` queue message carries `channelId: accountChannelId` and `subscriptionChannelId` as its own top-level field (not reusing X's `listId` name — confirmed field name is `subscription_channel_id` on the wire / `subscriptionChannelId` in code, matching the node's own data field), and per this spec's "flow queue consumer" section below, that field must be threaded through the queue consumer to reach `engine.ts`'s match payload.

`metadata/youtube.ts`'s `watch:get-videos` entry gets `flowType: "trigger"` added (currently unset), so it's correctly scoped by spec #2's `flowType`-based routing.

## WebSub renewal + first-subscribe cron (`link/src/cron.ts`)

The existing renewal cron (around `cron.ts:200-235`) currently: queries `channels WHERE channel_type = 'YOUTUBE'` for rows with a soon-to-expire lease, and renews via `subscribeWebSub`. It's broadened to also pick up brand-new watches, sourced the same way `list-watches` already works for X:

1. Fetch `GET {FLOW_URL}/internal/youtube-watches` → now returns `{ channelId: string; subscriptionChannelId: string }[]` (pairs), scanned from published flows' `youtubeContentTrigger` nodes' `data.channelId` + `data.subscriptionChannelId` (both required; dedup on the pair) — mirrors `/internal/list-watches`'s existing shape (`flow/src/index.ts:508-542`) exactly.
2. For each pair, `SELECT lease_expires_at FROM youtube_websub_leases WHERE account_channel_id = ? AND youtube_channel_id = ?`. Missing row **or** `lease_expires_at` within the renewal window (existing threshold logic, unchanged) → call `subscribeWebSub({LINK_URL}/youtube/websub/{accountChannelId}/{youtubeChannelId}, youtubeChannelId)` using the account's stored OAuth access token.
3. Pairs no longer referenced by any published flow (present in `youtube_websub_leases` but absent from the current `/internal/youtube-watches` result) are left alone — the existing comment at `cron.ts:225` ("if it truly stays unreferenced forever, the WebSub lease simply lapses on its own") already covers this; no active unsubscribe call needed.

This means "watching starts after flow publish" happens automatically, bounded by this cron's interval — no synchronous subscribe call is added to the flow-publish path. (Confirmed acceptable.)

## `flow/src/index.ts`: `/internal/youtube-watches`

```ts
app.get("/internal/youtube-watches", async (c) => {
  // ... auth unchanged ...
  const watches: { channelId: string; subscriptionChannelId: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows.results) {
    // ... parse graph, same guards as today ...
    for (const node of graph.nodes) {
      if (!node.data || node.type !== "youtubeContentTrigger") continue;
      const channelId = node.data.channelId as string;
      const subscriptionChannelId = node.data.subscriptionChannelId as string;
      if (!channelId || !subscriptionChannelId) continue;
      const key = `${channelId}:${subscriptionChannelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      watches.push({ channelId, subscriptionChannelId });
    }
  }
  return c.json({ watches });
});
```

## `flow/src/index.ts`: flow queue consumer must carry `subscriptionChannelId` through

Emitting `subscriptionChannelId` on the queue message (per spec #2) is not sufficient on its own — it must also be threaded through the consumer that turns queue messages into `engine.ts`'s match payload, the same way `listId` already is for X List Posts. Three spots, none currently touched by either spec unless called out here:

1. **`FlowQueueMessage` type** (wherever it's declared, consumed at `flow/src/index.ts:978`): add `subscriptionChannelId?: string` alongside the existing `listId?: string`.
2. **Consumer destructure** (`flow/src/index.ts:978`):
   ```ts
   const { tenantId, eventType, userId, contentId, channelId, listId, subscriptionChannelId, payload } = message.body as FlowQueueMessage;
   ```
3. **Match payload construction** (`flow/src/index.ts:987`):
   ```ts
   const matchPayload = {
     ...payload,
     channel_id: channelId,
     ...(listId ? { list_id: listId } : {}),
     ...(subscriptionChannelId ? { subscription_channel_id: subscriptionChannelId } : {}),
   };
   ```

Without this, `emitContentTriggerEvent`'s `subscriptionChannelId` field is emitted onto the queue message and then silently dropped — `engine.ts`'s `payload.subscription_channel_id` is always `undefined`, and no YouTube-subscription flow ever matches.

## `flow/src/engine.ts`: trigger matching

```ts
|| (n.type === "youtubeContentTrigger" && eventType === "content.created"
    && n.data.channelId === payload.channel_id
    && n.data.subscriptionChannelId === payload.subscription_channel_id)
```

## New proxy: `flow/src/index.ts`

```ts
// Proxy YouTube subscriptions lookup from link worker (for the youtubeContentTrigger Inspector)
app.get("/api/channels/youtube/subscriptions", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const res = await fetch(`${linkUrl}/api/channels/youtube/subscriptions`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json" } });
});
```
(Mirrors the existing `x-lists` proxy at `flow/src/index.ts:619-623` exactly.)

## `flow/frontend/components/Inspector.tsx`: `YouTubeContentTriggerInspector`

Replaces the current already-watched-only dropdown. Fetches `GET /api/channels/youtube/subscriptions` on mount:
- `connected: false` → empty state: "Connect your YouTube account from the Social page" (no picker shown; matches the current empty-state pattern, just pointing at account connection instead of "watch a channel").
- `connected: true, subscriptions: []` → empty state: "No subscriptions found — check your YouTube account has subscriptions."
- Otherwise → a picker (dropdown, same component as the current one) over `subscriptions`, keyed by `subscriptionChannelId`, displaying `subscriptionChannelName`. On select: `updateNodeData(nodeId, { channelId: accountChannelId, subscriptionChannelId: sub.channelId, subscriptionChannelName: sub.channelName })`, where `accountChannelId` comes from the same fetch response's `accountChannelId` field.

Label changes from "Channel" to "Subscription".

## `flow/frontend/store/flow-editor.ts`

Default `data` for a newly-added `youtubeContentTrigger` node: `{ channelId: "", subscriptionChannelId: "", subscriptionChannelName: "", conditions: [] }`.

## `flow/nodeTypeRegistry.ts`

`youtubeContentTrigger.promptFragment` updated to the new data shape and to describe subscription-picking instead of "already-watched channel":
```
youtubeContentTrigger - triggers when a subscribed YouTube channel publishes a new video
   data: { channelId: "", subscriptionChannelId: "", subscriptionChannelName: "", conditions: [] }
   - channelId and subscriptionChannelId are left blank ("") — the user picks a subscription from a dropdown in the Inspector after generation, sourced from their connected YouTube account (OAuth) on the Social page.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).
```

## `link/frontend/components/SocialChannels.tsx`: `YouTubeAccountCard`

Strips down to connect/disconnect + subscription count (matching the X account card's shape — X has no per-list picker on the Social page either). The subscription-picking UI moves entirely into the flow Inspector; the "watch" action is removed since there's nothing to eagerly create anymore.

## Tests

Per `uniscrm-web/CLAUDE.md`'s coding-agent rule: write/update tests in each touched module's `tests/` directory covering — node data shape round-trip, engine matching on `(channelId, subscriptionChannelId)`, the new `/internal/youtube-watches` pair shape, the WebSub callback URL's two-param routing, `youtube_websub_leases` upsert-on-conflict behavior, and the `GET /youtube/subscriptions` response shape (no `already_watching`). Existing tests referencing the old `YOUTUBE` channel_type / `findOrCreateWatchedChannel` / `POST .../watch` are deleted or rewritten.
