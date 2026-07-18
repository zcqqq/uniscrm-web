# YouTube OAuth Subscription-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "paste a YouTube channel URL" flow with OAuth-connect (reusing the existing Google login OAuth client) + pick-which-subscriptions-to-watch from the discovered list.

**Architecture:** A new `channel_type = 'YOUTUBE_ACCOUNT'` row (one per tenant) holds the OAuth token and a cached snapshot of the tenant's YouTube subscriptions, synced once at connect time via `subscriptions.list?mine=true`. The tenant then explicitly picks which discovered channels to actually watch — that pick reuses the exact same `channels(channel_type='YOUTUBE')` + WebSub-subscribe logic the current URL-paste flow already uses, extracted into a shared helper. The ingestion pipeline (Data API fetch, face detection, content upsert, cron renewal, flow-engine matching) is entirely untouched by this plan.

**Tech Stack:** Cloudflare Workers (Hono), D1, `arctic` (OAuth, already a dependency, already used for X and for Google login in `web`), YouTube Data API v3 `subscriptions.list`.

## Global Constraints

- Full replacement, not dual-mode — the URL-paste UI and `POST /youtube/watch` route are deleted once the new flow is built and verified, not kept alongside it.
- Tenant explicitly picks which discovered channels to watch — connecting OAuth never auto-subscribes WebSub for every discovered subscription.
- One-time sync only — `subscriptions.list` runs once per OAuth connect/re-connect. No periodic re-sync cron in this plan.
- Reuses the Google Cloud OAuth client already registered for "Sign in with Google" (`web/worker/api/oauth.ts`'s `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) — `link` gets its own copy of the same values, mirroring how `X_CLIENT_ID`/`X_CLIENT_SECRET` are already duplicated across `web/wrangler.toml` and `link/wrangler.toml` today. No new Google Cloud OAuth client is created.
- No refresh token / `access_type=offline` — the access token is used exactly once, inside the OAuth callback's background sync task, and never touched again.
- Silent overwrite on re-connect, matching X/TikTok's existing plain-connect behavior (no extra confirmation UX).
- Unbounded `subscriptions.list` pagination for v1 (accepted tradeoff — no real customers yet, per this repo's established precedent for early-stage features).
- Disconnecting `YOUTUBE_ACCOUNT` must never cascade to any `YOUTUBE` watched-channel row, never call `unsubscribeWebSub`, never affect a flow's trigger — this is the same category of bug an earlier cron-renewal fix in this codebase already fixed once (aggressive deactivation silently killing live triggers); guard it with an explicit test, not just review discipline.
- The shared `channels` table's global `UNIQUE(channel_type, source_channel_id)` index (`link/migrations/0001_initial_schema.sql`) must not be touched — `YOUTUBE_ACCOUNT` rows use the same tenant-scoped `source_channel_id` encoding (`"{tenantId}:{googleUserId}"`) already established for `YOUTUBE` watched-channel rows.

---

## Task 1: Data model — Env, ChannelType, TWITTER-alias fix, wrangler.toml

**Files:**
- Modify: `link/src/types.ts`
- Modify: `link/wrangler.toml`
- Modify: `link/src/routes-channels.ts:22-32` (the generic `GET /` route)
- Test: `link/tests/routes-channels.test.ts` (extend if it exists, else create)

**Interfaces:**
- Produces: `Env.GOOGLE_CLIENT_ID: string`, `Env.GOOGLE_CLIENT_SECRET: string`; `ChannelType` includes `"YOUTUBE_ACCOUNT"`. `GET /channels?type=X` no longer leaks `TWITTER` rows into non-X queries.

- [ ] **Step 1: Write the failing test for the TWITTER-alias leak**

Check whether `link/tests/routes-channels.test.ts` exists (`ls link/tests/routes-channels.test.ts`). If it exists, add this test inside its existing `describe("GET /", ...)` block (match its existing mock style); if it doesn't exist, create it:

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return { app, env };
}

describe("GET /api/channels", () => {
  it("does not leak TWITTER rows when querying a non-X type", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    await app.request("/api/channels?type=YOUTUBE", {}, env);

    const sql = linkDb.prepare.mock.calls[0][0] as string;
    expect(sql).not.toContain("TWITTER");
    const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs).toEqual([1, "YOUTUBE"]);
  });

  it("still includes TWITTER rows when querying type=X (legacy migration alias)", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    await app.request("/api/channels?type=X", {}, env);

    const sql = linkDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("TWITTER");
    const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs).toEqual([1, "X", "TWITTER"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/routes-channels.test.ts`
Expected: FAIL — current query always includes `'TWITTER'` regardless of `type`.

- [ ] **Step 3: Fix the generic `GET /` route in `link/src/routes-channels.ts`**

Replace lines 22-32:

```ts
  // List channels by type
  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const type = (c.req.query("type") || "").toUpperCase();
    const rows = await c.env.LINK_DB.prepare(
      "SELECT id, config FROM channels WHERE tenant_id = ? AND channel_type IN (?, 'TWITTER') AND is_active = 1"
    ).bind(tenantId, type).all<{ id: string; config: string }>();
    const channels = rows.results.map((r) => {
      const config = JSON.parse(r.config || "{}");
      return { id: r.id, username: config.x_username || config.display_name || config.channel_name || "" };
    });
    return c.json(channels);
```

with:

```ts
  // List channels by type. type=X also includes the legacy 'TWITTER' alias
  // (pre-migration rows) — every other type queries only its own exact value.
  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const type = (c.req.query("type") || "").toUpperCase();
    const types = type === "X" ? [type, "TWITTER"] : [type];
    const placeholders = types.map(() => "?").join(", ");
    const rows = await c.env.LINK_DB.prepare(
      `SELECT id, config FROM channels WHERE tenant_id = ? AND channel_type IN (${placeholders}) AND is_active = 1`
    ).bind(tenantId, ...types).all<{ id: string; config: string }>();
    const channels = rows.results.map((r) => {
      const config = JSON.parse(r.config || "{}");
      return { id: r.id, username: config.x_username || config.display_name || config.channel_name || "" };
    });
    return c.json(channels);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/routes-channels.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` to `Env` and `YOUTUBE_ACCOUNT` to `ChannelType`**

In `link/src/types.ts`, change line 72:

```ts
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X" | "YOUTUBE";
```

to:

```ts
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X" | "YOUTUBE" | "YOUTUBE_ACCOUNT";
```

Add after line 48 (`YOUTUBE_API_KEY: string;`):

```ts
  // Google OAuth (reuses the same Google Cloud OAuth client already registered for
  // "Sign in with Google" in the web module — see web/worker/types.ts's identically-named
  // fields — not a new client. Distinct from YOUTUBE_API_KEY, which is a separate Data API key.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
```

- [ ] **Step 6: Add `GOOGLE_CLIENT_ID` to `link/wrangler.toml`**

In `link/wrangler.toml`'s `[env.dev.vars]` block (after `X_CLIENT_ID = "cS1kY2RlNnc1VldHSWw0LVJQSFM6MTpjaQ"` on line 32), add:

```toml
GOOGLE_CLIENT_ID = "1038882920781-unbsoa2prpnvqufeicaqqe1mlgso5ac9.apps.googleusercontent.com"
```

In `link/wrangler.toml`'s `[env.production.vars]` block (after the corresponding `X_CLIENT_ID` line), add:

```toml
GOOGLE_CLIENT_ID = "1038882920781-qado86f0g0hcf7t3l74b8acgu1a8teg4.apps.googleusercontent.com"
```

(These are copied verbatim from `web/wrangler.toml`'s existing `GOOGLE_CLIENT_ID` values — same OAuth client, same IDs.)

- [ ] **Step 7: Manual step — set the secret and register the new redirect URI (not code, note for the human)**

`GOOGLE_CLIENT_SECRET` is not committed in plaintext (matches how `X_CLIENT_SECRET`/`TIKTOK_CLIENT_SECRET` are handled — `wrangler secret put`, not a `wrangler.toml` var). This step is a note for whoever runs deployment, not something the implementer executes:

```bash
# Use the SAME secret value already set for web's GOOGLE_CLIENT_SECRET — do not generate a new one.
wrangler secret put GOOGLE_CLIENT_SECRET --env dev    # (in link/)
wrangler secret put GOOGLE_CLIENT_SECRET --env production
```

And in Google Cloud Console, add `link`'s two redirect URIs to the existing OAuth client's "Authorized redirect URIs":
- `https://link-dev.uni-scrm.com/api/auth/youtube/callback`
- `https://link.uni-scrm.com/api/auth/youtube/callback` (confirm exact prod domain against `link/wrangler.toml`'s `[env.production]` routes)

- [ ] **Step 8: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no new errors relative to baseline (grep the output for `types.ts` / `routes-channels.ts` — should be empty).

- [ ] **Step 9: Commit**

```bash
git add link/src/types.ts link/wrangler.toml link/src/routes-channels.ts link/tests/routes-channels.test.ts
git commit -m "fix: scope TWITTER alias to type=X only; add Google OAuth env + YOUTUBE_ACCOUNT type"
```

---

## Task 2: `subscriptions.list` client

**Files:**
- Modify: `link/src/services/youtube-api.ts`
- Test: `link/tests/services/youtube-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface YouTubeSubscription { channelId: string; channelName: string; thumbnailUrl: string }
  export async function fetchAllSubscriptions(accessToken: string): Promise<YouTubeSubscription[]>
  ```
  Consumed by Task 3's `syncYouTubeSubscriptions`.

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/services/youtube-api.test.ts` (inside the existing `describe("youtube-api fetch functions", ...)` block, reusing its existing `fetchMock`/`jsonResponse` helpers):

```ts
  it("fetchAllSubscriptions returns items from a single page", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [
        { snippet: { resourceId: { channelId: "UCabc" }, title: "Channel A", thumbnails: { default: { url: "https://img/a.jpg" } } } },
        { snippet: { resourceId: { channelId: "UCdef" }, title: "Channel B", thumbnails: { default: { url: "https://img/b.jpg" } } } },
      ],
    }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result).toEqual([
      { channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" },
      { channelId: "UCdef", channelName: "Channel B", thumbnailUrl: "https://img/b.jpg" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("mine=true");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer access-tok");
  });

  it("fetchAllSubscriptions paginates until nextPageToken is absent", async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse({
        items: [{ snippet: { resourceId: { channelId: "UC1" }, title: "One" } }],
        nextPageToken: "page2",
      }))
      .mockImplementationOnce(() => jsonResponse({
        items: [{ snippet: { resourceId: { channelId: "UC2" }, title: "Two" } }],
      }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result.map((s) => s.channelId)).toEqual(["UC1", "UC2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("pageToken=page2");
  });

  it("fetchAllSubscriptions skips items with no resourceId.channelId", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [{ snippet: { title: "Broken" } }, { snippet: { resourceId: { channelId: "UCok" }, title: "OK" } }],
    }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result).toEqual([{ channelId: "UCok", channelName: "OK", thumbnailUrl: "" }]);
  });

  it("fetchAllSubscriptions throws on a non-ok response", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("forbidden", { status: 403 })));
    await expect(fetchAllSubscriptions("access-tok")).rejects.toThrow();
  });
```

Add the import at the top of the test file:

```ts
import {
  parseISO8601Duration,
  resolveYouTubeChannelId,
  fetchVideoDetails,
  fetchChannelSnippet,
  subscribeWebSub,
  unsubscribeWebSub,
  fetchAllSubscriptions,
} from "../../src/services/youtube-api";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/youtube-api.test.ts`
Expected: FAIL — `fetchAllSubscriptions` is not exported.

- [ ] **Step 3: Implement `fetchAllSubscriptions` in `link/src/services/youtube-api.ts`**

Add at the end of the file:

```ts
export interface YouTubeSubscription {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

export async function fetchAllSubscriptions(accessToken: string): Promise<YouTubeSubscription[]> {
  const subscriptions: YouTubeSubscription[] = [];
  let pageToken: string | undefined;

  do {
    const apiUrl = new URL(`${DATA_API_BASE}/subscriptions`);
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("mine", "true");
    apiUrl.searchParams.set("maxResults", "50");
    if (pageToken) apiUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`YouTube subscriptions.list failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      items?: { snippet?: { resourceId?: { channelId?: string }; title?: string; thumbnails?: { default?: { url?: string } } } }[];
      nextPageToken?: string;
    };

    for (const item of body.items || []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (!channelId) continue;
      subscriptions.push({
        channelId,
        channelName: item.snippet?.title || "",
        thumbnailUrl: item.snippet?.thumbnails?.default?.url || "",
      });
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  return subscriptions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/youtube-api.test.ts`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-api.ts link/tests/services/youtube-api.test.ts
git commit -m "feat: add fetchAllSubscriptions (paginated subscriptions.list)"
```

---

## Task 3: Shared account/watch-channel service — extract and reuse, don't duplicate

**Files:**
- Create: `link/src/services/youtube-account.ts`
- Modify: `link/src/routes-channels.ts` (refactor the existing `POST /youtube/watch` handler to call the new helper — pure refactor, no behavior change)
- Test: `link/tests/services/youtube-account.test.ts`
- Test: `link/tests/routes-channels-youtube.test.ts` (existing tests must still pass unchanged — this task proves the extraction is behavior-preserving before Task 6 depends on it)

**Interfaces:**
- Consumes: `subscribeWebSub` (Task existing), `fetchAllSubscriptions` (Task 2).
- Produces:
  ```ts
  export async function syncYouTubeSubscriptions(env: Env, channelId: string, accessToken: string): Promise<void>
  export interface WatchChannelResult { channelId: string; channelName: string; thumbnailUrl: string }
  export async function findOrCreateWatchedChannel(
    env: Env, tenantId: number, memberId: string,
    youtubeChannelId: string, channelName: string, thumbnailUrl: string
  ): Promise<WatchChannelResult>
  ```
  Consumed by Task 4 (`syncYouTubeSubscriptions`) and Task 6 (`findOrCreateWatchedChannel`).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/services/youtube-account.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { syncYouTubeSubscriptions, findOrCreateWatchedChannel } from "../../src/services/youtube-account";
import * as youtubeApi from "../../src/services/youtube-api";

function createMockLinkDb(overrides: { selectResult?: unknown; existingRow?: unknown } = {}) {
  const runMock = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(overrides.existingRow ?? null),
    run: runMock,
  });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _run: runMock, _bind: bind };
}

describe("syncYouTubeSubscriptions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches subscriptions and marks sync_status done", async () => {
    vi.spyOn(youtubeApi, "fetchAllSubscriptions").mockResolvedValue([
      { channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" },
    ]);
    const linkDb = createMockLinkDb({
      existingRow: { config: JSON.stringify({ google_user_id: "g1", email: "a@b.com", sync_status: "pending", subscriptions: [] }) },
    });
    const env = { LINK_DB: linkDb } as any;

    await syncYouTubeSubscriptions(env, "chan1", "access-tok");

    const updateCall = linkDb._bind.mock.calls.find((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("Channel A"));
    expect(updateCall).toBeTruthy();
    const savedConfig = JSON.parse(updateCall![0] as string);
    expect(savedConfig.sync_status).toBe("done");
    expect(savedConfig.subscriptions).toEqual([{ channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" }]);
    expect(savedConfig.last_synced_at).toBeTruthy();
  });

  it("marks sync_status error and does not throw when the API call fails", async () => {
    vi.spyOn(youtubeApi, "fetchAllSubscriptions").mockRejectedValue(new Error("quota exceeded"));
    const linkDb = createMockLinkDb({
      existingRow: { config: JSON.stringify({ google_user_id: "g1", email: "a@b.com", sync_status: "pending", subscriptions: [] }) },
    });
    const env = { LINK_DB: linkDb } as any;

    await expect(syncYouTubeSubscriptions(env, "chan1", "access-tok")).resolves.toBeUndefined();

    const updateCall = linkDb._bind.mock.calls.find((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("error"));
    expect(updateCall).toBeTruthy();
  });

  it("does nothing when the channel row no longer exists", async () => {
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb } as any;
    const spy = vi.spyOn(youtubeApi, "fetchAllSubscriptions");

    await syncYouTubeSubscriptions(env, "gone", "access-tok");

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("findOrCreateWatchedChannel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a new row and subscribes WebSub when none exists", async () => {
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    const result = await findOrCreateWatchedChannel(env, 1, "member1", "UCabc", "Channel A", "https://img/a.jpg");

    expect(result.channelName).toBe("Channel A");
    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/"), "UCabc");
    const insertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO channels"));
    expect(insertCall![0]).toContain("YOUTUBE");
  });

  it("reuses the existing row and does not re-subscribe", async () => {
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: { id: "existing-chan" } });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    const result = await findOrCreateWatchedChannel(env, 1, "member1", "UCabc", "Channel A", "https://img/a.jpg");

    expect(result.channelId).toBe("existing-chan");
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("encodes source_channel_id as tenantId:youtubeChannelId", async () => {
    vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const linkDb = createMockLinkDb({ existingRow: null });
    const env = { LINK_DB: linkDb, LINK_URL: "https://link.example" } as any;

    await findOrCreateWatchedChannel(env, 42, "member1", "UCabc", "Channel A", "");

    const insertBindArgs = linkDb._bind.mock.calls.find((c: unknown[]) => c.includes("42:UCabc"));
    expect(insertBindArgs).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/youtube-account.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `link/src/services/youtube-account.ts`**

```ts
import type { Env } from "../types";
import { fetchAllSubscriptions, subscribeWebSub } from "./youtube-api";

export async function syncYouTubeSubscriptions(env: Env, channelId: string, accessToken: string): Promise<void> {
  const row = await env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?").bind(channelId).first<{ config: string }>();
  if (!row) return;

  const config = JSON.parse(row.config) as Record<string, unknown>;
  try {
    const subscriptions = await fetchAllSubscriptions(accessToken);
    config.subscriptions = subscriptions;
    config.sync_status = "done";
    config.last_synced_at = new Date().toISOString();
  } catch (e) {
    console.error(JSON.stringify({ event: "youtube_subscriptions_sync_error", channel_id: channelId, error: String(e) }));
    config.sync_status = "error";
  }

  await env.LINK_DB
    .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(config), channelId)
    .run();
}

export interface WatchChannelResult {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

// Tenant-scoped source_channel_id, same reasoning as YOUTUBE_ACCOUNT rows: the shared
// channels(channel_type, source_channel_id) unique index (link/migrations/0001_initial_schema.sql)
// is global and must not be migrated — two tenants watching the same external channel each
// need their own row.
export async function findOrCreateWatchedChannel(
  env: Env,
  tenantId: number,
  memberId: string,
  youtubeChannelId: string,
  channelName: string,
  thumbnailUrl: string
): Promise<WatchChannelResult> {
  const sourceChannelId = `${tenantId}:${youtubeChannelId}`;
  const config = { youtube_channel_id: youtubeChannelId, channel_name: channelName, thumbnail_url: thumbnailUrl };
  const now = new Date().toISOString();

  const existing = await env.LINK_DB
    .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE' AND source_channel_id = ? AND is_active = 1")
    .bind(sourceChannelId)
    .first<{ id: string }>();

  let channelId: string;
  if (existing) {
    channelId = existing.id;
    await env.LINK_DB
      .prepare("UPDATE channels SET config = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(config), now, channelId)
      .run();
  } else {
    channelId = crypto.randomUUID();
    await env.LINK_DB
      .prepare(
        `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
         VALUES (?, 'YOUTUBE', ?, ?, ?, ?, ?, ?)`
      )
      .bind(channelId, JSON.stringify(config), sourceChannelId, tenantId, memberId, now, now)
      .run();

    try {
      await subscribeWebSub(`${env.LINK_URL}/youtube/websub/${channelId}`, youtubeChannelId);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_websub_subscribe_error", channel_id: channelId, error: String(e) }));
    }
  }

  return { channelId, channelName, thumbnailUrl };
}
```

- [ ] **Step 4: Run new tests to verify they pass**

Run: `cd link && npx vitest run tests/services/youtube-account.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Refactor the existing `POST /youtube/watch` handler to call `findOrCreateWatchedChannel`**

In `link/src/routes-channels.ts`, replace the body of `router.post("/youtube/watch", ...)` (the block that currently does the tenant-scoped find-or-create + subscribe inline, lines ~248-282) so it calls the extracted helper instead of duplicating the logic:

```ts
  router.post("/youtube/watch", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const { channelUrl } = await c.req.json<{ channelUrl: string }>();
    if (!channelUrl) return c.json({ error: "Missing channelUrl" }, 400);

    const resolved = await resolveYouTubeChannelId(c.env.YOUTUBE_API_KEY, channelUrl);
    if (!resolved) return c.json({ error: "Could not resolve this channel URL" }, 400);

    let channelName = resolved.channelName;
    let thumbnailUrl = resolved.thumbnailUrl;
    if (!channelName) {
      const snippet = await fetchChannelSnippet(c.env.YOUTUBE_API_KEY, resolved.channelId);
      if (snippet) {
        channelName = snippet.channelName;
        thumbnailUrl = snippet.thumbnailUrl;
      }
    }

    const result = await findOrCreateWatchedChannel(c.env, tenantId, memberId, resolved.channelId, channelName, thumbnailUrl);
    return c.json(result);
  });
```

Add the import at the top of the file:

```ts
import { findOrCreateWatchedChannel } from "./services/youtube-account";
```

- [ ] **Step 6: Run the EXISTING route tests to prove the refactor is behavior-preserving**

Run: `cd link && npx vitest run tests/routes-channels-youtube.test.ts`
Expected: PASS — all pre-existing tests (resolve+create+subscribe, tenant-scoping, 400 on unresolvable URL, reuse-existing-row, backfill-via-fetchChannelSnippet) still pass unmodified, proving the extraction changed nothing observable.

- [ ] **Step 7: Commit**

```bash
git add link/src/services/youtube-account.ts link/tests/services/youtube-account.test.ts link/src/routes-channels.ts
git commit -m "refactor: extract findOrCreateWatchedChannel + add syncYouTubeSubscriptions"
```

---

## Task 4: OAuth connect/callback

**Files:**
- Modify: `link/src/oauth.ts`
- Test: `link/tests/oauth-youtube.test.ts`

**Interfaces:**
- Consumes: `syncYouTubeSubscriptions` (Task 3).
- Produces: `GET /youtube/connect`, `GET /youtube/callback` on the router returned by `oauthRoutes()` (mounted at `/api/auth` in `link/src/index.ts` — no mount change needed, already covers this).

- [ ] **Step 1: Write the failing tests**

`link/tests/oauth.test.ts` already establishes the conventions for testing this exact `oauthRoutes()` function — full-replacement `vi.mock("arctic", () => ({...}))` (not `importOriginal`), a `createMockLinkDb(responses: Array<[sqlSubstring, row]>)` helper, and a `createMockExecutionCtx()` helper returning `{ ctx, flush }` so backgrounded `waitUntil` work can be awaited before assertions. Read that file first (already read by the plan author — summarized below) and match its style exactly rather than inventing a different mocking approach; this task's new tests live in their own file, so mocking `arctic` differently here doesn't conflict with `oauth.test.ts`'s own separate mock.

Create `link/tests/oauth-youtube.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const validateAuthorizationCodeMock = vi.fn();
const decodeIdTokenMock = vi.fn();

vi.mock("arctic", () => ({
  Twitter: class {},
  Google: class {
    validateAuthorizationCode(...args: unknown[]) {
      return validateAuthorizationCodeMock(...args);
    }
    createAuthorizationURL() {
      return new URL("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
    }
  },
  generateState: () => "state123",
  generateCodeVerifier: () => "verifier",
  decodeIdToken: (...args: unknown[]) => decodeIdTokenMock(...args),
}));

const syncYouTubeSubscriptionsMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/youtube-account", () => ({
  syncYouTubeSubscriptions: (...args: unknown[]) => syncYouTubeSubscriptionsMock(...args),
}));

vi.mock("../src/services/app-credentials", () => ({ getAppCredentials: vi.fn() }));
vi.mock("../src/services/x-token", () => ({ XTokenService: class {} }));
vi.mock("../src/services/x-webhook", () => ({ XActivityService: class {} }));
vi.mock("../src/services/pollers/poll-channel", () => ({ pollChannelOnce: vi.fn() }));
vi.mock("../../shared/credit-service", () => ({ getActiveSubscriptionTier: vi.fn() }));
vi.mock("../../shared/plans", () => ({ canUseFeature: vi.fn().mockReturnValue(true) }));

import { oauthRoutes } from "../src/oauth";

type MockRow = Record<string, unknown> | null;

function createMockLinkDb(responses: Array<[string, MockRow]>) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ sql, args });
      const match = responses.find(([key]) => sql.includes(key));
      const value = match ? match[1] : null;
      return {
        first: vi.fn().mockResolvedValue(value),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
    }),
  }));
  return { prepare, calls };
}

function createMockKv(stored: Record<string, unknown> | null) {
  return {
    get: vi.fn().mockResolvedValue(stored ? JSON.stringify(stored) : null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockExecutionCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { promises.push(p); }, passThroughOnException: () => {} },
    flush: () => Promise.all(promises),
  };
}

function buildApp() {
  const app = new Hono();
  app.route("/", oauthRoutes());
  return app;
}

describe("GET /youtube/connect", () => {
  it("stores oauth state in KV and redirects to Google's authorization URL", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/connect", {}, { KV: kv, WEB_DB: { prepare: vi.fn() }, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(302);
    expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^oauth_state:/), expect.any(String), { expirationTtl: 300 });
  });
});

describe("GET /youtube/callback", () => {
  it("upserts a YOUTUBE_ACCOUNT channel row and backgrounds the subscription sync", async () => {
    validateAuthorizationCodeMock.mockResolvedValueOnce({
      accessToken: () => "access-tok",
      idToken: () => "mock-id-token",
      accessTokenExpiresInSeconds: () => 3600,
    });
    decodeIdTokenMock.mockReturnValueOnce({ sub: "google-user-1", email: "tenant@example.com" });

    const kv = createMockKv({ codeVerifier: "verifier", tenantId: "1", memberId: "member1" });
    const linkDb = createMockLinkDb([["channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id", null]]);

    const app = buildApp();
    const { ctx, flush } = createMockExecutionCtx();
    const res = await app.request(
      "/youtube/callback?code=abc&state=xyz",
      {},
      { KV: kv, LINK_DB: linkDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any,
      ctx as any
    );
    await flush();

    expect(res.status).toBe(302);
    expect(kv.delete).toHaveBeenCalledWith("oauth_state:xyz");

    const insertCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channels"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain("YOUTUBE_ACCOUNT");
    expect(insertCall!.args).toContain("1:google-user-1");

    expect(syncYouTubeSubscriptionsMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), "access-tok");
  });

  it("returns 400 when state is missing or expired", async () => {
    const kv = createMockKv(null);
    const app = buildApp();

    const res = await app.request("/youtube/callback?code=abc&state=xyz", {}, { KV: kv, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(400);
  });

  it("returns 401 when the stored state has no tenant/member session", async () => {
    const kv = createMockKv({ codeVerifier: "verifier", tenantId: undefined, memberId: undefined });
    const app = buildApp();

    const res = await app.request("/youtube/callback?code=abc&state=xyz", {}, { KV: kv, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as any);

    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/oauth-youtube.test.ts`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Implement the routes in `link/src/oauth.ts`**

Add the import at the top (extend the existing `arctic` import line):

```ts
import { Twitter, Google, generateState, generateCodeVerifier, decodeIdToken } from "arctic";
```

Add near the top, alongside the other service imports:

```ts
import { syncYouTubeSubscriptions } from "./services/youtube-account";
```

Add the two routes inside `oauthRoutes()`, after the TikTok callback route and before `return router;`:

```ts
  // YouTube OAuth connect — reuses the same Google Cloud OAuth client already registered
  // for "Sign in with Google" in the web module (GOOGLE_CLIENT_ID/SECRET), not a new one.
  router.get("/youtube/connect", async (c) => {
    const session = await resolveSession(c);
    const tenantId = session ? String(session.tenant_id) : null;
    const memberId = session?.member_id || null;

    const url = new URL(c.req.url);
    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${url.origin}/api/auth/youtube/callback`);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const oauthUrl = google.createAuthorizationURL(state, codeVerifier, [
      "openid",
      "email",
      "https://www.googleapis.com/auth/youtube.readonly",
    ]);

    await c.env.KV.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier, tenantId, memberId }), { expirationTtl: 300 });
    return c.redirect(oauthUrl.toString(), 302);
  });

  // YouTube OAuth callback
  router.get("/youtube/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

    const stored = await c.env.KV.get(`oauth_state:${state}`);
    if (!stored) return c.json({ error: "Invalid or expired state" }, 400);
    await c.env.KV.delete(`oauth_state:${state}`);
    const { codeVerifier, tenantId, memberId } = JSON.parse(stored) as {
      codeVerifier: string; tenantId?: string; memberId?: string;
    };
    if (!tenantId || !memberId) return c.json({ error: "Must be logged in to connect YouTube" }, 401);

    const google = new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${url.origin}/api/auth/youtube/callback`);
    let tokens;
    try {
      tokens = await google.validateAuthorizationCode(code, codeVerifier);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_oauth_token_exchange_failed", error: String(e) }));
      return c.json({ error: `Token exchange failed: ${e instanceof Error ? e.message : String(e)}` }, 400);
    }

    const claims = decodeIdToken(tokens.idToken()) as { sub: string; email: string };
    const googleUserId = claims.sub;
    const email = claims.email;

    let expiresAt: string;
    try {
      expiresAt = new Date(Date.now() + tokens.accessTokenExpiresInSeconds() * 1000).toISOString();
    } catch {
      expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    const sourceChannelId = `${tenantId}:${googleUserId}`;
    const config = {
      google_user_id: googleUserId,
      email,
      access_token: tokens.accessToken(),
      expires_at: expiresAt,
      subscriptions: [] as unknown[],
      sync_status: "pending" as const,
      last_synced_at: null as string | null,
    };
    const now = new Date().toISOString();

    const existing = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND source_channel_id = ? AND is_active = 1")
      .bind(sourceChannelId)
      .first<{ id: string }>();

    let channelId: string;
    if (existing) {
      channelId = existing.id;
      await c.env.LINK_DB
        .prepare("UPDATE channels SET config = ?, is_active = 1, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(config), now, channelId)
        .run();
    } else {
      channelId = crypto.randomUUID();
      await c.env.LINK_DB
        .prepare(
          `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
           VALUES (?, 'YOUTUBE_ACCOUNT', ?, ?, ?, ?, ?, ?)`
        )
        .bind(channelId, JSON.stringify(config), sourceChannelId, Number(tenantId), memberId, now, now)
        .run();
    }

    c.executionCtx.waitUntil(syncYouTubeSubscriptions(c.env, channelId, tokens.accessToken()));

    return c.redirect(url.origin, 302);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/oauth-youtube.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full `link` suite to check for regressions**

Run: `cd link && npx vitest run`
Expected: same known-baseline pass rate as before this task (no new failures beyond the one pre-existing unrelated X-repost-URL failure).

- [ ] **Step 6: Commit**

```bash
git add link/src/oauth.ts link/tests/oauth-youtube.test.ts
git commit -m "feat: add YouTube OAuth connect/callback (reuses Google login client)"
```

---

## Task 5: Status + subscriptions-list routes

**Files:**
- Modify: `link/src/routes-channels.ts`
- Test: `link/tests/routes-channels-youtube-account.test.ts`

**Interfaces:**
- Produces: `GET /youtube/status` → `{connected, email?, sync_status?, subscription_count?, created_at?}`; `GET /youtube/subscriptions` → `{subscriptions: {channelId, channelName, thumbnailUrl, already_watching}[]}`. Consumed by Task 9 (frontend).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/routes-channels-youtube-account.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    c.set("memberId" as never, "member1" as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return { app, env };
}

describe("GET /api/channels/youtube/status", () => {
  it("returns connected:false when no YOUTUBE_ACCOUNT row exists", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(await res.json()).toEqual({ connected: false });
  });

  it("returns account details when connected", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ email: "a@b.com", sync_status: "done", subscriptions: [{ channelId: "UC1" }, { channelId: "UC2" }] }),
            created_at: "2026-07-18T00:00:00.000Z",
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(await res.json()).toEqual({
      connected: true, email: "a@b.com", sync_status: "done", subscription_count: 2, created_at: "2026-07-18T00:00:00.000Z",
    });
  });
});

describe("GET /api/channels/youtube/subscriptions", () => {
  it("returns an empty list when no account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);

    expect(await res.json()).toEqual({ subscriptions: [] });
  });

  it("annotates already_watching against existing YOUTUBE rows", async () => {
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("YOUTUBE_ACCOUNT")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "" }, { channelId: "UC2", channelName: "Two", thumbnailUrl: "" }] }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({
          results: [{ config: JSON.stringify({ youtube_channel_id: "UC1" }) }],
        }) }) };
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.subscriptions).toEqual([
      { channelId: "UC1", channelName: "One", thumbnailUrl: "", already_watching: true },
      { channelId: "UC2", channelName: "Two", thumbnailUrl: "", already_watching: false },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Implement the routes**

Add to `link/src/routes-channels.ts`, immediately after the (now-refactored) `POST /youtube/watch` route:

```ts
  router.get("/youtube/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const row = await c.env.LINK_DB
      .prepare("SELECT config, created_at FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string; created_at: string }>();
    if (!row) return c.json({ connected: false });

    const config = JSON.parse(row.config) as { email?: string; sync_status?: string; subscriptions?: unknown[] };
    return c.json({
      connected: true,
      email: config.email,
      sync_status: config.sync_status,
      subscription_count: (config.subscriptions || []).length,
      created_at: row.created_at,
    });
  });

  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!accountRow) return c.json({ subscriptions: [] });

    const accountConfig = JSON.parse(accountRow.config) as {
      subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
    };
    const subscriptions = accountConfig.subscriptions || [];

    const watchedRows = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .all<{ config: string }>();
    const watchedIds = new Set(
      watchedRows.results.map((r) => (JSON.parse(r.config) as { youtube_channel_id?: string }).youtube_channel_id)
    );

    return c.json({
      subscriptions: subscriptions.map((s) => ({ ...s, already_watching: watchedIds.has(s.channelId) })),
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-channels.ts link/tests/routes-channels-youtube-account.test.ts
git commit -m "feat: add GET /youtube/status and GET /youtube/subscriptions"
```

---

## Task 6: Watch-a-subscription route

**Files:**
- Modify: `link/src/routes-channels.ts`
- Test: `link/tests/routes-channels-youtube-account.test.ts` (extend)

**Interfaces:**
- Consumes: `findOrCreateWatchedChannel` (Task 3).
- Produces: `POST /youtube/subscriptions/:youtubeChannelId/watch` → `{channelId, channelName, thumbnailUrl}`. Consumed by Task 9 (frontend).

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/routes-channels-youtube-account.test.ts`:

```ts
import * as youtubeAccount from "../src/services/youtube-account";

describe("POST /api/channels/youtube/subscriptions/:id/watch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("looks up the subscription from the cached list and calls findOrCreateWatchedChannel", async () => {
    const findOrCreateSpy = vi.spyOn(youtubeAccount, "findOrCreateWatchedChannel").mockResolvedValue({
      channelId: "new-chan", channelName: "One", thumbnailUrl: "https://img/1.jpg",
    });
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "https://img/1.jpg" }] }),
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UC1/watch", { method: "POST" }, env);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toEqual({ channelId: "new-chan", channelName: "One", thumbnailUrl: "https://img/1.jpg" });
    expect(findOrCreateSpy).toHaveBeenCalledWith(env, 1, "member1", "UC1", "One", "https://img/1.jpg");
  });

  it("returns 404 when the channelId is not in the tenant's cached subscription list", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ config: JSON.stringify({ subscriptions: [] }) }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UCnotmine/watch", { method: "POST" }, env);

    expect(res.status).toBe(404);
  });

  it("returns 400 when no YouTube account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UC1/watch", { method: "POST" }, env);

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

Add to `link/src/routes-channels.ts`, immediately after `GET /youtube/subscriptions`:

```ts
  router.post("/youtube/subscriptions/:youtubeChannelId/watch", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const youtubeChannelId = c.req.param("youtubeChannelId");

    const accountRow = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ config: string }>();
    if (!accountRow) return c.json({ error: "YouTube account not connected" }, 400);

    const config = JSON.parse(accountRow.config) as {
      subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
    };
    const subscription = (config.subscriptions || []).find((s) => s.channelId === youtubeChannelId);
    if (!subscription) return c.json({ error: "Not found in your subscriptions" }, 404);

    const result = await findOrCreateWatchedChannel(
      c.env, tenantId, memberId, youtubeChannelId, subscription.channelName, subscription.thumbnailUrl
    );
    return c.json(result);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-channels.ts link/tests/routes-channels-youtube-account.test.ts
git commit -m "feat: add POST /youtube/subscriptions/:id/watch"
```

---

## Task 7: Disconnect isolation test

**Files:**
- Test: `link/tests/routes-channels-youtube-account.test.ts` (extend)

**Interfaces:** none new — this task only adds test coverage for existing generic-route behavior.

- [ ] **Step 1: Write the test**

Add to `link/tests/routes-channels-youtube-account.test.ts`:

```ts
describe("DELETE /api/channels/youtube_account (disconnect isolation)", () => {
  it("only deactivates the YOUTUBE_ACCOUNT row — never touches YOUTUBE watched-channel rows or WebSub", async () => {
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindSpy = vi.fn().mockReturnValue({ run: runMock });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindSpy }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube_account", { method: "DELETE" }, env);

    expect(res.status).toBe(200);
    const updateSql = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"))![0] as string;
    expect(updateSql).toContain("channel_type = ?");
    const bindArgs = bindSpy.mock.calls.find((c: unknown[]) => c.includes("YOUTUBE_ACCOUNT"));
    expect(bindArgs).toBeTruthy();
    // Only one UPDATE call total — nothing separately touches channel_type = 'YOUTUBE' rows.
    const allUpdateCalls = linkDb.prepare.mock.calls.filter((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"));
    expect(allUpdateCalls).toHaveLength(1);
  });
});
```

This exercises the existing generic `router.delete("/:type", ...)` handler in `link/src/routes-channels.ts` (already implemented, no code change needed — it does `UPDATE channels SET is_active = 0 ... WHERE tenant_id = ? AND channel_type = ?`, scoped to exactly the `channel_type` in the URL param, so it structurally cannot touch `YOUTUBE` rows when called with `type=youtube_account`). This step is pure verification that the existing generic route is safe to reuse for this purpose — if it fails, that is a real bug to fix, not a test to adjust.

- [ ] **Step 2: Run the test**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: PASS (8 tests total). If it fails, investigate `router.delete("/:type", ...)` directly — do not weaken this assertion to force a pass.

- [ ] **Step 3: Commit**

```bash
git add link/tests/routes-channels-youtube-account.test.ts
git commit -m "test: verify YOUTUBE_ACCOUNT disconnect never touches YOUTUBE watched-channel rows"
```

---

## Task 8: Delete the old URL-paste flow (now fully superseded)

**Files:**
- Modify: `link/src/routes-channels.ts` (delete `POST /youtube/watch`)
- Modify: `link/src/services/youtube-api.ts` (delete `resolveYouTubeChannelId`, `fetchChannelByHandle`, `runChannelLookup`, `fetchChannelSnippet`)
- Modify: `link/tests/services/youtube-api.test.ts` (delete tests for the removed functions)
- Modify: `link/tests/routes-channels-youtube.test.ts` (delete — its route no longer exists)

**Interfaces:** none produced — this is a pure deletion task, safe now that Tasks 4-6 provide the full replacement.

- [ ] **Step 1: Confirm nothing else references the functions being deleted**

Run: `cd link && grep -rn "resolveYouTubeChannelId\|fetchChannelByHandle\|runChannelLookup\|fetchChannelSnippet" src/ tests/`
Expected: only the definitions themselves and their own tests — no other call sites (the ingestion pipeline uses `fetchVideoDetails`/`parseISO8601Duration`, which are untouched).

- [ ] **Step 2: Delete `POST /youtube/watch` from `link/src/routes-channels.ts`**

Remove the entire `router.post("/youtube/watch", async (c) => { ... });` block (the refactored version from Task 3, now dead — `POST /youtube/subscriptions/:id/watch` from Task 6 is its replacement).

Remove the now-unused import:

```ts
import { resolveYouTubeChannelId, subscribeWebSub, fetchChannelSnippet } from "./services/youtube-api";
```

(`subscribeWebSub` is no longer imported directly here either — it's only used inside `youtube-account.ts` now. Confirm no other route in this file still calls it directly before removing the import; if one does, keep only that name imported.)

- [ ] **Step 3: Delete the four dead functions from `link/src/services/youtube-api.ts`**

Remove `resolveYouTubeChannelId`, `fetchChannelByHandle`, `runChannelLookup`, `fetchChannelSnippet`, and the now-unused `YouTubeChannelResolution` interface (confirm nothing else imports it first). Keep `parseISO8601Duration`, `fetchVideoDetails`, `fetchAllSubscriptions`, `subscribeWebSub`, `unsubscribeWebSub`, `callHub`, `DATA_API_BASE`, `HUB_URL`.

- [ ] **Step 4: Delete the corresponding tests**

Delete `link/tests/routes-channels-youtube.test.ts` entirely (its route is gone).

In `link/tests/services/youtube-api.test.ts`, remove the `it(...)` blocks for `resolveYouTubeChannelId extracts...`, `resolveYouTubeChannelId resolves a @handle...`, `resolveYouTubeChannelId returns null...`, `fetchChannelSnippet fetches and parses...`, `fetchChannelSnippet returns null...`, and remove the now-unused imports (`resolveYouTubeChannelId`, `fetchChannelSnippet`) from the top of the file.

- [ ] **Step 5: Run the full `link` suite**

Run: `cd link && npx vitest run`
Expected: no failures beyond the one known pre-existing unrelated X-repost-URL failure. Confirm `youtube-api.test.ts` and `youtube-account.test.ts` and the Task 5/6 route tests all still pass.

- [ ] **Step 6: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors referencing `routes-channels.ts` or `youtube-api.ts` (confirms no dangling references to the deleted functions).

- [ ] **Step 7: Commit**

```bash
git add link/src/routes-channels.ts link/src/services/youtube-api.ts link/tests/services/youtube-api.test.ts
git rm link/tests/routes-channels-youtube.test.ts
git commit -m "refactor: delete the URL-paste YouTube watch flow, superseded by OAuth subscription picker"
```

---

## Task 9: Frontend — `link` module (Connect + subscription picker)

**Files:**
- Create: `link/frontend/hooks/useYouTubeAccount.ts`
- Modify: `link/frontend/lib/api.ts`
- Modify: `link/frontend/components/SocialChannels.tsx`

**Interfaces:**
- Consumes: `GET /youtube/status`, `GET /youtube/subscriptions`, `POST /youtube/subscriptions/:id/watch` (Tasks 5-6), `DELETE /channels/:type` (existing generic route, reused via `api.channels.simpleDisconnect("youtube_account")`).

- [ ] **Step 1: Add API client methods to `link/frontend/lib/api.ts`**

Add inside the `channels: { ... }` object, after `saveConfig`:

```ts
    youtubeStatus: () =>
      request<{ connected: boolean; email?: string; sync_status?: string; subscription_count?: number; created_at?: string }>(
        "/channels/youtube/status"
      ),
    youtubeSubscriptions: () =>
      request<{ subscriptions: { channelId: string; channelName: string; thumbnailUrl: string; already_watching: boolean }[] }>(
        "/channels/youtube/subscriptions"
      ),
    youtubeWatchSubscription: (youtubeChannelId: string) =>
      request<{ channelId: string; channelName: string; thumbnailUrl: string }>(
        `/channels/youtube/subscriptions/${youtubeChannelId}/watch`,
        { method: "POST" }
      ),
```

- [ ] **Step 2: Create `link/frontend/hooks/useYouTubeAccount.ts`**

```ts
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface YouTubeSubscription {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  already_watching: boolean;
}

interface YouTubeAccountState {
  connected: boolean;
  email?: string;
  syncStatus?: "pending" | "done" | "error";
  subscriptionCount: number;
  createdAt?: string;
  loading: boolean;
}

export function useYouTubeAccount() {
  const [state, setState] = useState<YouTubeAccountState>({ connected: false, subscriptionCount: 0, loading: true });
  const [subscriptions, setSubscriptions] = useState<YouTubeSubscription[]>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.channels.youtubeStatus();
      setState({
        connected: data.connected,
        email: data.email,
        syncStatus: data.sync_status as "pending" | "done" | "error" | undefined,
        subscriptionCount: data.subscription_count || 0,
        createdAt: data.created_at,
        loading: false,
      });
    } catch {
      setState({ connected: false, subscriptionCount: 0, loading: false });
    }
  }, []);

  const loadSubscriptions = useCallback(async () => {
    setLoadingSubscriptions(true);
    try {
      const data = await api.channels.youtubeSubscriptions();
      setSubscriptions(data.subscriptions);
    } catch {
      setSubscriptions([]);
    } finally {
      setLoadingSubscriptions(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (state.connected && state.syncStatus === "done") loadSubscriptions();
  }, [state.connected, state.syncStatus, loadSubscriptions]);

  // Poll status while sync is in flight (the initial subscriptions.list pagination
  // happens in a background waitUntil task on the server — see Task 4).
  useEffect(() => {
    if (!state.connected || state.syncStatus !== "pending") return;
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [state.connected, state.syncStatus, loadStatus]);

  const connect = () => {
    window.location.href = "/api/auth/youtube/connect";
  };

  const disconnect = async () => {
    await api.channels.simpleDisconnect("youtube_account");
    setState({ connected: false, subscriptionCount: 0, loading: false });
    setSubscriptions([]);
  };

  const watchChannel = async (youtubeChannelId: string) => {
    await api.channels.youtubeWatchSubscription(youtubeChannelId);
    setSubscriptions((prev) => prev.map((s) => (s.channelId === youtubeChannelId ? { ...s, already_watching: true } : s)));
  };

  return { ...state, subscriptions, loadingSubscriptions, connect, disconnect, watchChannel };
}
```

- [ ] **Step 3: Add `YouTubeAccountCard` to `link/frontend/components/SocialChannels.tsx`**

Add the import at the top:

```tsx
import { useYouTubeAccount } from "../hooks/useYouTubeAccount";
```

Add the component (place it after `XByokChannelCard`'s closing brace, before the `// ─── Export ───` comment):

```tsx
// ─── YouTube — bespoke: OAuth connect + pick-which-subscriptions-to-watch ──

function YouTubeAccountCard({ locale }: { locale: Locale }) {
  const {
    connected, email, syncStatus, subscriptions, loadingSubscriptions, createdAt,
    connect, disconnect, watchChannel,
  } = useYouTubeAccount();

  const status = !connected ? "disconnected" : syncStatus === "pending" ? "pending" : "connected";

  return (
    <ChannelCard
      logo={<span className="text-2xl leading-none">▶️</span>}
      name="YouTube"
      tagline={{
        en: "Connect your YouTube account, then pick which subscribed channels to watch for new videos.",
        zh: "连接你的YouTube账号，选择要监控新视频的订阅频道。",
      }}
      locale={locale}
      status={status}
      statusLabel={connected && email ? email : undefined}
      createdAt={connected ? createdAt : undefined}
      extra={
        !connected ? undefined : syncStatus === "pending" ? (
          <p className="text-xs text-muted-foreground">Syncing your subscriptions…</p>
        ) : syncStatus === "error" ? (
          <p className="text-xs text-destructive">Failed to sync subscriptions — try reconnecting.</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {loadingSubscriptions ? (
              <p className="text-xs text-muted-foreground">Loading subscriptions…</p>
            ) : subscriptions.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No subscriptions found</p>
            ) : (
              subscriptions.map((s) => (
                <div key={s.channelId} className="flex items-center justify-between gap-2 py-1">
                  <span className="text-sm truncate">{s.channelName}</span>
                  <Button
                    size="sm"
                    variant={s.already_watching ? "outline" : "default"}
                    disabled={s.already_watching}
                    onClick={() => watchChannel(s.channelId)}
                  >
                    {s.already_watching ? "Watching" : "Watch"}
                  </Button>
                </div>
              ))
            )}
          </div>
        )
      }
      actions={
        connected ? (
          <Button variant="destructive" className="w-full" onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button className="w-full" onClick={connect}>
            Connect YouTube
          </Button>
        )
      }
    />
  );
}
```

- [ ] **Step 4: Render it in the exported `SocialChannels` component**

Change:

```tsx
export function SocialChannels() {
  const { locale } = useLocale();
  return (
    <>
      <XChannelCard locale={locale} />
      <XByokChannelCard locale={locale} />
      {SIMPLE_CHANNELS.map((cfg) => (
        <SimpleChannelCard key={cfg.type} config={cfg} locale={locale} />
      ))}
    </>
  );
}
```

to:

```tsx
export function SocialChannels() {
  const { locale } = useLocale();
  return (
    <>
      <XChannelCard locale={locale} />
      <XByokChannelCard locale={locale} />
      <YouTubeAccountCard locale={locale} />
      {SIMPLE_CHANNELS.map((cfg) => (
        <SimpleChannelCard key={cfg.type} config={cfg} locale={locale} />
      ))}
    </>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no new errors relative to baseline (grep the output for `SocialChannels.tsx` / `useYouTubeAccount.ts` — should be empty).

- [ ] **Step 6: Commit**

```bash
git add link/frontend/hooks/useYouTubeAccount.ts link/frontend/lib/api.ts link/frontend/components/SocialChannels.tsx
git commit -m "feat: add YouTube Connect card + subscription picker UI"
```

---

## Task 10: Frontend — `flow` module (dropdown Inspector, delete old proxy)

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/nodeTypeRegistry.ts`
- Modify: `flow/frontend/lib/api.ts`
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/node-type-registry.test.ts` (extend if a promptFragment-content assertion needs updating)

**Interfaces:**
- Consumes: `api.channels.list("YOUTUBE")` (existing, now correctly filtered post-Task-1's TWITTER-alias fix).

- [ ] **Step 1: Rewrite `YouTubeContentTriggerInspector` in `flow/frontend/components/Inspector.tsx`**

Replace the entire function (lines 315-368):

```tsx
function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const channelId = data.channelId as string;
  const [channels, setChannels] = useState<ChannelOption[]>([]);

  useEffect(() => {
    api.channels.list("YOUTUBE").then(setChannels).catch(() => setChannels([]));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Channel</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No watched YouTube channels yet — connect your YouTube account and pick channels to watch from the Social page.
            </p>
          ) : (
            <Select
              value={channelId || ""}
              onChange={(e: SelectChange) => {
                const ch = channels.find((c) => c.id === e.target.value);
                updateNodeData(nodeId, { channelId: e.target.value, channelName: ch?.username || "" });
              }}
              className="w-full text-sm"
            >
              <option value="">Select channel...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.username}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when this channel publishes a new video.</p>

        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update default node data in `flow/frontend/store/flow-editor.ts`**

Change line 155:

```ts
      data = { channelId: "", channelUrl: "", channelName: "", conditions: [] };
```

to:

```ts
      data = { channelId: "", channelName: "", conditions: [] };
```

- [ ] **Step 3: Update the registry entry's `promptFragment` in `flow/nodeTypeRegistry.ts`**

Change the `youtubeContentTrigger` entry's `promptFragment` (lines 117-120):

```ts
    promptFragment: `youtubeContentTrigger - triggers when a watched YouTube channel publishes a new video
   data: { channelId: "", channelUrl: "", channelName: "", conditions: [] }
   - channelId/channelUrl/channelName are left blank ("") — the user pastes a channel URL into the Inspector after generation, which resolves and fills these in.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
```

to:

```ts
    promptFragment: `youtubeContentTrigger - triggers when a watched YouTube channel publishes a new video
   data: { channelId: "", channelName: "", conditions: [] }
   - channelId is left blank ("") — the user picks an already-watched channel from a dropdown in the Inspector after generation. Channels are added by connecting a YouTube account (OAuth) and selecting from discovered subscriptions on the Social page — not typed here.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
```

- [ ] **Step 4: Check for any test asserting the old promptFragment text**

Run: `cd flow && grep -rn "channelUrl" tests/`

If any test asserts the old `promptFragment` string containing `channelUrl`, update it to match the new text from Step 3. If none exist, skip.

- [ ] **Step 5: Delete `channels.youtubeWatch` from `flow/frontend/lib/api.ts`**

Remove:

```ts
    youtubeWatch: (channelUrl: string) =>
      request<{ channelId: string; channelName: string; thumbnailUrl: string }>(`/api/channels/youtube/watch`, {
        method: "POST",
        body: JSON.stringify({ channelUrl }),
      }),
```

- [ ] **Step 6: Delete the proxy route from `flow/src/index.ts`**

Remove:

```ts
// Proxy YouTube watch-channel from link worker (for the youtubeContentTrigger Inspector)
app.post("/api/channels/youtube/watch", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const body = await c.req.text();
  const res = await fetch(`${linkUrl}/api/channels/youtube/watch`, {
    method: "POST",
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "", "Content-Type": "application/json" },
    body,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});
```

(The new subscription-picker UI lives entirely in `link`'s own frontend from Task 9 — nothing in `flow` needs to reach `link`'s new `/youtube/subscriptions*` endpoints.)

- [ ] **Step 7: Run the full `flow` test suite**

Run: `cd flow && npx vitest run`
Expected: no failures beyond the one known pre-existing unrelated `USER_FLOW_SIDEBAR_ORDER` failure.

- [ ] **Step 8: Typecheck**

Run: `cd flow && npx tsc --noEmit`
Expected: no new errors relative to baseline (grep for `Inspector.tsx`, `flow-editor.ts`, `nodeTypeRegistry.ts`, `api.ts`, `index.ts` — should be empty).

- [ ] **Step 9: Commit**

```bash
git add flow/frontend/components/Inspector.tsx flow/frontend/store/flow-editor.ts flow/nodeTypeRegistry.ts flow/frontend/lib/api.ts flow/src/index.ts
git commit -m "feat: switch youtubeContentTrigger Inspector to a channel dropdown, delete old URL-paste proxy"
```

---

## Task 11: Deploy and manual verification

**Files:** none (operational task)

- [ ] **Step 1: Manual prerequisite (not automatable) — confirm the Google Cloud OAuth client is ready**

Before deploying, confirm with whoever manages Google Cloud Console access that:
1. `link`'s two redirect URIs have been added to the existing "Sign in with Google" OAuth client's allowlist (Task 1, Step 7).
2. `GOOGLE_CLIENT_SECRET` has been set via `wrangler secret put --env dev` (and `--env production` when ready) on `link`, using the same value already configured for `web`.

If either is not done, the OAuth connect flow will fail at the callback step (`validateAuthorizationCode` will reject an unregistered redirect URI) — do not proceed to live browser verification until confirmed.

- [ ] **Step 2: Run both full test suites**

```bash
cd link && npx vitest run
cd flow && npx vitest run
```

Expected: both match their known pre-existing baselines (no new failures).

- [ ] **Step 3: Deploy both modules to dev**

```bash
cd link && npm run deploy:dev
cd flow && npm run deploy:dev
```

- [ ] **Step 4: Browser verification**

Using an already-logged-in dev session:
1. Go to the Social/Channels page. Confirm a "YouTube" card appears with a "Connect YouTube" button.
2. Click Connect — confirm it redirects through Google's OAuth consent screen (using an account that has at least one YouTube subscription) and back to the app.
3. Confirm the card shows "Syncing your subscriptions…" briefly, then transitions to a list of subscribed channels.
4. Click "Watch" on one channel — confirm its button changes to a disabled "Watching" state.
5. Open the flow editor, create/open a content-domain flow, add a YouTube Trigger node — confirm its Inspector now shows a "Channel" dropdown (not a URL input), and that the just-watched channel appears in it.
6. Select that channel, add a `duration`/`has_face` condition (as in the original feature's verification), connect it to an `xContentAction` create-post node, and publish — confirm publish succeeds (this reuses the already-fixed `validate-flow-graph.ts` orphan detection from the original feature, unaffected by this plan).
7. Back on the Social page, click "Disconnect" on the YouTube card — confirm the card returns to "Connect YouTube", and separately confirm (via `wrangler d1 execute` on `uniscrm-link-dev`, `SELECT is_active FROM channels WHERE channel_type = 'YOUTUBE' AND id = '<the watched channel's id>'`) that the watched channel row is still `is_active = 1` — i.e., disconnecting the account did not tear down the watch.

- [ ] **Step 5: Report status**

Summarize: tests passing (counts), dev deployment successful, which of the 7 verification steps were completed vs. deferred (e.g. if no test Google account with real subscriptions was available) — per this project's convention of reporting explicitly rather than claiming untested success.
