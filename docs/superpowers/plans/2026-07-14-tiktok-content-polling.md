# TikTok Content Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate TikTok content sync onto the metadata-driven content pipeline X posts already uses, polling hourly via `channel_poll_state`, and generalize per-channel poll invocation into one function shared by the cron loop and both platforms' OAuth callbacks.

**Architecture:** New `tiktok-content-api.ts` (TikTok video.list HTTP client) → `tiktok-content.ts` poller (backfill/incremental, mirroring `x-posts.ts`) → `poll-channel.ts`'s generic `pollChannelOnce(env, channelType, channelId)`, called from both `cron.ts`'s hourly loop and the OAuth callbacks (X BYOK and TikTok) right after seeding `channel_poll_state`.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (`LINK_DB`, per-tenant `TenantDataDB`), Vitest.

## Global Constraints

- TikTok API request: `POST https://open.tiktokapis.com/v2/video/list/`, body `{ max_count: 20, cursor }`, `fields` query param exactly: `id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count`.
- TikTok error detection is via `body.error.code`, not HTTP status alone: `"access_token_invalid"` → unauthorized (retry-once path), `"rate_limit_exceeded"` → rate-limited (stop cycle, resume next tick). These are best-effort assumptions — verify against real API responses during manual testing and adjust if TikTok's actual codes differ.
- `channel_poll_state.poller_name = 'content'` for TikTok (X uses `'followers'`/`'posts'`).
- `content` table: rename `impression_count` → `view_count`; add `share_count`, `cover_image_url`, `duration`, `height`, `width` (all `INTEGER` except `cover_image_url` which is `TEXT`).
- `ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X"` (`link/src/types.ts:66`, unchanged).
- Cron fires hourly (`crons = ["0 * * * *"]`, `link/wrangler.toml:87,156`). Existing budget constants in `cron.ts`: `PER_CHANNEL_BUDGET_MS = 20_000`, `TOTAL_BUDGET_MS = 50_000`, `REPOLL_INTERVAL_MS = 55 * 60 * 1000` — reused unchanged.
- `TikTokChannel`/`fetchItems()` (`link/src/channels/tiktok.ts`) and the manual `/tiktok/sync` route (`link/src/routes-channels.ts`) are out of scope — left untouched.

---

### Task 1: Metadata fixes — `content_type` VIDEO enum, `ContentMetadata_TikTok` rename, `CONTENT_COLUMN_MAP` fix

**Files:**
- Modify: `metadata/props.ts`
- Modify: `metadata/tiktok.ts`
- Modify: `metadata/index.ts`
- Modify: `link/src/services/content.ts`
- Test: `analytics/tests/unit/metadata-columns.test.ts` (extend)
- Test: `link/tests/services/content.test.ts` (extend)

**Interfaces:**
- Produces: `ContentMetadata_TikTok: ContentMetadata[]` (exported from `metadata/tiktok.ts` and re-exported from `metadata/index.ts`), consumed by Task 5's poller.
- Produces: `CONTENT_COLUMN_MAP` in `content.ts` now includes `view_count`, `share_count`, `cover_image_url`, `duration`, `height`, `width` — consumed by Task 5's `upsertContentFromMetadata` calls.

- [ ] **Step 1: Write the failing test for the VIDEO enum**

Add to `analytics/tests/unit/metadata-columns.test.ts` (new `it` inside the existing `describe("buildEntityColumns", ...)` block):

```ts
  it("content_type prop accepts VIDEO alongside TWEET/ARTICLE", () => {
    const contentTypeProp = PROPS.find((p) => p.propId === "content_type")!;
    const values = contentTypeProp.enums!.map((e) => e.value);
    expect(values).toContain("VIDEO");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd analytics && npx vitest run tests/unit/metadata-columns.test.ts`
Expected: FAIL — `values` is `["TWEET", "ARTICLE"]`, doesn't contain `"VIDEO"`.

- [ ] **Step 3: Add the VIDEO enum value**

In `metadata/props.ts`, find the `content_type` prop definition and change its `enums` array:

```ts
  {
    propId: "content_type",
    isInsight: true,
    dataType: "ENUM_TEXT",
    entity: ["content"],
    label: { en: "Content Type", zh: "内容类型" },
    enums: [
      { value: "TWEET", label: { en: "Tweet", zh: "推文" } },
      { value: "ARTICLE", label: { en: "Article", zh: "文章" } },
      { value: "VIDEO", label: { en: "Video", zh: "视频" } },
    ],
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd analytics && npx vitest run tests/unit/metadata-columns.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Rename `ContentMetadata_X` to `ContentMetadata_TikTok` in `metadata/tiktok.ts`**

Replace the full contents of `metadata/tiktok.ts` with:

```ts
// https://developers.tiktok.com/doc/tiktok-api-v2-video-list
import type { ContentMetadata } from "./dataTypes";

export const ContentMetadata_TikTok: ContentMetadata[] = [
  {
    sourceContentType: "video.list", // https://developers.tiktok.com/doc/tiktok-api-v2-video-list
    linkPrefix: "data.videos[]",
    contentProps: [
      { propId: "content_type", value: "VIDEO" },
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.create_time" },
      { propId: "cover_image_url", dataId: "{linkPrefix}.cover_image_url" },
      { propId: "content_text", dataId: "{linkPrefix}.video_description" },
      { propId: "duration", dataId: "{linkPrefix}.duration" },
      { propId: "height", dataId: "{linkPrefix}.height" },
      { propId: "width", dataId: "{linkPrefix}.width" },
      { propId: "title", dataId: "{linkPrefix}.title" },
      { propId: "like_count", dataId: "{linkPrefix}.like_count" },
      { propId: "reply_count", dataId: "{linkPrefix}.comment_count" },
      { propId: "share_count", dataId: "{linkPrefix}.share_count" },
      { propId: "view_count", dataId: "{linkPrefix}.view_count" },
    ],
  },
];
```

(This fixes the draft's stray `{linkPrefix}.article.cover_image_url` path — TikTok's `video.list` response has `cover_image_url` as a direct field on each video object, not nested under `article`.)

- [ ] **Step 6: Wire `ContentMetadata_TikTok` into the barrel export**

In `metadata/index.ts`, add a new export line alongside the existing X exports:

```ts
export { ContentMetadata_TikTok } from "./tiktok";
```

- [ ] **Step 7: Write the failing test for `CONTENT_COLUMN_MAP`**

Add to `link/tests/services/content.test.ts` (find the existing `describe` block for `upsertContentFromMetadata` or add a new one near the top of the file):

```ts
describe("CONTENT_COLUMN_MAP coverage", () => {
  it("maps view_count, share_count, cover_image_url, duration, height, width to matching columns", async () => {
    const tenantDb = {
      query: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    };
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.1]] }) };
    const vectorize = { upsert: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 1);

    await service.upsertContentFromMetadata(
      { id: "v1" },
      {
        source_content_id: "v1",
        content_type: "VIDEO",
        view_count: 100,
        share_count: 5,
        cover_image_url: "https://example.com/c.jpg",
        duration: 30,
        height: 1920,
        width: 1080,
      },
      "chan-1",
      "TIKTOK"
    );

    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall![0]).toContain("view_count");
    expect(insertCall![0]).toContain("share_count");
    expect(insertCall![0]).toContain("cover_image_url");
    expect(insertCall![0]).toContain("duration");
    expect(insertCall![0]).toContain("height");
    expect(insertCall![0]).toContain("width");
    expect(insertCall![0]).not.toContain("impression_count");
  });
});
```

Check the top of `link/tests/services/content.test.ts` for the existing `ContentService` import path and mock setup pattern (constructor arg shapes for `tenantDb`/`ai`/`vectorize`) and match it exactly — reuse whatever mock helpers already exist in that file rather than redefining them if equivalents are present.

- [ ] **Step 8: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: FAIL — generated SQL contains `impression_count`, not `view_count`/`share_count`/etc.

- [ ] **Step 9: Fix `CONTENT_COLUMN_MAP`**

In `link/src/services/content.ts`, replace the `CONTENT_COLUMN_MAP` definition:

```ts
const CONTENT_COLUMN_MAP: Record<string, string> = {
  content_type: "content_type",
  content_text: "content_text",
  title: "title",
  source_created_at: "source_created_at",
  bookmark_count: "bookmark_count",
  view_count: "view_count",
  like_count: "like_count",
  quote_count: "quote_count",
  reply_count: "reply_count",
  repost_count: "repost_count",
  share_count: "share_count",
  cover_image_url: "cover_image_url",
  duration: "duration",
  height: "height",
  width: "width",
};
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: PASS

- [ ] **Step 11: Run the full metadata/content-related test suites to check for regressions**

Run: `cd analytics && npx vitest run tests/unit/metadata-columns.test.ts tests/unit/metadata-entity.test.ts && cd ../link && npx vitest run tests/services/content.test.ts tests/services/x-posts.test.ts tests/services/x-users.test.ts`
Expected: All PASS

- [ ] **Step 12: Commit**

```bash
git add metadata/props.ts metadata/tiktok.ts metadata/index.ts link/src/services/content.ts analytics/tests/unit/metadata-columns.test.ts link/tests/services/content.test.ts
git commit -m "feat(metadata): add VIDEO content type, wire ContentMetadata_TikTok, fix view_count column map"
```

---

### Task 2: `content` table schema migration (dev, then prod)

**Files:**
- Modify: `admin/src/services/tenant-init-sql.ts`

**Interfaces:**
- Produces: `content` table columns `view_count` (renamed from `impression_count`), `share_count`, `cover_image_url`, `duration`, `height`, `width` — consumed by Task 1's `CONTENT_COLUMN_MAP` and Task 5's poller writes.

- [ ] **Step 1: Update the tenant-provisioning template for future tenants**

In `admin/src/services/tenant-init-sql.ts`, the `content` table `CREATE TABLE` (currently lines 52-74) changes `impression_count INTEGER` to `view_count INTEGER` and adds four new columns:

```ts
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    channel_type TEXT NOT NULL,
    content_type TEXT,
    source_content_id TEXT NOT NULL,
    title TEXT,
    content_text TEXT,
    summary TEXT,
    status TEXT DEFAULT 'new',
    source_url TEXT,
    source_updated_at TEXT,
    source_created_at TEXT,
    bookmark_count INTEGER,
    view_count INTEGER,
    like_count INTEGER,
    quote_count INTEGER,
    reply_count INTEGER,
    repost_count INTEGER,
    share_count INTEGER,
    cover_image_url TEXT,
    duration INTEGER,
    height INTEGER,
    width INTEGER,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
```

- [ ] **Step 2: Find the dev tenant's D1 database ID**

Run: `wrangler d1 execute uniscrm-web-dev --env dev --remote --command "SELECT tenant_id, d1_database_id FROM tenants WHERE d1_database_id IS NOT NULL"`
Expected: prints one or more rows with a `d1_database_id` column — note the dev tenant's UUID for the next step.

- [ ] **Step 3: Migrate the dev tenant's `content` table**

Run (substituting `<dev-tenant-db-id>` from Step 2):

```bash
wrangler d1 execute <dev-tenant-db-id> --remote --command "ALTER TABLE content RENAME COLUMN impression_count TO view_count; ALTER TABLE content ADD COLUMN share_count INTEGER; ALTER TABLE content ADD COLUMN cover_image_url TEXT; ALTER TABLE content ADD COLUMN duration INTEGER; ALTER TABLE content ADD COLUMN height INTEGER; ALTER TABLE content ADD COLUMN width INTEGER;"
```

Expected: six `"success": true` results (SQLite requires each `ALTER TABLE` as its own statement — if the CLI rejects the combined string, run each `ALTER TABLE` as a separate `--command`).

- [ ] **Step 4: Verify the dev migration**

Run: `wrangler d1 execute <dev-tenant-db-id> --remote --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='content'"`
Expected: output includes `view_count INTEGER`, `share_count INTEGER`, `cover_image_url TEXT`, `duration INTEGER`, `height INTEGER`, `width INTEGER`, and does NOT include `impression_count`.

- [ ] **Step 5: Migrate production tenant 1's `content` table**

This modifies production. Ask the user to explicitly confirm before running, naming the exact target (production D1 `f5f49e47-d779-49a0-b609-f2b2ab5fd09f`, tenant 1's `content` table) — do not proceed on an ambiguous "yes" (see prior session precedent: a bare "yes" to a previously-blocked production action is insufficient; the user's own message must name the specific database/table/action).

Once confirmed, run:

```bash
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content RENAME COLUMN impression_count TO view_count;"
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content ADD COLUMN share_count INTEGER;"
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content ADD COLUMN cover_image_url TEXT;"
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content ADD COLUMN duration INTEGER;"
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content ADD COLUMN height INTEGER;"
wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "ALTER TABLE content ADD COLUMN width INTEGER;"
```

Expected: six `"success": true` results.

- [ ] **Step 6: Verify the production migration**

Run: `wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='content'"`
Expected: same shape as Step 4's verification — `view_count`, `share_count`, `cover_image_url`, `duration`, `height`, `width` present, `impression_count` absent.

Also run: `wrangler d1 execute f5f49e47-d779-49a0-b609-f2b2ab5fd09f --remote --command "SELECT COUNT(*) AS cnt, COUNT(view_count) AS with_view_count FROM content"`
Expected: `with_view_count` equals the count of rows that previously had `impression_count` populated (data preserved by the rename, not dropped).

- [ ] **Step 7: Commit**

```bash
git add admin/src/services/tenant-init-sql.ts
git commit -m "feat(admin): rename content.impression_count to view_count, add TikTok video columns to tenant provisioning template"
```

---

### Task 3: TikTok API client (`tiktok-content-api.ts`) + error type

**Files:**
- Create: `link/src/services/tiktok-errors.ts`
- Create: `link/src/services/tiktok-content-api.ts`
- Test: `link/tests/services/tiktok-content-api.test.ts`

**Interfaces:**
- Produces: `TikTokUnauthorizedError` (class, extends `Error`), `fetchVideoListPage(accessToken: string, cursor?: number): Promise<TikTokVideoFetchResult>`, `TikTokVideoPage { data: Record<string, unknown>[]; nextCursor?: number; hasMore: boolean }`, `TikTokVideoFetchResult { page: TikTokVideoPage; rateLimited: boolean }` — consumed by Task 5's poller.

- [ ] **Step 1: Create the error type**

`link/src/services/tiktok-errors.ts`:

```ts
// Thrown by TikTok API client functions (fetchVideoListPage) when TikTok reports
// body.error.code === "access_token_invalid", distinct from generic failures so
// callers can force a token refresh and retry once instead of just logging and
// giving up for the tick. Mirrors XUnauthorizedError (x-errors.ts).
export class TikTokUnauthorizedError extends Error {}
```

- [ ] **Step 2: Write the failing tests**

`link/tests/services/tiktok-content-api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchVideoListPage } from "../../src/services/tiktok-content-api";
import { TikTokUnauthorizedError } from "../../src/services/tiktok-errors";

describe("fetchVideoListPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the full field list and passes cursor/max_count in the body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok" } }), { status: 200 })
    );

    await fetchVideoListPage("tok", 42);

    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string)).toContain("open.tiktokapis.com/v2/video/list/");
    expect((url as string)).toContain("fields=");
    const calledUrl = new URL(url as string);
    expect(calledUrl.searchParams.get("fields")).toBe(
      "id,video_description,create_time,cover_image_url,duration,height,width,title,like_count,comment_count,share_count,view_count"
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ max_count: 20, cursor: 42 });
  });

  it("omits cursor from the body when not provided", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { videos: [], cursor: 0, has_more: false }, error: { code: "ok" } }), { status: 200 })
    );

    await fetchVideoListPage("tok");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ max_count: 20 });
  });

  it("parses videos, nextCursor, and hasMore from a successful response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: { videos: [{ id: "v1", title: "t1" }], cursor: 100, has_more: true }, error: { code: "ok" } }),
        { status: 200 }
      )
    );

    const result = await fetchVideoListPage("tok");

    expect(result.rateLimited).toBe(false);
    expect(result.page.data).toEqual([{ id: "v1", title: "t1" }]);
    expect(result.page.nextCursor).toBe(100);
    expect(result.page.hasMore).toBe(true);
  });

  it("returns rateLimited:true when error.code is rate_limit_exceeded", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "too many requests" } }), { status: 200 })
    );

    const result = await fetchVideoListPage("tok");

    expect(result.rateLimited).toBe(true);
    expect(result.page.data).toEqual([]);
  });

  it("throws TikTokUnauthorizedError when error.code is access_token_invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "access_token_invalid", message: "expired" } }), { status: 200 })
    );

    await expect(fetchVideoListPage("tok")).rejects.toThrow(TikTokUnauthorizedError);
  });

  it("throws a generic error on other failures", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(fetchVideoListPage("tok")).rejects.toThrow("TikTok video.list failed");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/tiktok-content-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/tiktok-content-api'`

- [ ] **Step 4: Implement `fetchVideoListPage`**

`link/src/services/tiktok-content-api.ts`:

```ts
import { TikTokUnauthorizedError } from "./tiktok-errors";

// https://developers.tiktok.com/doc/tiktok-api-v2-video-list
const VIDEO_FIELDS = [
  "id",
  "video_description",
  "create_time",
  "cover_image_url",
  "duration",
  "height",
  "width",
  "title",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
].join(",");

export interface TikTokVideoPage {
  data: Record<string, unknown>[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface TikTokVideoFetchResult {
  page: TikTokVideoPage;
  rateLimited: boolean;
}

export async function fetchVideoListPage(
  accessToken: string,
  cursor?: number
): Promise<TikTokVideoFetchResult> {
  const url = new URL("https://open.tiktokapis.com/v2/video/list/");
  url.searchParams.set("fields", VIDEO_FIELDS);

  const body: Record<string, unknown> = { max_count: 20 };
  if (cursor !== undefined) body.cursor = cursor;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`TikTok video.list failed: ${res.status} ${await res.text()}`);
  }

  const responseBody = (await res.json()) as {
    data?: { videos?: Record<string, unknown>[]; cursor?: number; has_more?: boolean };
    error?: { code: string; message: string };
  };

  const errorCode = responseBody.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { page: { data: [], hasMore: false }, rateLimited: true };
  }
  if (errorCode === "access_token_invalid") {
    throw new TikTokUnauthorizedError(`TikTok video.list failed: ${errorCode} ${responseBody.error?.message ?? ""}`);
  }
  if (errorCode && errorCode !== "ok") {
    throw new Error(`TikTok video.list failed: ${errorCode} ${responseBody.error?.message ?? ""}`);
  }

  return {
    page: {
      data: responseBody.data?.videos || [],
      nextCursor: responseBody.data?.cursor,
      hasMore: responseBody.data?.has_more || false,
    },
    rateLimited: false,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/tiktok-content-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add link/src/services/tiktok-errors.ts link/src/services/tiktok-content-api.ts link/tests/services/tiktok-content-api.test.ts
git commit -m "feat(link): add TikTok video.list API client with error-code-based rate-limit/auth detection"
```

---

### Task 4: `TikTokTokenService`

**Files:**
- Create: `link/src/services/tiktok-token.ts`
- Modify: `link/src/cron.ts` (TikTok section of `handleTokenRefresh`)
- Test: `link/tests/services/tiktok-token.test.ts`

**Interfaces:**
- Consumes: `Env` (`link/src/types.ts`, has `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`)
- Produces: `TikTokTokenService` class with `refreshAccessToken(channelId: string): Promise<string>` and `getValidToken(channelId: string): Promise<string>` — consumed by Task 6's `poll-channel.ts`.

- [ ] **Step 1: Write the failing tests**

`link/tests/services/tiktok-token.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TikTokTokenService } from "../../src/services/tiktok-token";

function createMockDb(config: Record<string, unknown>) {
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue({ config: JSON.stringify(config) }),
      run,
    }),
  }));
  return { prepare, run };
}

describe("TikTokTokenService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshAccessToken exchanges the refresh_token and persists the new tokens", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-tok", refresh_token: "new-refresh", expires_in: 86400 }), { status: 200 })
    );
    const db = createMockDb({ refresh_token: "old-refresh", access_token: "old-tok" });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.refreshAccessToken("chan-1");

    expect(token).toBe("new-tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    const body = new URLSearchParams((init as RequestInit).body as string);
    expect(body.get("client_key")).toBe("client-key");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(db.run).toHaveBeenCalled();
  });

  it("getValidToken returns the existing token when not near expiry", async () => {
    const db = createMockDb({
      access_token: "still-good",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("still-good");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getValidToken proactively refreshes when expiring within 10 minutes", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "refreshed", expires_in: 86400 }), { status: 200 })
    );
    const db = createMockDb({
      access_token: "expiring-soon",
      refresh_token: "r",
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const service = new TikTokTokenService(db as any, "client-key", "client-secret");

    const token = await service.getValidToken("chan-1");

    expect(token).toBe("refreshed");
    expect(fetchMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/tiktok-token.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/tiktok-token'`

- [ ] **Step 3: Implement `TikTokTokenService`**

`link/src/services/tiktok-token.ts`:

```ts
export interface TikTokChannelConfig {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
}

export class TikTokTokenService {
  constructor(
    private db: D1Database,
    private clientKey: string,
    private clientSecret: string
  ) {}

  async refreshAccessToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");

    const config = JSON.parse(row.config) as TikTokChannelConfig;
    if (!config.refresh_token) throw new Error("No refresh token available");

    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        grant_type: "refresh_token",
        refresh_token: config.refresh_token,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TikTok token refresh failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };

    config.access_token = data.access_token;
    if (data.refresh_token) config.refresh_token = data.refresh_token;
    if (data.expires_in) config.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await this.db
      .prepare(`UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(config), channelId)
      .run();

    return data.access_token;
  }

  async getValidToken(channelId: string): Promise<string> {
    const row = await this.db
      .prepare(`SELECT config FROM channels WHERE id = ?`)
      .bind(channelId)
      .first<{ config: string }>();

    if (!row) throw new Error("Channel not found");

    const config = JSON.parse(row.config) as TikTokChannelConfig;

    if (config.expires_at) {
      const expiresAt = new Date(config.expires_at).getTime();
      const tenMinutes = 10 * 60 * 1000;
      if (Date.now() > expiresAt - tenMinutes) {
        return this.refreshAccessToken(channelId);
      }
    }

    return config.access_token;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/tiktok-token.test.ts`
Expected: PASS

- [ ] **Step 5: Replace `handleTokenRefresh`'s inline TikTok refresh logic with `TikTokTokenService`**

In `link/src/cron.ts`, add the import near the top (alongside the existing `XTokenService` import at line 10):

```ts
import { TikTokTokenService } from "./services/tiktok-token";
```

Replace the TikTok token refresh block (currently `cron.ts:129-172`) with:

```ts
  // TikTok token refresh
  const tiktokChannels = await env.LINK_DB
    .prepare("SELECT id, config FROM channels WHERE channel_type = 'TIKTOK' AND is_active = 1")
    .all<{ id: string; config: string }>();

  const tiktokTokenService = new TikTokTokenService(env.LINK_DB, env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET);

  for (const row of tiktokChannels.results) {
    const config = JSON.parse(row.config) as { refresh_token?: string; expires_at?: string };
    if (!config.refresh_token) continue;

    const shouldRefresh = !config.expires_at ||
      Date.now() > new Date(config.expires_at).getTime() - 30 * 60 * 1000;
    if (!shouldRefresh) continue;

    try {
      await tiktokTokenService.refreshAccessToken(row.id);
      console.log(JSON.stringify({ event: "tiktok_token_refreshed", channel_id: row.id }));
    } catch (e) {
      console.error(`TikTok token refresh error for ${row.id}:`, e);
    }
  }
```

- [ ] **Step 6: Run the full link test suite to check for regressions**

Run: `cd link && npx vitest run`
Expected: All PASS (this step only changed `cron.ts`'s `handleTokenRefresh`, which has no direct existing unit test per the current suite — `cron-polling.test.ts` only covers `handlePolling` — so no test should need updating here)

- [ ] **Step 7: Commit**

```bash
git add link/src/services/tiktok-token.ts link/src/cron.ts link/tests/services/tiktok-token.test.ts
git commit -m "feat(link): add TikTokTokenService, replace inline TikTok token refresh in cron.ts"
```

---

### Task 5: TikTok content poller (`tiktok-content.ts`)

**Files:**
- Create: `link/src/services/pollers/tiktok-content.ts`
- Test: `link/tests/services/pollers/tiktok-content.test.ts`

**Interfaces:**
- Consumes: `fetchVideoListPage` (Task 3), `resolveProps` (`link/src/services/pollers/resolve-props.ts`, unchanged), `ContentMetadata_TikTok` (Task 1), `ContentService.upsertContentFromMetadata` (unchanged, `link/src/services/content.ts`)
- Produces: `runTikTokContentPoller(ctx: TikTokContentPollerContext): Promise<void>` — consumed by Task 6's `poll-channel.ts`.

- [ ] **Step 1: Write the failing tests**

Create the `link/tests/services/pollers/` directory (new — the first poller test needing its own subdirectory grouping) and `link/tests/services/pollers/tiktok-content.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchVideoListPageMock = vi.fn();
const upsertContentFromMetadataMock = vi.fn();

vi.mock("../../../src/services/tiktok-content-api", () => ({
  fetchVideoListPage: (...args: unknown[]) => fetchVideoListPageMock(...args),
}));

vi.mock("../../../src/services/content", () => ({
  ContentService: class {
    upsertContentFromMetadata(...args: unknown[]) {
      return upsertContentFromMetadataMock(...args);
    }
  },
}));

import { runTikTokContentPoller } from "../../../src/services/pollers/tiktok-content";

function createMockLinkDb(pollState: Record<string, unknown> | null) {
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(pollState),
      run,
    }),
  }));
  return { prepare, run };
}

describe("runTikTokContentPoller", () => {
  beforeEach(() => {
    fetchVideoListPageMock.mockReset();
    upsertContentFromMetadataMock.mockReset().mockResolvedValue(true);
  });

  it("does nothing when channel_poll_state has no seeded row", async () => {
    const linkDb = createMockLinkDb(null);

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).not.toHaveBeenCalled();
  });

  it("backfill: pages via cursor until has_more is false, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    fetchVideoListPageMock
      .mockResolvedValueOnce({ page: { data: [{ id: "v1" }], nextCursor: 10, hasMore: true }, rateLimited: false })
      .mockResolvedValueOnce({ page: { data: [{ id: "v2" }], nextCursor: undefined, hasMore: false }, rateLimited: false });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).toHaveBeenCalledTimes(2);
    expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(2);
    const completeCall = linkDb.run.mock.calls.find((c: unknown[]) => true);
    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("backfill_complete = 1"))).toBe(true);
  });

  it("incremental: stops after a page produces zero new videos", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-01-01T00:00:00Z" });
    upsertContentFromMetadataMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    fetchVideoListPageMock.mockResolvedValueOnce({
      page: { data: [{ id: "v1" }, { id: "v2" }], nextCursor: 5, hasMore: true },
      rateLimited: false,
    });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(fetchVideoListPageMock).toHaveBeenCalledTimes(1);
    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("last_polled_at = datetime"))).toBe(true);
  });

  it("stops backfill without setting backfill_complete when rate limited", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    fetchVideoListPageMock.mockResolvedValueOnce({ page: { data: [], hasMore: false }, rateLimited: true });

    await runTikTokContentPoller({
      channelId: "chan-1",
      accessToken: "tok",
      linkDb: linkDb as any,
      tenantDb: {} as any,
      tenantId: 1,
      ai: {} as any,
      vectorize: {} as any,
      deadline: Date.now() + 20_000,
    });

    expect(linkDb.prepare.mock.calls.some((c: unknown[]) => (c[0] as string).includes("backfill_complete = 1"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/pollers/tiktok-content.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/pollers/tiktok-content'`

- [ ] **Step 3: Implement `runTikTokContentPoller`**

`link/src/services/pollers/tiktok-content.ts`:

```ts
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { ContentService } from "../content";
import { fetchVideoListPage } from "../tiktok-content-api";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_TikTok } from "../../../../metadata/tiktok";

const VIDEO_METADATA = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video.list")!;

export interface TikTokContentPollerContext {
  channelId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  pipelineContent?: Pipeline;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runTikTokContentPoller(ctx: TikTokContentPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'content'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state || Object.keys(state).length === 0) {
    console.log(JSON.stringify({ event: "tiktok_content_poll_skipped_not_seeded", channel_id: ctx.channelId }));
    return;
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent);
  const phase = state.backfill_complete ? "incremental" : "backfill";
  console.log(JSON.stringify({ event: "tiktok_content_poll_started", channel_id: ctx.channelId, phase, cursor: state.cursor }));

  if (!state.backfill_complete) {
    await runBackfill(ctx, contentService, state.cursor ? Number(state.cursor) : undefined);
  } else {
    await runIncrementalPoll(ctx, contentService);
  }
}

async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  channelId: string
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, VIDEO_METADATA.contentProps, VIDEO_METADATA.linkPrefix);
    const isNew = await contentService.upsertContentFromMetadata(item, props, channelId, "TIKTOK");
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: TikTokContentPollerContext,
  contentService: ContentService,
  startCursor: number | undefined
): Promise<void> {
  let cursor = startCursor;
  let pagesFetched = 0;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchVideoListPage(ctx.accessToken, cursor);
    if (rateLimited) {
      console.log(JSON.stringify({ event: "tiktok_content_poll_rate_limited", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
      return;
    }

    pagesFetched++;
    await upsertPage(contentService, page.data, ctx.channelId);

    if (!page.hasMore) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'"
        )
        .bind(ctx.channelId)
        .run();
      console.log(JSON.stringify({ event: "tiktok_content_poll_backfill_complete", channel_id: ctx.channelId, pagesFetched }));
      return;
    }

    cursor = page.nextCursor;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'")
      .bind(String(cursor ?? ""), ctx.channelId)
      .run();
  }

  console.log(JSON.stringify({ event: "tiktok_content_poll_deadline_reached", channel_id: ctx.channelId, phase: "backfill", pagesFetched }));
}

async function runIncrementalPoll(ctx: TikTokContentPollerContext, contentService: ContentService): Promise<void> {
  let cursor: number | undefined;
  let pagesFetched = 0;
  let totalNew = 0;
  let stopReason: "rate_limited" | "no_new_content" | "no_next_page" | "deadline" = "deadline";

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchVideoListPage(ctx.accessToken, cursor);
    if (rateLimited) { stopReason = "rate_limited"; break; }

    pagesFetched++;
    const newCount = await upsertPage(contentService, page.data, ctx.channelId);
    totalNew += newCount;

    if (newCount === 0) { stopReason = "no_new_content"; break; }
    if (!page.hasMore) { stopReason = "no_next_page"; break; }
    cursor = page.nextCursor;
  }

  console.log(JSON.stringify({ event: "tiktok_content_poll_incremental_complete", channel_id: ctx.channelId, pagesFetched, totalNew, stopReason }));

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'content'")
    .bind(ctx.channelId)
    .run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/pollers/tiktok-content.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add link/src/services/pollers/tiktok-content.ts link/tests/services/pollers/tiktok-content.test.ts
git commit -m "feat(link): add TikTok content poller (backfill/incremental via channel_poll_state)"
```

---

### Task 6: Generic `pollChannelOnce` + `cron.ts` refactor

**Files:**
- Create: `link/src/services/pollers/poll-channel.ts`
- Modify: `link/src/cron.ts`
- Test: `link/tests/services/pollers/poll-channel.test.ts`
- Test: `link/tests/services/cron-polling.test.ts` (extend/adjust for the new combined query and delegation)

**Interfaces:**
- Consumes: `runFollowersPoller`, `runPostsPoller` (existing), `runTikTokContentPoller` (Task 5), `getAppCredentials`/`XTokenService` (existing), `TikTokTokenService` (Task 4), `XUnauthorizedError`/`TikTokUnauthorizedError`
- Produces: `pollChannelOnce(env: Env, channelType: "X" | "TIKTOK", channelId: string): Promise<void>` — consumed by Task 7's OAuth callbacks and by `cron.ts`'s `handlePolling`.

- [ ] **Step 1: Write the failing tests**

`link/tests/services/pollers/poll-channel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { XUnauthorizedError } from "../../../src/services/x-errors";
import { TikTokUnauthorizedError } from "../../../src/services/tiktok-errors";

const runFollowersPollerMock = vi.fn().mockResolvedValue(undefined);
const runPostsPollerMock = vi.fn().mockResolvedValue(undefined);
const runTikTokContentPollerMock = vi.fn().mockResolvedValue(undefined);
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csecret" });
const getValidTokenMock = vi.fn().mockResolvedValue("tok");
const refreshAccessTokenMock = vi.fn().mockResolvedValue("refreshed-tok");
const tiktokGetValidTokenMock = vi.fn().mockResolvedValue("tt-tok");
const tiktokRefreshAccessTokenMock = vi.fn().mockResolvedValue("tt-refreshed-tok");

vi.mock("../../../src/services/pollers/x-followers", () => ({
  runFollowersPoller: (...args: unknown[]) => runFollowersPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/x-posts", () => ({
  runPostsPoller: (...args: unknown[]) => runPostsPollerMock(...args),
}));
vi.mock("../../../src/services/pollers/tiktok-content", () => ({
  runTikTokContentPoller: (...args: unknown[]) => runTikTokContentPollerMock(...args),
}));
vi.mock("../../../src/services/app-credentials", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
}));
vi.mock("../../../src/services/x-token", () => ({
  XTokenService: class {
    getValidToken(...args: unknown[]) { return getValidTokenMock(...args); }
    refreshAccessToken(...args: unknown[]) { return refreshAccessTokenMock(...args); }
  },
}));
vi.mock("../../../src/services/tiktok-token", () => ({
  TikTokTokenService: class {
    getValidToken(...args: unknown[]) { return tiktokGetValidTokenMock(...args); }
    refreshAccessToken(...args: unknown[]) { return tiktokRefreshAccessTokenMock(...args); }
  },
}));
vi.mock("../../../../shared/tenant-data-db", () => ({ TenantDataDB: class {} }));

import { pollChannelOnce } from "../../../src/services/pollers/poll-channel";

function baseEnv(linkDb: unknown, webDb: unknown) {
  return {
    LINK_DB: linkDb,
    WEB_DB: webDb,
    CF_ACCOUNT_ID: "acct",
    CF_D1_API_TOKEN: "token",
    TIKTOK_CLIENT_KEY: "tt-key",
    TIKTOK_CLIENT_SECRET: "tt-secret",
    PIPELINE_USER: undefined,
    PIPELINE_CONTENT: undefined,
    AI: {},
    VECTORIZE: {},
  } as any;
}

function mockWebDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ d1_database_id: "tenant-db-id" }) }),
    }),
  };
}

describe("pollChannelOnce", () => {
  beforeEach(() => {
    runFollowersPollerMock.mockClear().mockResolvedValue(undefined);
    runPostsPollerMock.mockClear().mockResolvedValue(undefined);
    runTikTokContentPollerMock.mockClear().mockResolvedValue(undefined);
    getAppCredentialsMock.mockClear();
    getValidTokenMock.mockClear().mockResolvedValue("tok");
    refreshAccessTokenMock.mockClear().mockResolvedValue("refreshed-tok");
    tiktokGetValidTokenMock.mockClear().mockResolvedValue("tt-tok");
    tiktokRefreshAccessTokenMock.mockClear().mockResolvedValue("tt-refreshed-tok");
  });

  it("X: skips non-BYOK channels", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "chan-1",
            tenant_id: 1,
            config: JSON.stringify({ is_byok: false, x_user_id: "u1" }),
          }),
        }),
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runFollowersPollerMock).not.toHaveBeenCalled();
    expect(runPostsPollerMock).not.toHaveBeenCalled();
  });

  it("X: BYOK channel with seeded poll state runs both followers and posts", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-1", tenant_id: 1, config: JSON.stringify({ is_byok: true, x_user_id: "u1" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "X", "chan-1");
    expect(runFollowersPollerMock).toHaveBeenCalledTimes(1);
    expect(runPostsPollerMock).toHaveBeenCalledTimes(1);
  });

  it("TIKTOK: no BYOK gate — runs content poller for any active channel with seeded poll state", async () => {
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-tt", tenant_id: 1, config: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "TIKTOK", "chan-tt");
    expect(runTikTokContentPollerMock).toHaveBeenCalledTimes(1);
    expect(runTikTokContentPollerMock.mock.calls[0][0]).toMatchObject({ channelId: "chan-tt", accessToken: "tt-tok" });
  });

  it("TIKTOK: force-refreshes and retries once on TikTokUnauthorizedError", async () => {
    runTikTokContentPollerMock
      .mockRejectedValueOnce(new TikTokUnauthorizedError("expired"))
      .mockResolvedValueOnce(undefined);
    const linkDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("FROM channels")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            id: "chan-tt", tenant_id: 1, config: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ backfill_complete: 0, last_polled_at: null }) }) };
      }),
    };
    await pollChannelOnce(baseEnv(linkDb, mockWebDb()), "TIKTOK", "chan-tt");
    expect(tiktokRefreshAccessTokenMock).toHaveBeenCalledWith("chan-tt");
    expect(runTikTokContentPollerMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/pollers/poll-channel.test.ts`
Expected: FAIL — `Cannot find module '../../../src/services/pollers/poll-channel'`

- [ ] **Step 3: Implement `pollChannelOnce`**

`link/src/services/pollers/poll-channel.ts`:

```ts
import type { Env, ChannelType } from "../../types";
import { getAppCredentials, type ByokConfig } from "../app-credentials";
import { XTokenService } from "../x-token";
import { TikTokTokenService } from "../tiktok-token";
import { XUnauthorizedError } from "../x-errors";
import { TikTokUnauthorizedError } from "../tiktok-errors";
import { runFollowersPoller } from "./x-followers";
import { runPostsPoller } from "./x-posts";
import { runTikTokContentPoller } from "./tiktok-content";
import { TenantDataDB } from "../../../../shared/tenant-data-db";

const PER_CHANNEL_BUDGET_MS = 20_000;
const REPOLL_INTERVAL_MS = 55 * 60 * 1000;

async function shouldPoll(env: Env, channelId: string, pollerName: string): Promise<boolean> {
  const state = await env.LINK_DB
    .prepare("SELECT backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = ?")
    .bind(channelId, pollerName)
    .first<{ backfill_complete: number; last_polled_at: string | null }>();
  if (!state) {
    console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_no_state_row`, channel_id: channelId }));
    return false;
  }
  if (state.backfill_complete && state.last_polled_at) {
    const elapsedMs = Date.now() - new Date(state.last_polled_at).getTime();
    if (elapsedMs < REPOLL_INTERVAL_MS) {
      console.log(JSON.stringify({ event: `${pollerName}_poll_skipped_too_recent`, channel_id: channelId, elapsedMs }));
      return false;
    }
  }
  return true;
}

async function resolveTenantDb(env: Env, tenantId: number): Promise<TenantDataDB | null> {
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return null;
  return new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
}

export async function pollChannelOnce(env: Env, channelType: ChannelType, channelId: string): Promise<void> {
  const row = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = ? AND id = ? AND is_active = 1")
    .bind(channelType, channelId)
    .first<{ id: string; config: string; tenant_id: number | null }>();
  if (!row) return;

  if (channelType === "X") {
    await pollXChannel(env, row);
  } else if (channelType === "TIKTOK") {
    await pollTikTokChannel(env, row);
  }
}

async function pollXChannel(env: Env, row: { id: string; config: string; tenant_id: number | null }): Promise<void> {
  const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
  if (!config.is_byok) return;
  if (!config.x_user_id || !row.tenant_id) return;

  const pollFollowers = await shouldPoll(env, row.id, "followers");
  const pollPosts = await shouldPoll(env, row.id, "posts");
  if (!pollFollowers && !pollPosts) return;

  let accessToken: string;
  let tenantDb: import("../../../../shared/tenant-data-db").TenantDataDB;
  let tokenService: XTokenService;
  try {
    const creds = await getAppCredentials(env, config);
    tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
    accessToken = await tokenService.getValidToken(row.id);

    const db = await resolveTenantDb(env, row.tenant_id!);
    if (!db) return;
    tenantDb = db;
  } catch (e) {
    console.error(JSON.stringify({ event: "poll_setup_error", channel_id: row.id, error: String(e) }));
    return;
  }

  if (pollFollowers) {
    try {
      try {
        await runFollowersPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          pipelineUser: env.PIPELINE_USER, deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      } catch (e) {
        if (!(e instanceof XUnauthorizedError)) throw e;
        accessToken = await tokenService.refreshAccessToken(row.id);
        await runFollowersPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          pipelineUser: env.PIPELINE_USER, deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "followers_poll_error", channel_id: row.id, error: String(e) }));
    }
  }

  if (pollPosts) {
    try {
      try {
        await runPostsPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT,
          deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      } catch (e) {
        if (!(e instanceof XUnauthorizedError)) throw e;
        accessToken = await tokenService.refreshAccessToken(row.id);
        await runPostsPoller({
          channelId: row.id, xUserId: config.x_user_id, accessToken,
          linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id!,
          ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT,
          deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
        });
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "posts_poll_error", channel_id: row.id, error: String(e) }));
    }
  }
}

async function pollTikTokChannel(env: Env, row: { id: string; config: string; tenant_id: number | null }): Promise<void> {
  if (!row.tenant_id) return;

  const pollContent = await shouldPoll(env, row.id, "content");
  if (!pollContent) return;

  let accessToken: string;
  let tenantDb: import("../../../../shared/tenant-data-db").TenantDataDB;
  const tokenService = new TikTokTokenService(env.LINK_DB, env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET);
  try {
    accessToken = await tokenService.getValidToken(row.id);
    const db = await resolveTenantDb(env, row.tenant_id);
    if (!db) return;
    tenantDb = db;
  } catch (e) {
    console.error(JSON.stringify({ event: "poll_setup_error", channel_id: row.id, error: String(e) }));
    return;
  }

  try {
    try {
      await runTikTokContentPoller({
        channelId: row.id, accessToken, linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    } catch (e) {
      if (!(e instanceof TikTokUnauthorizedError)) throw e;
      accessToken = await tokenService.refreshAccessToken(row.id);
      await runTikTokContentPoller({
        channelId: row.id, accessToken, linkDb: env.LINK_DB, tenantDb, tenantId: row.tenant_id,
        ai: env.AI, vectorize: env.VECTORIZE, pipelineContent: env.PIPELINE_CONTENT,
        deadline: Date.now() + PER_CHANNEL_BUDGET_MS,
      });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "tiktok_content_poll_error", channel_id: row.id, error: String(e) }));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/pollers/poll-channel.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor `cron.ts`'s `handlePolling` to delegate to `pollChannelOnce`**

Replace the entire `handlePolling` function body in `link/src/cron.ts` (currently lines 175-328) with:

```ts
export async function handlePolling(env: Env): Promise<void> {
  const TOTAL_BUDGET_MS = 50_000;
  const runDeadline = Date.now() + TOTAL_BUDGET_MS;

  const rows = await env.LINK_DB
    .prepare("SELECT id, channel_type FROM channels WHERE channel_type IN ('X', 'TIKTOK') AND is_active = 1")
    .all<{ id: string; channel_type: "X" | "TIKTOK" }>();

  console.log(JSON.stringify({ event: "polling_cron_started", candidateChannels: rows.results.length }));

  for (const row of rows.results) {
    if (Date.now() >= runDeadline) {
      console.log(JSON.stringify({ event: "polling_cron_budget_exhausted", channel_id: row.id }));
      break;
    }
    await pollChannelOnce(env, row.channel_type, row.id);
  }
}
```

Replace the import block at the top of `link/src/cron.ts` (currently lines 1-16, as left by Task 4 Step 5) with:

```ts
import type { Env } from "./types";
import type { TrendSource } from "./trend/sources/interface";
import { getTwitterConfig, getTikTokConfig, getDouyinConfig } from "./trend/config";
import { TwitterTrendSource } from "./trend/sources/twitter";
import { TikTokTrendSource } from "./trend/sources/tiktok";
import { DouyinTrendSource } from "./trend/sources/douyin";
import { Aggregator } from "./trend/aggregator";
import { TrendCache } from "./trend/storage/cache";
import { TrendVectorStore } from "./trend/storage/vectorize";
import { XTokenService } from "./services/x-token";
import { XActivityService } from "./services/x-webhook";
import { getAppCredentials, type ByokConfig } from "./services/app-credentials";
import { TikTokTokenService } from "./services/tiktok-token";
import { pollChannelOnce } from "./services/pollers/poll-channel";
```

This drops `runFollowersPoller`, `runPostsPoller`, `XUnauthorizedError`, and `TenantDataDB` (only `handlePolling`'s per-channel loop used them, and that logic now lives in `poll-channel.ts`) while keeping `XTokenService`, `XActivityService`, `getAppCredentials`/`ByokConfig` (still used by `handleTokenRefresh`'s X token-refresh section) and adding `TikTokTokenService` (Task 4) and `pollChannelOnce`.

- [ ] **Step 6: Update `link/tests/services/cron-polling.test.ts` for the new delegation**

Replace the file's mocking strategy: instead of mocking `x-followers`/`x-posts`/`app-credentials`/`x-token` (now internal to `poll-channel.ts`, not `cron.ts`), mock `poll-channel.ts` directly and assert `handlePolling` calls it correctly per row:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const pollChannelOnceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/services/pollers/poll-channel", () => ({
  pollChannelOnce: (...args: unknown[]) => pollChannelOnceMock(...args),
}));

import { handlePolling } from "../../src/cron";

describe("handlePolling channel selection", () => {
  beforeEach(() => {
    pollChannelOnceMock.mockClear().mockResolvedValue(undefined);
  });

  it("queries both X and TIKTOK active channels and delegates each to pollChannelOnce", async () => {
    const channelRows = [
      { id: "chan-x", channel_type: "X" },
      { id: "chan-tt", channel_type: "TIKTOK" },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handlePolling(env);

    const call = linkDb.prepare.mock.calls[0][0] as string;
    expect(call).toContain("channel_type IN ('X', 'TIKTOK')");
    expect(call).toContain("is_active = 1");

    expect(pollChannelOnceMock).toHaveBeenCalledTimes(2);
    expect(pollChannelOnceMock).toHaveBeenCalledWith(env, "X", "chan-x");
    expect(pollChannelOnceMock).toHaveBeenCalledWith(env, "TIKTOK", "chan-tt");
  });

  it("stops calling pollChannelOnce once the total budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    pollChannelOnceMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(55_000);
    });

    const channelRows = [
      { id: "chan-1", channel_type: "X" },
      { id: "chan-2", channel_type: "X" },
    ];
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: channelRows }) }),
    };
    const env = { LINK_DB: linkDb } as any;

    await handlePolling(env);

    expect(pollChannelOnceMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

Delete the file's old mock setup (`runFollowersPollerMock`, `runPostsPollerMock`, `getAppCredentialsMock`, `getValidTokenMock`, `refreshAccessTokenMock`, and their `vi.mock` calls for `x-followers`/`x-posts`/`app-credentials`/`x-token`/`x-webhook`/`tenant-data-db`) — that behavior is now covered by Task 6 Step 1's `poll-channel.test.ts` instead.

- [ ] **Step 7: Run the full link test suite**

Run: `cd link && npx vitest run`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add link/src/services/pollers/poll-channel.ts link/src/cron.ts link/tests/services/pollers/poll-channel.test.ts link/tests/services/cron-polling.test.ts
git commit -m "feat(link): generalize per-channel polling into pollChannelOnce, shared by cron and OAuth callbacks"
```

---

### Task 7: OAuth callback changes — instant poll on connect (both platforms)

**Files:**
- Modify: `link/src/oauth.ts`
- Test: `link/tests/oauth.test.ts` (extend)

**Interfaces:**
- Consumes: `pollChannelOnce` (Task 6)

- [ ] **Step 1: Add `pollChannelOnce` mock and assertions to the X BYOK callback test**

In `link/tests/oauth.test.ts`, add near the other `vi.mock` calls (after line 52's `canUseFeature` mock):

```ts
const pollChannelOnceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/pollers/poll-channel", () => ({
  pollChannelOnce: (...args: unknown[]) => pollChannelOnceMock(...args),
}));
```

Add `pollChannelOnceMock.mockClear();` to the existing `beforeEach` block (alongside the other `.mockClear()` calls at lines 97-99).

Add a new assertion inside the first test (`"frees the conflicting channel row's slot..."`, after the existing `pollSeedCalls` assertion at line 144):

```ts
    expect(pollChannelOnceMock).toHaveBeenCalledWith(expect.anything(), "X", byokChannelId);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: FAIL — `pollChannelOnceMock` was never called (real `pollChannelOnce` isn't imported/called by `oauth.ts` yet, so the mock function itself is never invoked).

- [ ] **Step 3: Wire the instant poll call into the X BYOK callback**

In `link/src/oauth.ts`, add the import near the top (alongside line 10's `getAppCredentials` import):

```ts
import { pollChannelOnce } from "./services/pollers/poll-channel";
```

After the existing poll-state-seeding loop (currently lines 173-183, the `for (const pollerName of ["followers", "posts"])` block) and before the "Setup subscriptions" comment (line 185), add:

```ts
      try {
        await pollChannelOnce(c.env, "X", byokChannelId);
      } catch (e) {
        console.error("X BYOK instant poll failed:", e);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: PASS

- [ ] **Step 5: Update the TikTok callback to seed `channel_poll_state` and call `pollChannelOnce`**

Replace the current TikTok callback's "Trigger TikTok content sync" block (currently `link/src/oauth.ts:334-354`) with:

```ts
    // Seed (or reset, on re-authorization) poll state for the content poller —
    // full backfill runs again, mirroring the X BYOK callback's pattern.
    await c.env.LINK_DB
      .prepare(
        `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
         VALUES (?, 'content', NULL, 0, NULL, datetime('now'))
         ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
      )
      .bind(channelId)
      .run();

    try {
      await pollChannelOnce(c.env, "TIKTOK", channelId);
    } catch (e) {
      console.error("TikTok instant poll failed:", e);
    }
```

Since `TikTokChannel`/`ContentService`/`TenantDataDB` imports at the top of `oauth.ts` (lines 7-9) are no longer used by this callback, check whether they're still used elsewhere in the file (the X BYOK callback path doesn't use them) — if unused after this change, remove the `TikTokChannel`, `ContentService`, and `TenantDataDB` imports from `link/src/oauth.ts`.

- [ ] **Step 6: Write the failing test for the TikTok callback**

Add a new `describe` block to `link/tests/oauth.test.ts`:

```ts
describe("TikTok OAuth callback", () => {
  beforeEach(() => {
    pollChannelOnceMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("oauth/token")) {
          return Promise.resolve(new Response(JSON.stringify({ open_id: "tt-user-1", access_token: "tt-tok", expires_in: 86400 }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ data: { user: { open_id: "tt-user-1", display_name: "Name" } } }), { status: 200 }));
      })
    );
  });

  it("seeds channel_poll_state for poller_name='content' and calls pollChannelOnce", async () => {
    const kv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ tenantId: "5", memberId: "m1" })),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const linkDb = createMockLinkDb([]);

    const app = buildApp();
    const res = await app.request(
      "/tiktok/callback?code=abc&state=state123",
      {},
      { KV: kv, LINK_DB: linkDb, WEB_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) } } as any
    );

    expect(res.status).toBe(302);
    const seedCall = linkDb.calls.find((c) => c.sql.includes("INSERT INTO channel_poll_state"));
    expect(seedCall).toBeDefined();
    expect(seedCall!.sql).toContain("'content'");
    expect(pollChannelOnceMock).toHaveBeenCalledWith(expect.anything(), "TIKTOK", expect.any(String));
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full link test suite**

Run: `cd link && npx vitest run`
Expected: All PASS

- [ ] **Step 9: Typecheck**

Run: `cd link && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iv "react\|jsx"`
Expected: no output referencing `oauth.ts`, `cron.ts`, `poll-channel.ts`, `tiktok-content.ts`, `tiktok-content-api.ts`, `tiktok-token.ts`, or `content.ts` (pre-existing unrelated `@types/react` errors are expected and out of scope, per the precedent from the earlier metadata refactor session)

- [ ] **Step 10: Commit**

```bash
git add link/src/oauth.ts link/tests/oauth.test.ts
git commit -m "feat(link): instant poll on connect for X BYOK and TikTok via pollChannelOnce"
```

---

### Task 8: Manual end-to-end verification (dev environment)

**Files:** none (manual verification, no code changes)

- [ ] **Step 1: Deploy to dev**

Run: `cd link && wrangler deploy --env dev` (and `cd admin && wrangler deploy --env dev` if Task 2's `tenant-init-sql.ts` change needs to ship, though it only affects newly-provisioned tenants)

- [ ] **Step 2: Connect a TikTok test account via the dev frontend**

Navigate to the dev Social page, click "Connect TikTok", complete OAuth. Confirm the page redirects back successfully (no error).

- [ ] **Step 3: Verify instant content sync**

Run: `wrangler d1 execute <dev-tenant-db-id> --remote --command "SELECT id, source_content_id, content_type, view_count, share_count, cover_image_url FROM content WHERE channel_type = 'TIKTOK' ORDER BY created_at DESC LIMIT 5"`
Expected: rows appear immediately after connecting (not after waiting for the next cron tick), with `content_type = 'VIDEO'` and populated metric columns.

- [ ] **Step 4: Verify `channel_poll_state`**

Run: `wrangler d1 execute uniscrm-link-dev --env dev --remote --command "SELECT channel_id, poller_name, backfill_complete, last_polled_at FROM channel_poll_state WHERE poller_name = 'content'"`
Expected: a row with `backfill_complete = 1` (assuming the test account has few enough videos to finish backfill in one pass) and a recent `last_polled_at`.

- [ ] **Step 5: Verify the next cron tick runs incrementally without error**

Wait for the next hourly tick (or manually trigger via `wrangler dev`'s scheduled-event testing, if available), then check Workers Observability logs for `tiktok_content_poll_started`/`tiktok_content_poll_incremental_complete` events with no `tiktok_content_poll_error` entries.

- [ ] **Step 6: Verify X BYOK's new instant-poll-on-connect behavior doesn't regress**

If a dev X BYOK test channel is available, disconnect and reconnect it; confirm posts/followers appear immediately (same check as Task 2's original X posts-polling verification, but now expecting no cron-tick wait).
