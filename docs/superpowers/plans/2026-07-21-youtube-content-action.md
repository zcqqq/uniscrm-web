# YouTube Content Action Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `youtubeContentAction` flow node that lets a content flow, via the triggering YouTube account, either save the triggering video to a user-owned playlist (`playlistItems.insert`) or like it (`videos.rate`).

**Architecture:** Follows the existing `xContentAction`/`tiktokContentAction` layering: metadata declares two `flowType:"action"` operations → the flow editor configures the node → `flow` worker's `executeContentActions` dispatches to `link` internal endpoints → `link` refreshes the channel's Google OAuth token and calls the YouTube Data API. Writes need OAuth (not the read-only Data API key), so YouTube OAuth is extended to request write scope + a refresh token.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, KV, vitest (`@cloudflare/vitest-pool-workers`), React (React Flow) frontend, YouTube Data API v3, Google OAuth (arctic).

## Global Constraints

- **Write scope:** `https://www.googleapis.com/auth/youtube.force-ssl` (covers both `videos.rate` and `playlistItems.insert`). Existing scopes `openid`, `email`, `youtube.readonly` are kept.
- **Refresh token:** authorization URL MUST set `access_type=offline` and `prompt=consent select_account`; the callback MUST persist `refresh_token` into channel `config` (plaintext, matching the existing YouTube/X-system/TikTok token storage — BYOK encryption does not apply to the single system app).
- **Acting channel:** every operation acts via the triggering channel (runtime `channelId` = the YouTube account that surfaced the video), exactly like `xContentAction`. No target-account picker. `youtubeContentAction` is NOT added to `ACTION_CHANNEL_TYPE`.
- **Migration (decided):** additive only. Existing YouTube channels have neither write scope nor refresh token; their write actions fail to the `failed` branch until the user reconnects. No detection/prompt UI.
- **Quota (decided):** NO per-tenant rate limit. Instead a platform-wide KV counter of write-quota units (50 units per write) with a one-per-Pacific-day `console.error` alert when daily usage crosses 8000 units (80% of the shared 10,000/day Google Cloud project pool).
- **403 `quotaExceeded`** maps to `rateLimited` with `rateLimitReset` = next Pacific midnight (quota reset), NOT a permanent failure. Other 4xx/5xx → `failed`.
- **Price fields are display-only** (never deduct credit) — consistent with all existing content actions.
- **API response payloads are never stored in the DB** — logged only (project rule).
- Third-party API actions have `success`/`failed` branches (`flow/CLAUDE.md`).
- Tests: `cd link && npm test` or `cd flow && npm test` (both `vitest run`).

---

### Task 1: Metadata — two YouTube action entries

**Files:**
- Modify: `metadata/youtube.ts`
- Test: `metadata/` has no test dir; assert via `flow/tests/unit/youtube-action-metadata.test.ts` (Create)

**Interfaces:**
- Produces: two `ContentMetadata` entries in `ContentMetadata_YouTube` with `flowType:"action"`, `sourceContentType` `"save-to-playlist"` and `"rate-like"`, each with `label`, `description`, `price`, `contentProps: []`.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/youtube-action-metadata.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("ContentMetadata_YouTube actions", () => {
  const actions = ContentMetadata_YouTube.filter((m) => m.flowType === "action");

  it("declares exactly save-to-playlist and rate-like actions", () => {
    expect(actions.map((a) => a.sourceContentType).sort()).toEqual(["rate-like", "save-to-playlist"]);
  });

  it("each action has en+zh label/description, a price, and no contentProps", () => {
    for (const a of actions) {
      expect(a.label?.en).toBeTruthy();
      expect(a.label?.zh).toBeTruthy();
      expect(a.description?.en).toBeTruthy();
      expect(a.description?.zh).toBeTruthy();
      expect(typeof a.price).toBe("number");
      expect(a.contentProps).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/youtube-action-metadata.test.ts`
Expected: FAIL — only 0 actions found (`[]` !== `["rate-like","save-to-playlist"]`).

- [ ] **Step 3: Add the two action entries**

In `metadata/youtube.ts`, append these two objects inside the `ContentMetadata_YouTube` array (after the existing `watch:get-videos` trigger entry):

```typescript
  {
    sourceContentType: "save-to-playlist", // https://developers.google.com/youtube/v3/docs/playlistItems/insert
    flowType: "action",
    price: 0.001,
    label: { "en": "Save to Playlist", "zh": "加入播放列表" },
    description: { "en": "Adds the video to a playlist via the triggering channel", "zh": "通过触发该内容的账号把视频加入播放列表" },
    contentProps: [],
  },
  {
    sourceContentType: "rate-like", // https://developers.google.com/youtube/v3/docs/videos/rate
    flowType: "action",
    price: 0.001,
    label: { "en": "Like", "zh": "点赞" },
    description: { "en": "Likes the video via the triggering channel", "zh": "通过触发该内容的账号给视频点赞" },
    contentProps: [],
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/youtube-action-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add metadata/youtube.ts flow/tests/unit/youtube-action-metadata.test.ts
git commit -m "feat(metadata): add YouTube save-to-playlist and rate-like actions"
```

---

### Task 2: YouTube OAuth — write scope + offline refresh token

**Files:**
- Modify: `link/src/oauth.ts` (authorization URL ~line 396-404; callback config ~line 446-454)
- Test: `link/tests/oauth-youtube-writescope.test.ts` (Create)

**Interfaces:**
- Produces: the YouTube authorization URL includes scope `youtube.force-ssl`, `access_type=offline`, `prompt=consent select_account`; the callback stores `refresh_token` in `config`.

- [ ] **Step 1: Write the failing test**

Look first at `link/tests/oauth-youtube.test.ts` for the existing arctic `Google` mock pattern and reuse its structure. Create `link/tests/oauth-youtube-writescope.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

const createAuthorizationURLMock = vi.fn().mockReturnValue(new URL("https://accounts.google.com/o/oauth2/v2/auth"));

vi.mock("arctic", () => ({
  Google: class {
    createAuthorizationURL(...args: unknown[]) { return createAuthorizationURLMock(...args); }
  },
  generateState: () => "state",
  generateCodeVerifier: () => "verifier",
  decodeIdToken: () => ({ sub: "google-user", email: "u@example.com" }),
}));

describe("YouTube OAuth authorization URL", () => {
  it("requests youtube.force-ssl scope, offline access, and consent prompt", async () => {
    const { buildYouTubeAuthUrl } = await import("../src/oauth");
    const url = buildYouTubeAuthUrl("client", "secret", "https://app.test/api/auth/youtube/callback");
    const scopes = createAuthorizationURLMock.mock.calls[0][2] as string[];
    expect(scopes).toContain("https://www.googleapis.com/auth/youtube.force-ssl");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/oauth-youtube-writescope.test.ts`
Expected: FAIL — `buildYouTubeAuthUrl` is not exported.

- [ ] **Step 3: Extract and update the authorization-URL builder**

In `link/src/oauth.ts`, add this exported helper near the top of the file (below imports):

```typescript
export function buildYouTubeAuthUrl(clientId: string, clientSecret: string, redirectUri: string): URL {
  const google = new Google(clientId, clientSecret, redirectUri);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const oauthUrl = google.createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ]);
  // access_type=offline + prompt=consent are BOTH required for Google to return a refresh
  // token. select_account keeps the account chooser so a tenant can connect a different
  // Google account after disconnecting.
  oauthUrl.searchParams.set("access_type", "offline");
  oauthUrl.searchParams.set("prompt", "consent select_account");
  return { url: oauthUrl, state, codeVerifier } as unknown as URL;
}
```

Note: the helper must return the state/codeVerifier too. Change its signature to return an object and adjust the test accordingly. Use this final form instead:

```typescript
export function buildYouTubeAuthUrl(clientId: string, clientSecret: string, redirectUri: string): {
  url: URL; state: string; codeVerifier: string;
} {
  const google = new Google(clientId, clientSecret, redirectUri);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ]);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  return { url, state, codeVerifier };
}
```

And update the test's assertions to read `const { url } = buildYouTubeAuthUrl(...)` and check `url.searchParams`. (Fix the test in Step 1 to destructure `{ url }`.)

Then replace the inline URL construction in the `/youtube/connect` route (currently ~line 393-404) with:

```typescript
    const url = new URL(c.req.url);
    const { url: oauthUrl, state, codeVerifier } = buildYouTubeAuthUrl(
      c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${url.origin}/api/auth/youtube/callback`
    );
    await c.env.KV.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier, tenantId, memberId }), { expirationTtl: 300 });
    return c.redirect(oauthUrl.toString(), 302);
```

- [ ] **Step 4: Persist the refresh token in the callback**

In the `/youtube/callback` handler, change the `config` object (currently ~line 446-454) to include the refresh token:

```typescript
    const config = {
      google_user_id: googleUserId,
      email,
      access_token: tokens.accessToken(),
      refresh_token: tokens.refreshToken(),
      expires_at: expiresAt,
      subscriptions: [] as unknown[],
      sync_status: "pending" as const,
      last_synced_at: null as string | null,
    };
```

Note: `tokens.refreshToken()` throws in arctic if absent. Guard it:

```typescript
    let refreshToken: string | null = null;
    try { refreshToken = tokens.refreshToken(); } catch { refreshToken = null; }
```

and set `refresh_token: refreshToken` in the config.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd link && npx vitest run tests/oauth-youtube-writescope.test.ts`
Expected: PASS.

- [ ] **Step 6: Run existing YouTube OAuth tests (no regression)**

Run: `cd link && npx vitest run tests/oauth-youtube.test.ts`
Expected: PASS (update that test if it asserts the exact scope array — add the new scope there too).

- [ ] **Step 7: Commit**

```bash
git add link/src/oauth.ts link/tests/oauth-youtube-writescope.test.ts link/tests/oauth-youtube.test.ts
git commit -m "feat(link): request YouTube write scope + offline refresh token"
```

---

### Task 3: YouTube token service (refresh)

**Files:**
- Create: `link/src/services/youtube-token.ts`
- Test: `link/tests/services/youtube-token.test.ts` (Create)

**Interfaces:**
- Produces: `class YouTubeTokenService { constructor(db: D1Database, clientId: string, clientSecret: string); getValidToken(channelId: string): Promise<string>; forceRefresh(channelId: string): Promise<string>; }`. `getValidToken` returns the current access token, proactively refreshing if it expires within 10 minutes. Throws `Error("No YouTube refresh token")` when the stored config lacks one (existing pre-write-scope channels). Consumed by Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Create `link/tests/services/youtube-token.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { YouTubeTokenService } from "../../src/services/youtube-token";

function makeDb(config: Record<string, unknown>) {
  const state = { config: JSON.stringify(config) };
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => ({ config: state.config }),
            run: async () => { /* UPDATE writes captured below */ },
          };
        },
        _sql: sql,
      };
    },
    _state: state,
  } as unknown as D1Database & { _state: { config: string } };
}

describe("YouTubeTokenService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the stored token when it is not near expiry", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const db = makeDb({ access_token: "tok", refresh_token: "r", expires_at: future });
    const svc = new YouTubeTokenService(db, "id", "sec");
    expect(await svc.getValidToken("ch")).toBe("tok");
  });

  it("refreshes when expiring within 10 minutes and persists the new token", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const db = makeDb({ access_token: "old", refresh_token: "r", expires_at: soon });
    const runSpy = vi.fn(async () => {});
    // capture UPDATE
    (db as any).prepare = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => ({ config: JSON.stringify({ access_token: "old", refresh_token: "r", expires_at: soon }) }),
        run: async () => runSpy(sql, args),
      }),
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 })));
    const svc = new YouTubeTokenService(db, "id", "sec");
    expect(await svc.getValidToken("ch")).toBe("new");
    expect(runSpy).toHaveBeenCalled();
  });

  it("throws when there is no refresh token", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const db = makeDb({ access_token: "old", expires_at: soon });
    const svc = new YouTubeTokenService(db, "id", "sec");
    await expect(svc.getValidToken("ch")).rejects.toThrow("No YouTube refresh token");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/youtube-token.test.ts`
Expected: FAIL — module `youtube-token` not found.

- [ ] **Step 3: Implement the service**

Create `link/src/services/youtube-token.ts`:

```typescript
interface YouTubeChannelConfig {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: string;
  [k: string]: unknown;
}

// Unlike X (single-use rotating refresh tokens that revoke the lineage on reuse), Google
// refresh tokens are reusable, so concurrent refreshes are harmless (last-write-wins) and no
// D1 refresh lock is needed here.
export class YouTubeTokenService {
  constructor(
    private db: D1Database,
    private clientId: string,
    private clientSecret: string,
  ) {}

  private async loadConfig(channelId: string): Promise<YouTubeChannelConfig> {
    const row = await this.db.prepare(`SELECT config FROM channels WHERE id = ?`).bind(channelId).first<{ config: string }>();
    if (!row) throw new Error("Channel not found");
    return JSON.parse(row.config) as YouTubeChannelConfig;
  }

  async getValidToken(channelId: string): Promise<string> {
    const config = await this.loadConfig(channelId);
    if (config.expires_at) {
      const msLeft = new Date(config.expires_at).getTime() - Date.now();
      if (msLeft > 10 * 60 * 1000) return config.access_token;
    }
    return this.forceRefresh(channelId);
  }

  async forceRefresh(channelId: string): Promise<string> {
    const config = await this.loadConfig(channelId);
    if (!config.refresh_token) throw new Error("No YouTube refresh token");

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: config.refresh_token,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`YouTube token refresh failed ${res.status}: ${err}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    config.access_token = data.access_token;
    if (data.refresh_token) config.refresh_token = data.refresh_token;
    if (data.expires_in) config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await this.db.prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(config), channelId).run();
    return data.access_token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/youtube-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-token.ts link/tests/services/youtube-token.test.ts
git commit -m "feat(link): add YouTubeTokenService for OAuth token refresh"
```

---

### Task 4: YouTube actions service (rate + playlist insert)

**Files:**
- Create: `link/src/services/youtube-actions.ts`
- Test: `link/tests/services/youtube-actions.test.ts` (Create)

**Interfaces:**
- Produces:
  - `nextPacificMidnightISO(now?: Date): string`
  - `rateVideo(accessToken: string, videoId: string): Promise<YouTubeActionResult>`
  - `insertPlaylistItem(accessToken: string, playlistId: string, videoId: string): Promise<YouTubeActionResult>`
  - `type YouTubeActionResult = { ok: boolean; rateLimited?: boolean; rateLimitReset?: string; unauthorized?: boolean }`
- Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `link/tests/services/youtube-actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateVideo, insertPlaylistItem, nextPacificMidnightISO } from "../../src/services/youtube-actions";

describe("youtube-actions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rateVideo returns ok on 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: true });
  });

  it("rateVideo maps 403 quotaExceeded to rateLimited with a reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), { status: 403 })));
    const r = await rateVideo("tok", "vid");
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(typeof r.rateLimitReset).toBe("string");
  });

  it("rateVideo maps 401 to unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: false, unauthorized: true });
  });

  it("rateVideo maps other 4xx to failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: false });
  });

  it("insertPlaylistItem returns ok on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })));
    expect(await insertPlaylistItem("tok", "pl", "vid")).toEqual({ ok: true });
  });

  it("nextPacificMidnightISO is in the future", () => {
    const iso = nextPacificMidnightISO(new Date());
    expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/youtube-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `link/src/services/youtube-actions.ts`:

```typescript
export type YouTubeActionResult = {
  ok: boolean;
  rateLimited?: boolean;
  rateLimitReset?: string;
  unauthorized?: boolean;
};

// Next midnight in America/Los_Angeles, expressed as a UTC ISO string. The YouTube Data API
// daily quota resets at midnight Pacific. The offset is computed at `now`; DST transitions
// exactly at midnight are an accepted edge case for a retry hint.
export function nextPacificMidnightISO(now: Date = new Date()): string {
  const ptNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offsetMs = now.getTime() - ptNow.getTime();
  const ptMidnight = new Date(ptNow);
  ptMidnight.setHours(24, 0, 0, 0);
  return new Date(ptMidnight.getTime() + offsetMs).toISOString();
}

async function mapResponse(res: Response): Promise<YouTubeActionResult> {
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, unauthorized: true };
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    if (body.includes("quotaExceeded")) {
      return { ok: false, rateLimited: true, rateLimitReset: nextPacificMidnightISO() };
    }
  }
  return { ok: false };
}

export async function rateVideo(accessToken: string, videoId: string): Promise<YouTubeActionResult> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos/rate");
  url.searchParams.set("id", videoId);
  url.searchParams.set("rating", "like");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return mapResponse(res);
}

export async function insertPlaylistItem(accessToken: string, playlistId: string, videoId: string): Promise<YouTubeActionResult> {
  const res = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    }),
  });
  return mapResponse(res);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/youtube-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-actions.ts link/tests/services/youtube-actions.test.ts
git commit -m "feat(link): add YouTube rate + playlist-insert action service"
```

---

### Task 5: Quota counter + threshold alert

**Files:**
- Create: `link/src/services/youtube-quota.ts`
- Test: `link/tests/services/youtube-quota.test.ts` (Create)

**Interfaces:**
- Produces: `recordYouTubeWriteQuota(env: Env, units?: number): Promise<void>` (default 50) and `pacificDateKey(now?: Date): string`. Increments KV key `yt_quota:{PT-date}` and emits a single `console.error` event `youtube_quota_threshold_exceeded` per PT-day when daily usage crosses 8000 units.
- Consumed by Task 6.

Note: KV get/put is eventually consistent, so concurrent increments may undercount — acceptable for a monitoring counter (documented, not load-bearing).

- [ ] **Step 1: Write the failing test**

Create `link/tests/services/youtube-quota.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordYouTubeWriteQuota, pacificDateKey } from "../../src/services/youtube-quota";

function makeKV(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v; }),
    _store: store,
  };
}

describe("youtube-quota", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pacificDateKey returns YYYY-MM-DD", () => {
    expect(pacificDateKey(new Date("2026-07-21T20:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("increments the daily counter by 50", async () => {
    const KV = makeKV();
    const env = { KV } as any;
    await recordYouTubeWriteQuota(env);
    const key = `yt_quota:${pacificDateKey()}`;
    expect(Number(KV._store[key])).toBe(50);
  });

  it("alerts once when crossing 8000 units", async () => {
    const key = `yt_quota:${pacificDateKey()}`;
    const KV = makeKV({ [key]: "7980" });
    const env = { KV } as any;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordYouTubeWriteQuota(env); // 7980 -> 8030, crosses 8000
    expect(errSpy).toHaveBeenCalledTimes(1);
    // second crossing does not re-alert (flag set)
    await recordYouTubeWriteQuota(env);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/youtube-quota.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the counter**

Create `link/src/services/youtube-quota.ts`:

```typescript
import type { Env } from "../types";

const DAILY_THRESHOLD = 8000; // 80% of the shared 10,000/day Google Cloud project pool
const TTL_SECONDS = 2 * 24 * 60 * 60;

export function pacificDateKey(now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD
  return now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export async function recordYouTubeWriteQuota(env: Env, units = 50): Promise<void> {
  const date = pacificDateKey();
  const counterKey = `yt_quota:${date}`;
  const prev = Number((await env.KV.get(counterKey)) ?? "0");
  const next = prev + units;
  await env.KV.put(counterKey, String(next), { expirationTtl: TTL_SECONDS });

  if (prev < DAILY_THRESHOLD && next >= DAILY_THRESHOLD) {
    const alertKey = `yt_quota_alerted:${date}`;
    if (!(await env.KV.get(alertKey))) {
      await env.KV.put(alertKey, "1", { expirationTtl: TTL_SECONDS });
      console.error(JSON.stringify({
        event: "youtube_quota_threshold_exceeded",
        date, units: next, threshold: DAILY_THRESHOLD,
      }));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/youtube-quota.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-quota.ts link/tests/services/youtube-quota.test.ts
git commit -m "feat(link): add YouTube write-quota counter with daily threshold alert"
```

---

### Task 6: link internal endpoints — `/internal/youtube/rate` and `/internal/youtube/playlist-insert`

**Files:**
- Modify: `link/src/routes-internal.ts` (add two `router.post` handlers alongside the existing `/x/like` handler; add imports)
- Test: `link/tests/services/youtube-internal-endpoints.test.ts` (Create)

**Interfaces:**
- Consumes: `YouTubeTokenService` (Task 3), `rateVideo`/`insertPlaylistItem` (Task 4), `recordYouTubeWriteQuota` (Task 5).
- Produces: `POST /internal/youtube/rate` body `{ channelId, contentId, videoId, flowId? }` and `POST /internal/youtube/playlist-insert` body `{ channelId, contentId, videoId, playlistId, flowId? }`. Both return `{ ok: boolean }` or `{ ok: false, rateLimited: true, rateLimitReset }`.

- [ ] **Step 1: Write the failing test**

Create `link/tests/services/youtube-internal-endpoints.test.ts`. Mirror the mocking style in `link/tests/oauth.test.ts` (module mocks + a fake D1). Mock the token service and actions service so the test exercises the endpoint wiring only:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const getValidToken = vi.fn(async () => "tok");
const forceRefresh = vi.fn(async () => "tok2");
vi.mock("../../src/services/youtube-token", () => ({
  YouTubeTokenService: class { getValidToken = getValidToken; forceRefresh = forceRefresh; },
}));
const rateVideo = vi.fn();
const insertPlaylistItem = vi.fn();
vi.mock("../../src/services/youtube-actions", () => ({ rateVideo, insertPlaylistItem, nextPacificMidnightISO: () => "2026-07-22T07:00:00.000Z" }));
const recordYouTubeWriteQuota = vi.fn(async () => {});
vi.mock("../../src/services/youtube-quota", () => ({ recordYouTubeWriteQuota, pacificDateKey: () => "2026-07-21" }));

function makeEnv() {
  return {
    LINK_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config: JSON.stringify({ google_user_id: "g" }) }) }) }) },
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", KV: {},
  } as any;
}

async function callRate(env: any, body: any) {
  const { internalRoutes } = await import("../../src/routes-internal");
  const app = internalRoutes();
  return app.request("/youtube/rate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, env);
}

describe("POST /internal/youtube/rate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok and records quota on success", async () => {
    rateVideo.mockResolvedValue({ ok: true });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: true });
    expect(recordYouTubeWriteQuota).toHaveBeenCalled();
  });

  it("propagates rateLimited without recording quota", async () => {
    rateVideo.mockResolvedValue({ ok: false, rateLimited: true, rateLimitReset: "2026-07-22T07:00:00.000Z" });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: false, rateLimited: true, rateLimitReset: "2026-07-22T07:00:00.000Z" });
    expect(recordYouTubeWriteQuota).not.toHaveBeenCalled();
  });

  it("retries once after unauthorized", async () => {
    rateVideo.mockResolvedValueOnce({ ok: false, unauthorized: true }).mockResolvedValueOnce({ ok: true });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: true });
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });
});
```

Note: the exported factory in `link/src/routes-internal.ts` is `internalRoutes()` (returns a Hono app). The test above uses it directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/youtube-internal-endpoints.test.ts`
Expected: FAIL — routes return 404 (handlers not registered).

- [ ] **Step 3: Add imports and handlers**

In `link/src/routes-internal.ts` add to the imports at the top:

```typescript
import { YouTubeTokenService } from "./services/youtube-token";
import { rateVideo, insertPlaylistItem } from "./services/youtube-actions";
import { recordYouTubeWriteQuota } from "./services/youtube-quota";
```

Add these two handlers immediately after the existing `router.post("/x/like", ...)` handler (found ~line 312-335):

```typescript
  // Likes contentId's originating YouTube video via the channel that ingested it. channelId is
  // always the flow's triggering YouTube account — no account picker.
  router.post("/youtube/rate", async (c) => {
    const { channelId, contentId, videoId, flowId } = await c.req.json<{
      channelId: string; contentId: string; videoId: string; flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT'")
      .bind(channelId).first<{ config: string }>();
    if (!channel) return c.json({ ok: false });

    const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
    let accessToken: string;
    try {
      accessToken = await tokenService.getValidToken(channelId);
    } catch (e) {
      // Existing channel connected before write scope / offline access — no refresh token.
      console.log(JSON.stringify({ event: "youtube_rate_no_token", contentId, channelId, error: String(e) }));
      return c.json({ ok: false });
    }

    let result = await rateVideo(accessToken, videoId);
    if (result.unauthorized) {
      try {
        accessToken = await tokenService.forceRefresh(channelId);
        result = await rateVideo(accessToken, videoId);
      } catch {
        return c.json({ ok: false });
      }
    }
    if (result.ok) await recordYouTubeWriteQuota(c.env);

    console.log(JSON.stringify({ event: "youtube_rate", contentId, channelId, videoId, flowId: flowId || null, ok: result.ok, rateLimited: !!result.rateLimited }));
    if (result.rateLimited) return c.json({ ok: false, rateLimited: true, rateLimitReset: result.rateLimitReset });
    return c.json({ ok: result.ok });
  });

  // Saves contentId's originating YouTube video into a user-owned playlist via the triggering channel.
  router.post("/youtube/playlist-insert", async (c) => {
    const { channelId, contentId, videoId, playlistId, flowId } = await c.req.json<{
      channelId: string; contentId: string; videoId: string; playlistId: string; flowId?: string | null;
    }>();
    if (!playlistId) return c.json({ ok: false });

    const channel = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT'")
      .bind(channelId).first<{ config: string }>();
    if (!channel) return c.json({ ok: false });

    const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
    let accessToken: string;
    try {
      accessToken = await tokenService.getValidToken(channelId);
    } catch (e) {
      console.log(JSON.stringify({ event: "youtube_playlist_insert_no_token", contentId, channelId, error: String(e) }));
      return c.json({ ok: false });
    }

    let result = await insertPlaylistItem(accessToken, playlistId, videoId);
    if (result.unauthorized) {
      try {
        accessToken = await tokenService.forceRefresh(channelId);
        result = await insertPlaylistItem(accessToken, playlistId, videoId);
      } catch {
        return c.json({ ok: false });
      }
    }
    if (result.ok) await recordYouTubeWriteQuota(c.env);

    console.log(JSON.stringify({ event: "youtube_playlist_insert", contentId, channelId, videoId, playlistId, flowId: flowId || null, ok: result.ok, rateLimited: !!result.rateLimited }));
    if (result.rateLimited) return c.json({ ok: false, rateLimited: true, rateLimitReset: result.rateLimitReset });
    return c.json({ ok: result.ok });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/youtube-internal-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/youtube-internal-endpoints.test.ts
git commit -m "feat(link): add /internal/youtube/rate and /internal/youtube/playlist-insert"
```

---

### Task 7: Playlists API route — `GET /api/channels/youtube/playlists`

**Files:**
- Modify: `link/src/routes-channels.ts` (add handler after the existing `/youtube/subscriptions` handler, ~line 263)
- Test: `link/tests/routes-channels-youtube-playlists.test.ts` (Create)

**Interfaces:**
- Consumes: `YouTubeTokenService` (Task 3).
- Produces: `GET /youtube/playlists` → `{ connected: boolean; needsReconnect?: boolean; playlists: { id: string; title: string }[] }`. Resolves the tenant's single active `YOUTUBE_ACCOUNT` channel, lists `playlists.list?mine=true`. Consumed by the frontend in Task 11.

- [ ] **Step 1: Write the failing test**

Create `link/tests/routes-channels-youtube-playlists.test.ts`. Follow the mocking pattern in `link/tests/routes-channels-youtube-account.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const getValidToken = vi.fn(async () => "tok");
vi.mock("../src/services/youtube-token", () => ({
  YouTubeTokenService: class { getValidToken = getValidToken; },
}));

// import the channels router factory; match the real exported name.
async function mount(env: any) {
  const { channelsRoutes } = await import("../src/routes-channels");
  const app = channelsRoutes();
  return app;
}

function envWithAccount(hasAccount: boolean) {
  return {
    LINK_DB: { prepare: () => ({ bind: () => ({ first: async () => (hasAccount ? { id: "acc" } : null) }) }) },
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec",
  } as any;
}

describe("GET /youtube/playlists", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns connected:false when no YouTube account", async () => {
    const app = await mount(envWithAccount(false));
    const res = await app.request("/youtube/playlists", { method: "GET" }, envWithAccount(false));
    expect(await res.json()).toMatchObject({ connected: false, playlists: [] });
  });

  it("lists playlists for a connected account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: "pl1", snippet: { title: "Watch queue" } }],
    }), { status: 200 })));
    const env = envWithAccount(true);
    const app = await mount(env);
    const res = await app.request("/youtube/playlists", { method: "GET" }, env);
    expect(await res.json()).toEqual({ connected: true, playlists: [{ id: "pl1", title: "Watch queue" }] });
  });
});
```

Note: the exported factory is `channelsRoutes()`. The route reads `tenantId` from context middleware — follow exactly how `routes-channels-youtube-account.test.ts` injects `tenantId` into context (it already tests a tenant-scoped route) and match that harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/routes-channels-youtube-playlists.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the route**

In `link/src/routes-channels.ts`, add the import near the top:

```typescript
import { YouTubeTokenService } from "./services/youtube-token";
```

Add this handler right after the `/youtube/subscriptions` handler (~line 263):

```typescript
  router.get("/youtube/playlists", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string }>();
    if (!accountRow) return c.json({ connected: false, playlists: [] });

    const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
    let accessToken: string;
    try {
      accessToken = await tokenService.getValidToken(accountRow.id);
    } catch {
      // Account connected before offline access → no refresh token to list with. The user
      // must reconnect to use write actions anyway.
      return c.json({ connected: true, needsReconnect: true, playlists: [] });
    }

    const res = await fetch(
      "https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return c.json({ connected: true, playlists: [] });
    const data = (await res.json()) as { items?: { id: string; snippet?: { title?: string } }[] };
    return c.json({
      connected: true,
      playlists: (data.items || []).map((i) => ({ id: i.id, title: i.snippet?.title || i.id })),
    });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/routes-channels-youtube-playlists.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-channels.ts link/tests/routes-channels-youtube-playlists.test.ts
git commit -m "feat(link): add GET /api/channels/youtube/playlists"
```

---

### Task 8: Flow engine — map `youtubeContentAction`

**Files:**
- Modify: `flow/src/engine.ts` (`ActionResult` interface ~line 30; `isExternalApi` ~line 265; add mapping block ~after line 289)
- Test: `flow/tests/unit/engine-youtube-action.test.ts` (Create)

**Interfaces:**
- Produces: `buildActionData(targetNode: FlowNode): ActionResult` (currently unexported at ~line 259 in `flow/src/engine.ts`) returns `{ type: "youtubeContentAction", nodeId, hasBranches: true, operation, playlistId }` for a `youtubeContentAction` node. This task exports `buildActionData` so it can be unit-tested directly.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/engine-youtube-action.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildActionData } from "../../src/engine";

function node(data: Record<string, unknown>) {
  return { id: "a", type: "action", data } as any;
}

describe("buildActionData youtubeContentAction", () => {
  it("maps save-to-playlist with playlistId and success/failed branches", () => {
    const r = buildActionData(node({ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1" }));
    expect(r).toMatchObject({ type: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1", hasBranches: true });
  });

  it("defaults operation to save-to-playlist", () => {
    const r = buildActionData(node({ actionType: "youtubeContentAction" }));
    expect(r.operation).toBe("save-to-playlist");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/engine-youtube-action.test.ts`
Expected: FAIL — `youtubeContentAction` not recognized (no `operation`/`playlistId`, `hasBranches` false).

- [ ] **Step 3: Update engine mapping**

In `flow/src/engine.ts`:

1. Add `playlistId?: string;` to the `ActionResult` interface (the one at ~line 30 that already has `operation?`, `channelId?`, etc.).

2. Export `buildActionData` by changing `function buildActionData(` (~line 259) to `export function buildActionData(`.

3. Extend the `isExternalApi` expression (~line 265) to include the new type:

```typescript
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction" || actionType === "tiktokContentAction" || actionType === "videoAction" || actionType === "youtubeContentAction";
```

4. Add this mapping block after the `videoAction` block (~after line 291, before `return actionData;`):

```typescript
  if (actionType === "youtubeContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "save-to-playlist";
    actionData.playlistId = (targetNode.data.playlistId as string) || "";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/engine-youtube-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine-youtube-action.test.ts
git commit -m "feat(flow): map youtubeContentAction node to ActionResult"
```

---

### Task 9: Flow runtime dispatch — `executeContentActions`

**Files:**
- Modify: `flow/src/index.ts` (`executeContentActions`, add branch after the `tiktokContentAction` branch, ~line 467+)
- Test: `flow/tests/unit/dispatch-youtube-action.test.ts` (Create)

**Interfaces:**
- Consumes: `ActionResult` with `type:"youtubeContentAction"`, `operation`, `playlistId` (Task 8). `payload.source_content_id` = videoId.
- Produces: HTTP calls to `${env.LINK_URL}/internal/youtube/rate` (operation `rate-like`) or `/internal/youtube/playlist-insert` (operation `save-to-playlist`), then resolves `success`/`failed` branch, collecting `rateLimited` for reschedule — same tail logic as the `xContentAction` bookmark path.

The `executeContentActions` function is not exported. Test the branch by extracting the dispatch decision into a small exported pure helper and unit-testing that, OR test at a higher level if a seam exists. Use the helper approach below.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/dispatch-youtube-action.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { youtubeActionRequest } from "../../src/index";

describe("youtubeActionRequest", () => {
  const base = { env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" }, channelId: "ch", contentId: "c", flowId: "f", payload: { source_content_id: "vid" } };

  it("routes rate-like to /internal/youtube/rate", () => {
    const req = youtubeActionRequest({ ...base, action: { type: "youtubeContentAction", operation: "rate-like" } as any });
    expect(req.url).toBe("https://link/internal/youtube/rate");
    expect(JSON.parse(req.body)).toEqual({ channelId: "ch", contentId: "c", videoId: "vid", flowId: "f" });
  });

  it("routes save-to-playlist to /internal/youtube/playlist-insert with playlistId", () => {
    const req = youtubeActionRequest({ ...base, action: { type: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1" } as any });
    expect(req.url).toBe("https://link/internal/youtube/playlist-insert");
    expect(JSON.parse(req.body)).toEqual({ channelId: "ch", contentId: "c", videoId: "vid", playlistId: "pl1", flowId: "f" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/dispatch-youtube-action.test.ts`
Expected: FAIL — `youtubeActionRequest` not exported.

- [ ] **Step 3: Add the helper and the dispatch branch**

In `flow/src/index.ts`, add and export this pure helper near the other module-level helpers (above `executeContentActions`):

```typescript
export function youtubeActionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  action: { operation?: string; playlistId?: string };
  channelId: string; contentId: string; flowId?: string | null;
  payload: Record<string, unknown>;
}): { url: string; body: string } {
  const { env, action, channelId, contentId, flowId, payload } = args;
  const videoId = String(payload?.source_content_id ?? "");
  const operation = action.operation || "save-to-playlist";
  if (operation === "rate-like") {
    return {
      url: `${env.LINK_URL}/internal/youtube/rate`,
      body: JSON.stringify({ channelId, contentId, videoId, flowId: flowId || null }),
    };
  }
  return {
    url: `${env.LINK_URL}/internal/youtube/playlist-insert`,
    body: JSON.stringify({ channelId, contentId, videoId, playlistId: action.playlistId || "", flowId: flowId || null }),
  };
}
```

Then add this branch inside `executeContentActions`, after the `tiktokContentAction` branch's closing brace (mirror the `xContentAction` bookmark tail exactly):

```typescript
    } else if (action.type === "youtubeContentAction") {
      const { url, body } = youtubeActionRequest({ env, action, channelId, contentId, flowId, payload });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body,
      });
      const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: "content_action_youtube", contentId, status: res.status, ok: respBody.ok, channelId, operation: action.operation || "save-to-playlist" }));

      if (respBody.rateLimited) {
        rateLimited.push({ action, retryAt: respBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = respBody.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
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
    }
```

Verify the exact variable names in scope (`rateLimited`, `resumeFromNode`, `emitContentNodeLogs`, `env.FLOW_DB`) match the surrounding `xContentAction` code and adjust if the local names differ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/dispatch-youtube-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the flow test suite (no regression)**

Run: `cd flow && npm test`
Expected: PASS (existing suite still green).

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/dispatch-youtube-action.test.ts
git commit -m "feat(flow): dispatch youtubeContentAction to link internal endpoints"
```

---

### Task 10: Node type registry entry

**Files:**
- Modify: `flow/nodeTypeRegistry.ts` (add import; add derived consts ~after line 85; add `youtubeContentAction` entry after `tiktokContentAction` ~line 221)
- Test: `flow/tests/unit/registry-youtube-action.test.ts` (Create)

**Interfaces:**
- Produces: `NODE_TYPE_REGISTRY.youtubeContentAction` with `reactFlowType:"action"`, `domain:"content"`, `role:"action"`, `generatable:true`, `label:"YouTube Action"`, operations derived from `ContentMetadata_YouTube` actions.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/registry-youtube-action.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

describe("youtubeContentAction registry entry", () => {
  it("is a content-domain action node", () => {
    const e = NODE_TYPE_REGISTRY.youtubeContentAction;
    expect(e).toBeTruthy();
    expect(e.reactFlowType).toBe("action");
    expect(e.domain).toBe("content");
    expect(e.role).toBe("action");
    expect(e.generatable).toBe(true);
    expect(e.label).toBe("YouTube Action");
  });

  it("prompt fragment lists both operations", () => {
    const f = NODE_TYPE_REGISTRY.youtubeContentAction.promptFragment || "";
    expect(f).toContain("save-to-playlist");
    expect(f).toContain("rate-like");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/registry-youtube-action.test.ts`
Expected: FAIL — `youtubeContentAction` undefined.

- [ ] **Step 3: Add the registry entry**

In `flow/nodeTypeRegistry.ts`:

1. Add the import at the top (next to the other metadata imports):

```typescript
import { ContentMetadata_YouTube } from "./metadata/youtube";
```

Note: the existing imports use `../metadata/...`. Match the real relative path used by the other two imports (`../metadata/x-byok`), i.e. `import { ContentMetadata_YouTube } from "../metadata/youtube";`.

2. Add derived consts after the TikTok derived consts (~after line 85):

```typescript
const CONTENT_YOUTUBE_ACTION_ENTRIES = ContentMetadata_YouTube.filter((m) => m.flowType === "action");
const CONTENT_YOUTUBE_ACTION_OPERATIONS = CONTENT_YOUTUBE_ACTION_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");
const CONTENT_YOUTUBE_ACTION_BULLETS = CONTENT_YOUTUBE_ACTION_ENTRIES.map((m) => `   - operation "${m.sourceContentType}": ${m.description!.en}`).join("\n");
```

3. Add the registry entry after the `tiktokContentAction` entry (~line 221):

```typescript
  youtubeContentAction: {
    reactFlowType: "action",
    label: "YouTube Action",
    description: `${CONTENT_YOUTUBE_ACTION_ENTRIES.length} actions`,
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For YouTube content actions: data: { actionType: "youtubeContentAction", operation: ${CONTENT_YOUTUBE_ACTION_OPERATIONS}, playlistId: "" }
   - Every operation acts via the triggering channel's own YouTube account — there is no target-account picker.
   - "save-to-playlist" needs playlistId (user picks a playlist in the Inspector); "rate-like" needs no additional fields.
${CONTENT_YOUTUBE_ACTION_BULLETS}`,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/registry-youtube-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/tests/unit/registry-youtube-action.test.ts
git commit -m "feat(flow): register youtubeContentAction node type"
```

---

### Task 11: Frontend — node init, Inspector, playlist API, sidebar, canvas label

**Files:**
- Modify: `flow/frontend/store/flow-editor.ts` (ACTION_TYPES ~line 45; node-init ~line 134-155)
- Modify: `flow/frontend/lib/api.ts` (add `youtubePlaylists` ~line 90)
- Modify: `flow/frontend/components/Inspector.tsx` (routing ~line 567; add `YouTubeContentActionInspector`)
- Modify: `flow/frontend/nodes/ActionNode.tsx` (add `youtubeContentAction` label branch)
- Modify: `flow/frontend/components/Sidebar.tsx` (add draggable in content-domain action list)
- Test: browser verification (this module has no React component test harness) + `flow/tests/unit/store-youtube-action.test.ts` (Create) for the node-init default data.

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY.youtubeContentAction` (Task 10), `GET /api/channels/youtube/playlists` (Task 7).
- Produces: draggable `youtubeContentAction` node whose default data is `{ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "", playlistTitle: "" }`; Inspector with operation selector + playlist dropdown.

- [ ] **Step 1: Write the failing store test**

Create `flow/tests/unit/store-youtube-action.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { useFlowEditor } from "../../frontend/store/flow-editor";

describe("addNode youtubeContentAction", () => {
  it("initializes default data", () => {
    useFlowEditor.getState().addNode("youtubeContentAction", { x: 0, y: 0 });
    const node = useFlowEditor.getState().nodes.find((n) => (n.data as any).actionType === "youtubeContentAction");
    expect(node).toBeTruthy();
    expect(node!.type).toBe("action");
    expect(node!.data).toMatchObject({ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "" });
  });
});
```

If the store cannot be imported in a node/vitest environment (browser-only deps), skip this test file and rely solely on browser verification in Step 6 — do not force a brittle harness. Confirm by attempting Step 2 first.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/store-youtube-action.test.ts`
Expected: FAIL — node not created (type not in `ACTION_TYPES`). (If it errors on import instead, delete this test file and note reliance on browser verification.)

- [ ] **Step 3: Store — register the action type and default data**

In `flow/frontend/store/flow-editor.ts`:

1. Add `"youtubeContentAction"` to the `ACTION_TYPES` array (~line 45):

```typescript
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "tiktokContentAction", "videoAction", "youtubeContentAction"];
```

2. Add a node-init branch inside the `ACTION_TYPES.includes(type)` block, after the `videoAction` branch (~line 152):

```typescript
      } else if (type === "youtubeContentAction") {
        data = { actionType: type, operation: "save-to-playlist", playlistId: "", playlistTitle: "" };
```

Do NOT add `youtubeContentAction` to `ACTION_CHANNEL_TYPE` — it acts via the triggering channel, like `xContentAction`.

- [ ] **Step 4: API client — add the playlists call**

In `flow/frontend/lib/api.ts`, add to the `channels` object (next to `youtubeSubscriptions`, ~line 90):

```typescript
    youtubePlaylists: () =>
      request<{ connected: boolean; needsReconnect?: boolean; playlists: { id: string; title: string }[] }>(
        `/api/channels/youtube/playlists`
      ),
```

- [ ] **Step 5: Inspector — operation selector + playlist dropdown**

In `flow/frontend/components/Inspector.tsx`:

1. Add derived operations near the other `CONTENT_*_OPERATIONS` consts (~line 651). `ContentMetadata_YouTube` is already imported at line 12:

```typescript
const CONTENT_YOUTUBE_ACTION_OPERATIONS = ContentMetadata_YouTube.filter((m) => m.flowType === "action");
```

2. Add routing after the `tiktokContentAction` route (~line 567):

```typescript
  if (actionType === "youtubeContentAction") {
    return <YouTubeContentActionInspector nodeId={nodeId} data={data} />;
  }
```

3. Add the component (place near `XContentActionInspector`):

```typescript
function YouTubeContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [playlists, setPlaylists] = useState<{ id: string; title: string }[]>([]);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const operation = (data.operation as string) || "save-to-playlist";

  useEffect(() => {
    if (operation !== "save-to-playlist") return;
    api.channels.youtubePlaylists()
      .then((res) => { setPlaylists(res.playlists); setNeedsReconnect(!!res.needsReconnect); })
      .catch(() => { setPlaylists([]); });
  }, [operation]);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentAction.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <OperationSelect
            value={operation}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={CONTENT_YOUTUBE_ACTION_OPERATIONS.map((op) => ({
              value: op.sourceContentType,
              label: op.label ? localizeLabel(op.label, "en") : op.sourceContentType,
              price: op.price,
            }))}
          />
        </div>
        {operation === "save-to-playlist" && (
          <div>
            <Label className="text-xs block mb-1">Playlist</Label>
            <Select
              value={data.playlistId || ""}
              onChange={(e: SelectChange) => {
                const id = e.target.value;
                const title = playlists.find((p) => p.id === id)?.title || "";
                updateNodeData(nodeId, { playlistId: id, playlistTitle: title });
              }}
              className="w-full text-sm"
            >
              <option value="">Select a playlist…</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </Select>
            {needsReconnect && (
              <p className="text-xs text-muted-foreground mt-1">
                Reconnect your YouTube account on the Social page to grant save/like permission.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

Ensure `useState`, `useEffect`, `Select`, `Label`, `OperationSelect`, `localizeLabel`, `api`, `SelectChange` are already imported in `Inspector.tsx` (they are used by the sibling inspectors — reuse the same imports).

- [ ] **Step 6: Canvas node label (ActionNode)**

In `flow/frontend/nodes/ActionNode.tsx`, add a branch in the `actionType` if/else chain, after the `tiktokContentAction` branch. Reuse the already-imported `YouTubeIcon` (used by Sidebar/other nodes) — add the import if missing:

```typescript
  } else if (actionType === "youtubeContentAction") {
    const operation = (data.operation as string) || "save-to-playlist";
    const selectedOperation = CONTENT_YOUTUBE_ACTION_OPERATIONS_NODE.find((op) => op.sourceContentType === operation);
    label = NODE_TYPE_REGISTRY.youtubeContentAction.label!;
    description = selectedOperation?.label ? localizeLabel(selectedOperation.label, "en") : undefined;
    icon = YouTubeIcon;
    isConfigured = operation === "rate-like" || (operation === "save-to-playlist" && !!data.playlistId);
  }
```

Add near the top of `ActionNode.tsx` (matching the file's existing `CONTENT_X_ACTION_OPERATIONS` derivation):

```typescript
import { ContentMetadata_YouTube } from "../../../metadata/youtube";
const CONTENT_YOUTUBE_ACTION_OPERATIONS_NODE = ContentMetadata_YouTube.filter((m) => m.flowType === "action");
```

(If `ActionNode.tsx` already imports `YouTubeIcon`, reuse it; otherwise add `import { YouTubeIcon } from "...";` matching the path used in `Sidebar.tsx`.)

- [ ] **Step 7: Sidebar draggable**

In `flow/frontend/components/Sidebar.tsx`, add to the content-domain action items (near the other content actions; only visible in content domain — mirror how `xContentTrigger`/`youtubeContentTrigger` use `visible(...)`):

```typescript
  if (visible("youtubeContentAction")) {
    actionItems.push({
      key: "youtubeContentAction",
      el: <DraggableItem key="youtubeContentAction" type="youtubeContentAction" label={NODE_TYPE_REGISTRY.youtubeContentAction.label!} description={NODE_TYPE_REGISTRY.youtubeContentAction.description!} color="border-accent bg-accent/50" icon={<YouTubeIcon className="w-4 h-4" />} />,
    });
  }
```

- [ ] **Step 8: Run store test (if kept)**

Run: `cd flow && npx vitest run tests/unit/store-youtube-action.test.ts`
Expected: PASS (or removed per Step 2 note).

- [ ] **Step 9: Build the frontend (typecheck)**

Run: `cd flow && npx vite build` (or the module's build script)
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 10: Browser verification (dev)**

Deploy flow + link to dev via local wrangler, then in the flow editor:
- Content-domain flow: sidebar shows "YouTube Action"; drag it onto the canvas.
- Inspector shows the Operation selector with "Save to Playlist" and "Like".
- With operation "Save to Playlist", the Playlist dropdown loads (for a reconnected YouTube account) or shows the reconnect hint.
- Node shows success/failed handles; canvas label reflects the selected operation; `isConfigured` turns true once a playlist is picked (save) or immediately (like).

- [ ] **Step 11: Commit**

```bash
git add flow/frontend/store/flow-editor.ts flow/frontend/lib/api.ts flow/frontend/components/Inspector.tsx flow/frontend/nodes/ActionNode.tsx flow/frontend/components/Sidebar.tsx flow/tests/unit/store-youtube-action.test.ts
git commit -m "feat(flow): youtubeContentAction node UI (sidebar, inspector, canvas)"
```

---

## Final verification

- [ ] Run the full link suite: `cd link && npm test` — expected PASS.
- [ ] Run the full flow suite: `cd flow && npm test` — expected PASS.
- [ ] Deploy `link` and `flow` to dev via local wrangler; reconnect a YouTube account (to obtain write scope + refresh token); build a content flow: `youtubeContentTrigger` → `youtubeContentAction` (save-to-playlist) and a second branch (rate-like); trigger with a real video; confirm the video appears in the chosen playlist and is liked on YouTube, and that `youtube_rate` / `youtube_playlist_insert` logs show `ok:true`.

## Self-Review (completed)

1. **Spec coverage:** OAuth scope/offline/refresh (Task 2), token refresh (Task 3), rate+playlist APIs and quotaExceeded→rateLimited (Task 4), quota monitor+alert (Task 5), internal endpoints (Task 6), playlists list API (Task 7), metadata (Task 1), engine map (Task 8), dispatch (Task 9), registry (Task 10), frontend incl. "只允许选已有" playlist dropdown and additive migration hint (Task 11). All spec sections mapped.
2. **Placeholder scan:** every code step contains full code; no TBD/TODO. Factory/function seams are confirmed against the codebase: `internalRoutes()` (link/src/routes-internal.ts), `channelsRoutes()` (link/src/routes-channels.ts), and `buildActionData(targetNode)` (flow/src/engine.ts, exported by Task 8).
3. **Type consistency:** `YouTubeTokenService.getValidToken/forceRefresh`, `rateVideo`/`insertPlaylistItem`/`YouTubeActionResult`, `recordYouTubeWriteQuota`, `youtubeActionRequest`, `ActionResult.playlistId`, `operation` values `"save-to-playlist"`/`"rate-like"`, and node data shape `{ actionType, operation, playlistId, playlistTitle }` are used identically across tasks.
