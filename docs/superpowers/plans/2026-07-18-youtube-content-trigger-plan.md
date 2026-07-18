# YouTube Content Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch arbitrary public YouTube channels via WebSub push, filter new videos by duration and thumbnail face-detection, and feed passing videos into the existing `xContentAction:create-post` action to auto-publish to X.

**Architecture:** A new `channel_type = "YOUTUBE"` row (no OAuth) represents a watched channel. YouTube's free WebSub/PubSubHubbub feed pushes new-video notifications to a public `link` webhook, which fetches full video details + runs a thumbnail face-check via Workers AI, then reuses the existing `ContentService.upsertContentFromMetadata` → `content.created` → flow-engine pipeline every other content source already uses. A new `youtubeContentTrigger` flow node (one node = one channel) matches on `channelId` and filters via the existing generic `ConditionsEditor` over `duration` and a new `has_face` prop — no engine changes beyond one new trigger-match branch.

**Tech Stack:** Cloudflare Workers (Hono), D1, Workers AI (`@cf/moondream/moondream3.1-9B-A2B`), YouTube Data API v3, WebSub/PubSubHubbub, React Flow.

## Global Constraints

- No safety-net polling — WebSub push is the only ingestion path (spec's explicit v1 decision).
- One `youtubeContentTrigger` node watches exactly one YouTube channel; multiple channels means multiple nodes.
- Channel is added by pasting a URL directly into the node's Inspector — no separate "connect channel" page.
- `has_face` defaults to `1` (fail closed) on any face-detection model error.
- System-shared `YOUTUBE_API_KEY` only — no per-tenant BYOK, no OAuth for YouTube.
- `content` table gets `has_face INTEGER` via `TENANT_DB_INIT_SQL` + dev-tenant reprovision — **not** a live migration (no real customers yet, per the X List Posts trigger design's precedent).
- The `channels` table's existing global `UNIQUE(channel_type, source_channel_id)` index (`link/migrations/0001_initial_schema.sql`) is shared, live, production data for X/TikTok/NOTION/LOCAL — **do not migrate it**. YOUTUBE rows encode tenant scope into `source_channel_id` as `"{tenantId}:{youtubeChannelId}"` instead, so two tenants watching the same external channel each get their own row without touching the index.

---

## Task 1: Data model foundations

**Files:**
- Modify: `link/src/types.ts` (`ChannelType` union, `Env` interface)
- Modify: `metadata/props.ts` (new `has_face` prop)
- Create: `metadata/youtube.ts`
- Modify: `metadata/index.ts`
- Modify: `link/src/services/content.ts` (`CONTENT_COLUMN_MAP`)
- Modify: `admin/src/services/tenant-init-sql.ts` (`content` table)
- Test: `link/tests/services/content.test.ts` (extend if it exists, else create)

**Interfaces:**
- Produces: `ChannelType` includes `"YOUTUBE"`; `Env.YOUTUBE_API_KEY: string`; `ContentMetadata_YouTube: ContentMetadata[]` with one entry `sourceContentType: "watch:get-videos"`; `has_face` prop (`dataType: "INT"`, `entity: ["content"]`); `content` table has `has_face INTEGER` column; `CONTENT_COLUMN_MAP` includes `has_face: "has_face"`.

- [ ] **Step 1: Add `YOUTUBE` to `ChannelType` and `YOUTUBE_API_KEY` to `Env`**

In `link/src/types.ts`, find the `ChannelType` export (near the top, currently `export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X";`) and change to:

```ts
export type ChannelType = "LOCAL" | "NOTION" | "TIKTOK" | "X" | "YOUTUBE";
```

In the `Env` interface, under the `// TikTok` block, add:

```ts
  // YouTube (system-shared, no OAuth — public Data API reads only)
  YOUTUBE_API_KEY: string;
```

- [ ] **Step 2: Add the `has_face` prop to `metadata/props.ts`**

Open `metadata/props.ts`, find the closing `]);` of the `definePropDefinitions([...])` array (after the `share_count` entry), and add a new entry immediately before it:

```ts
  {
    propId: "has_face",
    isInsight: true,
    dataType: "INT",
    entity: ["content"],
    label: { en: "Has Face", zh: "含人脸" },
  },
```

- [ ] **Step 3: Create `metadata/youtube.ts`**

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
      // duration and has_face are computed (not resolveProps-mapped) — declared here with
      // no dataId/value purely so the flow Inspector's ConditionsEditor field list includes
      // them (see getContentTriggerFields in Task 10). resolveProps skips entries with
      // neither `value` nor `dataId`, so these are safe no-ops during ingestion mapping.
      { propId: "duration" },
      { propId: "has_face" },
    ],
  },
];
```

- [ ] **Step 4: Wire into `metadata/index.ts`**

Open `metadata/index.ts`, find where `ContentMetadata_X`/`ContentMetadata_TikTok` are exported and add:

```ts
export { ContentMetadata_YouTube } from "./youtube";
```

- [ ] **Step 5: Add `has_face` to `CONTENT_COLUMN_MAP`**

In `link/src/services/content.ts`, add to `CONTENT_COLUMN_MAP` (after `width: "width",`):

```ts
  has_face: "has_face",
```

- [ ] **Step 6: Add `has_face` column to the tenant `content` table schema**

In `admin/src/services/tenant-init-sql.ts`, in the `CREATE TABLE IF NOT EXISTS content (...)` block, add after `width INTEGER,`:

```ts
    has_face INTEGER,
```

- [ ] **Step 7: Verify with typecheck**

Run: `cd metadata && npx tsc --noEmit` and `cd link && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add link/src/types.ts metadata/props.ts metadata/youtube.ts metadata/index.ts link/src/services/content.ts admin/src/services/tenant-init-sql.ts
git commit -m "feat: add YouTube channel type, has_face prop, and content metadata"
```

---

## Task 2: YouTube Data API + WebSub client

**Files:**
- Create: `link/src/services/youtube-api.ts`
- Test: `link/tests/services/youtube-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export function parseISO8601Duration(iso: string): number
  export interface YouTubeChannelResolution { channelId: string; channelName: string; thumbnailUrl: string }
  export async function resolveYouTubeChannelId(apiKey: string, url: string): Promise<YouTubeChannelResolution | null>
  export async function fetchVideoDetails(apiKey: string, videoId: string): Promise<Record<string, unknown> | null>
  export async function subscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void>
  export async function unsubscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void>
  ```
  These are consumed by Task 4 (ingestion), Task 5 (webhook verify), Task 6 (watch endpoint), Task 8 (cron renewal).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/services/youtube-api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseISO8601Duration,
  resolveYouTubeChannelId,
  fetchVideoDetails,
  subscribeWebSub,
  unsubscribeWebSub,
} from "../../src/services/youtube-api";

describe("parseISO8601Duration", () => {
  it("parses hours, minutes, seconds", () => {
    expect(parseISO8601Duration("PT1H2M3S")).toBe(3723);
  });
  it("parses minutes-only", () => {
    expect(parseISO8601Duration("PT4M13S")).toBe(253);
  });
  it("parses seconds-only", () => {
    expect(parseISO8601Duration("PT45S")).toBe(45);
  });
  it("returns 0 for unparseable input", () => {
    expect(parseISO8601Duration("garbage")).toBe(0);
  });
});

describe("youtube-api fetch functions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("resolveYouTubeChannelId extracts a /channel/UC... URL without an API call", async () => {
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/channel/UCabc123");
    expect(result?.channelId).toBe("UCabc123");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveYouTubeChannelId resolves a @handle via channels.list forHandle", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [{ id: "UCxyz789", snippet: { title: "Example Channel", thumbnails: { default: { url: "https://img/thumb.jpg" } } } }],
    }));
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/@examplehandle");
    expect(result).toEqual({ channelId: "UCxyz789", channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg" });
    expect(fetchMock.mock.calls[0][0]).toContain("forHandle=%40examplehandle");
  });

  it("resolveYouTubeChannelId returns null when the API finds no channel", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [] }));
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/@nobody");
    expect(result).toBeNull();
  });

  it("fetchVideoDetails returns the first item", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [{ id: "vid1", snippet: { title: "Video 1" } }] }));
    const result = await fetchVideoDetails("key", "vid1");
    expect(result).toEqual({ id: "vid1", snippet: { title: "Video 1" } });
  });

  it("fetchVideoDetails returns null when the video no longer exists", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [] }));
    const result = await fetchVideoDetails("key", "deleted-vid");
    expect(result).toBeNull();
  });

  it("subscribeWebSub POSTs form-encoded hub.mode=subscribe", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 202 })));
    await subscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pubsubhubbub.appspot.com/subscribe");
    expect(init.body).toContain("hub.mode=subscribe");
    expect(init.body).toContain("hub.callback=https%3A%2F%2Flink.example%2Fyoutube%2Fwebsub%2Fchan1");
    expect(init.body).toContain(encodeURIComponent("channel_id=UCabc123"));
  });

  it("subscribeWebSub throws on a non-ok hub response", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("bad request", { status: 400 })));
    await expect(subscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123")).rejects.toThrow();
  });

  it("unsubscribeWebSub POSTs hub.mode=unsubscribe", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 202 })));
    await unsubscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toContain("hub.mode=unsubscribe");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/youtube-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/youtube-api'`

- [ ] **Step 3: Implement `link/src/services/youtube-api.ts`**

```ts
const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";

export function parseISO8601Duration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return parseInt(h || "0", 10) * 3600 + parseInt(m || "0", 10) * 60 + parseInt(s || "0", 10);
}

export interface YouTubeChannelResolution {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
}

// Best-effort URL parsing: direct /channel/UC... IDs need no API call. @handle URLs (and bare
// @handle input) resolve via channels.list?forHandle. /c/CustomName and /user/LegacyName URLs
// are not resolved (YouTube's forHandle/forUsername params don't reliably cover custom URLs) —
// flagged here as a known v1 gap rather than silently mishandled.
export async function resolveYouTubeChannelId(apiKey: string, url: string): Promise<YouTubeChannelResolution | null> {
  const channelIdMatch = /\/channel\/(UC[\w-]+)/.exec(url);
  if (channelIdMatch) {
    return fetchChannelById(apiKey, channelIdMatch[1]);
  }

  const handleMatch = /@([\w.-]+)/.exec(url);
  if (handleMatch) {
    return fetchChannelByHandle(apiKey, handleMatch[1]);
  }

  return null;
}

async function fetchChannelById(apiKey: string, channelId: string): Promise<YouTubeChannelResolution | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("id", channelId);
  apiUrl.searchParams.set("key", apiKey);
  return runChannelLookup(apiUrl);
}

async function fetchChannelByHandle(apiKey: string, handle: string): Promise<YouTubeChannelResolution | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("forHandle", `@${handle}`);
  apiUrl.searchParams.set("key", apiKey);
  return runChannelLookup(apiUrl);
}

async function runChannelLookup(apiUrl: URL): Promise<YouTubeChannelResolution | null> {
  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    items?: { id: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
  };
  const item = body.items?.[0];
  if (!item) return null;
  return {
    channelId: item.id,
    channelName: item.snippet?.title || "",
    thumbnailUrl: item.snippet?.thumbnails?.default?.url || "",
  };
}

export async function fetchVideoDetails(apiKey: string, videoId: string): Promise<Record<string, unknown> | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/videos`);
  apiUrl.searchParams.set("part", "snippet,contentDetails,statistics");
  apiUrl.searchParams.set("id", videoId);
  apiUrl.searchParams.set("key", apiKey);

  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`YouTube videos.list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: Record<string, unknown>[] };
  return body.items?.[0] ?? null;
}

async function callHub(mode: "subscribe" | "unsubscribe", callbackUrl: string, youtubeChannelId: string): Promise<void> {
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${youtubeChannelId}`;
  const body = new URLSearchParams({
    "hub.mode": mode,
    "hub.topic": topic,
    "hub.callback": callbackUrl,
    "hub.verify": "async",
  });
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`WebSub ${mode} failed: ${res.status} ${await res.text()}`);
  }
}

export async function subscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void> {
  await callHub("subscribe", callbackUrl, youtubeChannelId);
}

export async function unsubscribeWebSub(callbackUrl: string, youtubeChannelId: string): Promise<void> {
  await callHub("unsubscribe", callbackUrl, youtubeChannelId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/youtube-api.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-api.ts link/tests/services/youtube-api.test.ts
git commit -m "feat: add YouTube Data API and WebSub client"
```

---

## Task 3: Face detection via Workers AI

**Files:**
- Create: `link/src/services/youtube-vision.ts`
- Test: `link/tests/services/youtube-vision.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export async function detectFace(ai: Ai, imageUrl: string): Promise<0 | 1>` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `link/tests/services/youtube-vision.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { detectFace } from "../../src/services/youtube-vision";

describe("detectFace", () => {
  it("returns 1 when the model detects at least one object", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [{ x: 1, y: 2 }] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(1);
    expect(ai.run).toHaveBeenCalledWith("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: "https://img.example/thumb.jpg",
      target: "human face",
    });
  });

  it("returns 0 when the model detects no objects", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(0);
  });

  it("returns 0 when objects is missing from the response", async () => {
    const ai = { run: vi.fn().mockResolvedValue({}) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(0);
  });

  it("fails closed to 1 when the model call throws", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model unavailable")) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/youtube-vision.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `link/src/services/youtube-vision.ts`**

```ts
// Workers AI has no dedicated face-detection model — @cf/moondream/moondream3.1-9B-A2B's
// "detect" task returns bounding boxes for a target phrase, used here as the closest available
// primitive. On any model error, fails closed (assumes a face is present) per the design's
// explicit v1 decision — a detection outage should never silently let a face-containing
// thumbnail through a "no face" flow condition.
export async function detectFace(ai: Ai, imageUrl: string): Promise<0 | 1> {
  try {
    const response = (await ai.run("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: imageUrl,
      target: "human face",
    })) as { objects?: unknown[] };
    return Array.isArray(response.objects) && response.objects.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(JSON.stringify({ event: "youtube_face_detect_error", error: String(e) }));
    return 1;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/youtube-vision.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/youtube-vision.ts link/tests/services/youtube-vision.test.ts
git commit -m "feat: add thumbnail face detection via Workers AI"
```

---

## Task 4: Ingestion logic

**Files:**
- Create: `link/src/services/pollers/youtube-content.ts`
- Test: `link/tests/services/pollers/youtube-content.test.ts`

**Interfaces:**
- Consumes: `fetchVideoDetails`, `parseISO8601Duration` (Task 2); `detectFace` (Task 3); `resolveProps` (`link/src/services/pollers/resolve-props.ts`, existing); `ContentMetadata_YouTube` (Task 1); `ContentService.upsertContentFromMetadata(rawItem, resolvedProps, channelId, channelType, emitFlowEvent, listId?)` (existing, `link/src/services/content.ts`).
- Produces:
  ```ts
  export interface YouTubeIngestContext {
    channelId: string; tenantDb: TenantDataDB; tenantId: number; ai: Ai; vectorize: VectorizeIndex;
    apiKey: string; pipelineContent?: Pipeline; flowQueue?: Queue;
  }
  export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void>
  ```
  Consumed by Task 5 (webhook POST handler).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/services/pollers/youtube-content.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ingestYouTubeVideo } from "../../../src/services/pollers/youtube-content";
import * as youtubeApi from "../../../src/services/youtube-api";
import * as youtubeVision from "../../../src/services/youtube-vision";

function createMockTenantDb() {
  return {
    query: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function baseCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channelId: "chan1",
    tenantDb: createMockTenantDb() as any,
    tenantId: 1,
    ai: { run: vi.fn() } as any,
    vectorize: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() } as any,
    apiKey: "key",
    ...overrides,
  };
}

describe("ingestYouTubeVideo", () => {
  it("does nothing when the video no longer exists", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(null);
    const ctx = baseCtx();
    await ingestYouTubeVideo(ctx, "gone-vid");
    expect((ctx.tenantDb as any).run).not.toHaveBeenCalled();
  });

  it("parses duration, runs face detection on the thumbnail, and upserts content", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid1",
      snippet: {
        title: "Cool Video",
        description: "desc",
        publishedAt: "2026-07-18T00:00:00Z",
        thumbnails: { default: { url: "https://img/thumb.jpg" } },
      },
      contentDetails: { duration: "PT4M13S" },
      statistics: { viewCount: "100", likeCount: "10" },
    });
    const detectFaceSpy = vi.spyOn(youtubeVision, "detectFace").mockResolvedValue(0);

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid1");

    expect(detectFaceSpy).toHaveBeenCalledWith(ctx.ai, "https://img/thumb.jpg");
    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall).toBeTruthy();
    const insertCols = insertCall![0] as string;
    expect(insertCols).toContain("has_face");
    expect(insertCols).toContain("duration");
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams).toContain(253); // parsed duration
    expect(insertParams).toContain(0); // has_face
  });

  it("defaults has_face to 1 when there is no thumbnail to check", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid2",
      snippet: { title: "No Thumbnail", publishedAt: "2026-07-18T00:00:00Z" },
      contentDetails: { duration: "PT1M" },
    });
    const detectFaceSpy = vi.spyOn(youtubeVision, "detectFace");

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid2");

    expect(detectFaceSpy).not.toHaveBeenCalled();
    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall![1]).toContain(1); // has_face default
  });

  it("emits content.created via flowQueue on a genuinely new video", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid3",
      snippet: { title: "New", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT2M" },
    });
    vi.spyOn(youtubeVision, "detectFace").mockResolvedValue(0);

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid3");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `link/src/services/pollers/youtube-content.ts`**

```ts
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { ContentService } from "../content";
import { fetchVideoDetails, parseISO8601Duration } from "../youtube-api";
import { detectFace } from "../youtube-vision";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

const YOUTUBE_METADATA = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

export interface YouTubeIngestContext {
  channelId: string;
  tenantDb: TenantDataDB;
  tenantId: number;
  ai: Ai;
  vectorize: VectorizeIndex;
  apiKey: string;
  pipelineContent?: Pipeline;
  flowQueue?: Queue;
}

export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const item = await fetchVideoDetails(ctx.apiKey, videoId);
  if (!item) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", channel_id: ctx.channelId, video_id: videoId }));
    return;
  }

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  props.duration = durationIso ? parseISO8601Duration(durationIso) : 0;

  const thumbnailUrl = props.cover_image_url as string | undefined;
  props.has_face = thumbnailUrl ? await detectFace(ctx.ai, thumbnailUrl) : 1;

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const isNew = await contentService.upsertContentFromMetadata(item, props, ctx.channelId, "YOUTUBE", true);
  console.log(JSON.stringify({ event: "youtube_video_ingested", channel_id: ctx.channelId, video_id: videoId, isNew }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/pollers/youtube-content.ts link/tests/services/pollers/youtube-content.test.ts
git commit -m "feat: add YouTube video ingestion (duration parse + face check + content upsert)"
```

---

## Task 5: WebSub webhook routes

**Files:**
- Create: `link/src/webhook-youtube.ts`
- Modify: `link/src/index.ts` (mount route)
- Test: `link/tests/webhook-youtube.test.ts`

**Interfaces:**
- Consumes: `ingestYouTubeVideo` (Task 4); existing `env.LINK_DB`, `env.WEB_DB`, `TenantDataDB` (`shared/tenant-data-db`).
- Produces: `export function youtubeWebhookRoutes()` returning a Hono router with `GET /websub/:channelId` and `POST /websub/:channelId`, mounted at `/youtube` in `link/src/index.ts` (so full paths are `/youtube/websub/:channelId`).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/webhook-youtube.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { youtubeWebhookRoutes } from "../src/webhook-youtube";
import * as youtubeContent from "../src/services/pollers/youtube-content";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.route("/youtube", youtubeWebhookRoutes());
  return { app, env };
}

describe("youtubeWebhookRoutes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /websub/:channelId echoes hub.challenge and stores the lease expiry", async () => {
    const updateBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const selectFirst = vi.fn().mockResolvedValue({ config: JSON.stringify({ youtube_channel_id: "UCabc" }) });
    const linkDb = {
      prepare: vi.fn((sql: string) =>
        sql.startsWith("SELECT")
          ? { bind: vi.fn().mockReturnValue({ first: selectFirst }) }
          : { bind: updateBind }
      ),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request(
      "/youtube/websub/chan1?hub.challenge=abc123&hub.lease_seconds=432000&hub.topic=t&hub.mode=subscribe",
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    expect(updateBind).toHaveBeenCalled();
    const configArg = updateBind.mock.calls[0][0] as string;
    expect(JSON.parse(configArg).websub_lease_expires_at).toBeTruthy();
  });

  it("GET /websub/:channelId returns 400 when hub.challenge is missing", async () => {
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() } });
    const res = await app.request("/youtube/websub/chan1", {}, env);
    expect(res.status).toBe(400);
  });

  it("POST /websub/:channelId extracts videoIds and ingests each one", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ tenant_id: 1 }),
        }),
      }),
    };
    const webDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ d1_database_id: "db-1" }),
        }),
      }),
    };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);

    const { app, env } = buildApp({
      LINK_DB: linkDb, WEB_DB: webDb, CF_ACCOUNT_ID: "acc", CF_D1_API_TOKEN: "tok",
      AI: {}, VECTORIZE: {}, YOUTUBE_API_KEY: "key",
    });

    const atomBody = `<?xml version="1.0"?><feed xmlns:yt="ns"><entry><yt:videoId>vid1</yt:videoId></entry></feed>`;
    const res = await app.request("/youtube/websub/chan1", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy.mock.calls[0][1]).toBe("vid1");
    expect(ingestSpy.mock.calls[0][0]).toMatchObject({ channelId: "chan1", tenantId: 1 });
  });

  it("POST /websub/:channelId is a no-op when the channel is unknown", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const atomBody = `<entry><yt:videoId>vid1</yt:videoId></entry>`;
    const res = await app.request("/youtube/websub/unknown-chan", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/webhook-youtube.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `link/src/webhook-youtube.ts`**

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { ingestYouTubeVideo } from "./services/pollers/youtube-content";

function extractVideoIds(atomXml: string): string[] {
  const ids: string[] = [];
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(atomXml)) !== null) ids.push(m[1]);
  return ids;
}

export function youtubeWebhookRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  // WebSub verification handshake: echo hub.challenge back, and persist the granted
  // lease so the renewal cron (Task 8) knows when to re-subscribe.
  router.get("/websub/:channelId", async (c) => {
    const challenge = c.req.query("hub.challenge");
    if (!challenge) return c.text("Missing hub.challenge", 400);

    const channelId = c.req.param("channelId");
    const leaseSeconds = c.req.query("hub.lease_seconds");
    if (leaseSeconds) {
      const row = await c.env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?").bind(channelId).first<{ config: string }>();
      if (row) {
        const config = JSON.parse(row.config) as Record<string, unknown>;
        config.websub_lease_expires_at = new Date(Date.now() + parseInt(leaseSeconds, 10) * 1000).toISOString();
        await c.env.LINK_DB
          .prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?")
          .bind(JSON.stringify(config), channelId)
          .run();
      }
    }

    return c.text(challenge);
  });

  router.post("/websub/:channelId", async (c) => {
    const channelId = c.req.param("channelId");
    const body = await c.req.text();
    const videoIds = extractVideoIds(body);
    if (videoIds.length === 0) return c.text("ok");

    const row = await c.env.LINK_DB
      .prepare("SELECT tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE' AND is_active = 1")
      .bind(channelId)
      .first<{ tenant_id: number | null }>();
    if (!row?.tenant_id) {
      console.log(JSON.stringify({ event: "youtube_websub_unknown_channel", channel_id: channelId }));
      return c.text("ok");
    }

    const tenant = await c.env.WEB_DB
      .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(row.tenant_id)
      .first<{ d1_database_id: string | null }>();
    if (!tenant?.d1_database_id) return c.text("ok");

    const tenantDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenant.d1_database_id);

    for (const videoId of videoIds) {
      try {
        await ingestYouTubeVideo(
          {
            channelId,
            tenantDb,
            tenantId: row.tenant_id,
            ai: c.env.AI,
            vectorize: c.env.VECTORIZE,
            apiKey: c.env.YOUTUBE_API_KEY,
            pipelineContent: c.env.PIPELINE_CONTENT,
            flowQueue: c.env.FLOW_QUEUE,
          },
          videoId
        );
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_websub_ingest_error", channel_id: channelId, video_id: videoId, error: String(e) }));
      }
    }

    return c.text("ok");
  });

  return router;
}
```

- [ ] **Step 4: Mount the route in `link/src/index.ts`**

Add the import near the other webhook import:

```ts
import { youtubeWebhookRoutes } from "./webhook-youtube";
```

Add the mount right after `app.route("/x", webhookRoutes());`:

```ts
// Public: YouTube WebSub push notifications
app.route("/youtube", youtubeWebhookRoutes());
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/webhook-youtube.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add link/src/webhook-youtube.ts link/src/index.ts link/tests/webhook-youtube.test.ts
git commit -m "feat: add YouTube WebSub webhook routes"
```

---

## Task 6: Watch-channel endpoint

**Files:**
- Modify: `link/src/routes-channels.ts`
- Test: `link/tests/routes-channels-youtube.test.ts`

**Interfaces:**
- Consumes: `resolveYouTubeChannelId`, `subscribeWebSub` (Task 2).
- Produces: `POST /api/channels/youtube/watch` (authenticated route, body `{ channelUrl }`, returns `{ channelId, channelName, thumbnailUrl }`). Consumed by Task 10 (flow frontend proxy).

- [ ] **Step 1: Write the failing tests**

Create `link/tests/routes-channels-youtube.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";
import * as youtubeApi from "../src/services/youtube-api";

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

describe("POST /api/channels/youtube/watch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the URL, creates a channel row, and subscribes WebSub", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg",
    });
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    const runMock = vi.fn().mockResolvedValue({ success: true });
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: runMock }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    const res = await app.request(
      "/api/channels/youtube/watch",
      { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg" });
    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/"), "UCabc123");

    const insertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO channels"));
    expect(insertCall![0]).toContain("YOUTUBE");
  });

  it("scopes source_channel_id by tenant so two tenants can watch the same external channel", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "",
    });
    vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    const bindMock = vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindMock }) };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) }, env);

    const insertBindArgs = bindMock.mock.calls.find((c: unknown[]) => c.includes("YOUTUBE"));
    expect(insertBindArgs).toContain("1:UCabc123"); // tenantId:youtubeChannelId
  });

  it("returns 400 when the URL cannot be resolved", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue(null);
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() }, YOUTUBE_API_KEY: "key" });

    const res = await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "not a url" }) }, env);
    expect(res.status).toBe(400);
  });

  it("reuses the existing row and does not re-subscribe when already watching this channel", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "",
    });
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ id: "existing-chan" }), run: vi.fn().mockResolvedValue({ success: true }) }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    const res = await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) }, env);

    expect((await res.json() as any).channelId).toBe("existing-chan");
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/routes-channels-youtube.test.ts`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 3: Implement the route in `link/src/routes-channels.ts`**

Add the import at the top:

```ts
import { resolveYouTubeChannelId, subscribeWebSub } from "./services/youtube-api";
```

Add the route (place it near the other channel-type-specific routes, e.g. after the `/tiktok/sync` block):

```ts
  // --- YouTube ---
  router.post("/youtube/watch", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const { channelUrl } = await c.req.json<{ channelUrl: string }>();
    if (!channelUrl) return c.json({ error: "Missing channelUrl" }, 400);

    const resolved = await resolveYouTubeChannelId(c.env.YOUTUBE_API_KEY, channelUrl);
    if (!resolved) return c.json({ error: "Could not resolve this channel URL" }, 400);

    // Tenant-scoped, since the shared channels(channel_type, source_channel_id) unique index
    // (link/migrations/0001_initial_schema.sql) is global — two tenants watching the same
    // external YouTube channel must not collide on that index.
    const sourceChannelId = `${tenantId}:${resolved.channelId}`;
    const config = { youtube_channel_id: resolved.channelId, channel_name: resolved.channelName, thumbnail_url: resolved.thumbnailUrl };
    const now = new Date().toISOString();

    const existing = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE channel_type = 'YOUTUBE' AND source_channel_id = ? AND is_active = 1")
      .bind(sourceChannelId)
      .first<{ id: string }>();

    let channelId: string;
    if (existing) {
      channelId = existing.id;
      await c.env.LINK_DB
        .prepare("UPDATE channels SET config = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(config), now, channelId)
        .run();
    } else {
      channelId = crypto.randomUUID();
      await c.env.LINK_DB
        .prepare(
          `INSERT INTO channels (id, channel_type, config, source_channel_id, tenant_id, member_id, created_at, updated_at)
           VALUES (?, 'YOUTUBE', ?, ?, ?, ?, ?, ?)`
        )
        .bind(channelId, JSON.stringify(config), sourceChannelId, tenantId, memberId, now, now)
        .run();

      try {
        await subscribeWebSub(`${c.env.LINK_URL}/youtube/websub/${channelId}`, resolved.channelId);
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_websub_subscribe_error", channel_id: channelId, error: String(e) }));
      }
    }

    return c.json({ channelId, channelName: resolved.channelName, thumbnailUrl: resolved.thumbnailUrl });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/routes-channels-youtube.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-channels.ts link/tests/routes-channels-youtube.test.ts
git commit -m "feat: add YouTube watch-channel endpoint"
```

---

## Task 7: `flow`'s `/internal/youtube-watches` endpoint

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/youtube-watches.test.ts`

**Interfaces:**
- Consumes: existing `FlowGraph` type, `c.env.FLOW_DB`, `c.env.INTERNAL_SECRET` (already used by `/internal/list-watches`, same file).
- Produces: `GET /internal/youtube-watches` → `{ watches: { channelId: string }[] }`. Consumed by Task 8 (link's cron renewal).

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/youtube-watches.test.ts` (mirror the structure of any existing `list-watches` test if present; if none exists, use this self-contained version against the running worker via `app.request`):

```ts
import { describe, it, expect, vi } from "vitest";
import app from "../../src/index";

function makeEnv(flowRows: { graph_json: string }[]) {
  return {
    INTERNAL_SECRET: "secret",
    FLOW_DB: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: flowRows }),
      }),
    },
  } as any;
}

describe("GET /internal/youtube-watches", () => {
  it("rejects requests without the internal secret", async () => {
    const res = await app.request("/internal/youtube-watches", {}, makeEnv([]));
    expect(res.status).toBe(401);
  });

  it("returns distinct channelIds from published youtubeContentTrigger nodes", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "chanA" } },
        { id: "n2", type: "youtubeContentTrigger", data: { channelId: "chanA" } }, // dup, same flow
        { id: "n3", type: "xContentTrigger", data: { channelId: "chanX", mode: "get-list-posts", listId: "l1" } }, // ignored, wrong type
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await app.request("/internal/youtube-watches", { headers: { "X-Internal-Secret": "secret" } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.watches).toEqual([{ channelId: "chanA" }]);
  });

  it("skips nodes with a blank channelId", async () => {
    const graph = { nodes: [{ id: "n1", type: "youtubeContentTrigger", data: { channelId: "" } }] };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await app.request("/internal/youtube-watches", { headers: { "X-Internal-Secret": "secret" } }, env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/youtube-watches.test.ts`
Expected: FAIL — 404 (route doesn't exist yet)

- [ ] **Step 3: Implement the route in `flow/src/index.ts`**

Add immediately after the existing `/internal/list-watches` handler:

```ts
// Internal: which YouTube channelIds any published flow's youtubeContentTrigger node
// currently wants watched. link's renewal cron pulls this to decide which WebSub
// subscriptions to renew vs. let lapse — same "graph_json is the sole source of truth"
// pattern as /internal/list-watches above.
app.get("/internal/youtube-watches", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE status = 'published' AND graph_json LIKE '%youtubeContentTrigger%'`
  ).all<{ graph_json: string }>();

  const seen = new Set<string>();
  const watches: { channelId: string }[] = [];
  for (const row of rows.results) {
    let graph: FlowGraph;
    try {
      graph = JSON.parse(row.graph_json);
    } catch {
      continue;
    }
    if (!graph || !Array.isArray(graph.nodes)) continue;
    for (const node of graph.nodes) {
      if (!node.data) continue;
      if (node.type !== "youtubeContentTrigger") continue;
      const channelId = node.data.channelId as string;
      if (!channelId || seen.has(channelId)) continue;
      seen.add(channelId);
      watches.push({ channelId });
    }
  }

  return c.json({ watches });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/youtube-watches.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/youtube-watches.test.ts
git commit -m "feat: add /internal/youtube-watches endpoint"
```

---

## Task 8: Cron renewal (subscribe/renew/unsubscribe)

**Files:**
- Modify: `link/src/cron.ts`
- Test: `link/tests/cron-youtube-renewal.test.ts`

**Interfaces:**
- Consumes: `subscribeWebSub`, `unsubscribeWebSub` (Task 2); `/internal/youtube-watches` (Task 7, called over HTTP).
- Produces: `handleYouTubeRenewal(env)` added to `handleCron`'s `Promise.allSettled([...])`.

- [ ] **Step 1: Write the failing tests**

Create `link/tests/cron-youtube-renewal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCron } from "../src/cron";
import * as youtubeApi from "../src/services/youtube-api";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("YouTube WebSub renewal cron", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function baseEnv(overrides: Record<string, unknown> = {}) {
    return {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) }) },
      WEB_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) },
      FLOW_URL: "https://flow.example",
      LINK_URL: "https://link.example",
      INTERNAL_SECRET: "secret",
      X_BEARER_TOKEN: "", TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "",
      TREND_RETENTION_DAYS: "30",
      ...overrides,
    } as any;
  }

  it("renews a subscription nearing lease expiry for a still-referenced channel", async () => {
    const nearExpiry = new Date(Date.now() + 60_000).toISOString(); // 1 min from now, well under 24h window
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc", websub_lease_expires_at: nearExpiry }) }] }) };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "chan1" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/chan1"), "UCabc");
  });

  it("does not renew a channel whose lease is not close to expiry", async () => {
    const farExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc", websub_lease_expires_at: farExpiry }) }] }) };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "chan1" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("unsubscribes and deactivates a channel no longer referenced by any published flow", async () => {
    const updateBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM channels WHERE channel_type = 'YOUTUBE'")) {
          return { all: vi.fn().mockResolvedValue({ results: [{ id: "chan1", config: JSON.stringify({ youtube_channel_id: "UCabc" }) }] }) };
        }
        if (sql.startsWith("UPDATE channels SET is_active")) {
          return { bind: updateBind };
        }
        return { bind: vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [] }); // no longer referenced
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(unsubscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/chan1"), "UCabc");
    expect(updateBind).toHaveBeenCalledWith("chan1");
  });

  it("does not touch subscriptions when the watches fetch fails", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) }) };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub");
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub");

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return Promise.resolve(new Response(null, { status: 500 }));
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/cron-youtube-renewal.test.ts`
Expected: FAIL — `subscribeWebSub`/`unsubscribeWebSub` never called (renewal logic doesn't exist yet)

- [ ] **Step 3: Implement `handleYouTubeRenewal` in `link/src/cron.ts`**

> **Corrected after Task 8 code review (Critical defect, user-approved fix):** the
> original spec below unsubscribed and set `is_active = 0` for any unreferenced
> channel, mirroring the analogous X List Posts trigger pattern. That analogy doesn't
> hold here: a channel is subscribed the moment it's bound (`POST /youtube/watch`),
> but only becomes "referenced" once its owning flow is *published*, and publishing
> normally takes longer than the hourly cron interval — so a channel got deactivated
> before the tenant finished wiring it up, and the `is_active = 1` filter then
> permanently excluded it from all future renewal runs with no self-heal. The
> unreferenced branch below now just skips renewal for the cycle; the WebSub lease
> lapses naturally near its ~10-day expiry if the channel truly stays unreferenced
> forever, and publishing the flow later self-heals renewal on the very next cron run.

Add the import at the top:

```ts
import { subscribeWebSub } from "./services/youtube-api";
```

Add the function (place it after `handlePolling`):

```ts
const YOUTUBE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

async function handleYouTubeRenewal(env: Env): Promise<void> {
  let referencedIds: Set<string>;
  try {
    const res = await fetch(`${env.FLOW_URL}/internal/youtube-watches`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { watches } = (await res.json()) as { watches: { channelId: string }[] };
    referencedIds = new Set(watches.map((w) => w.channelId));
  } catch (e) {
    // Don't touch any subscription if we can't confirm what's still referenced —
    // an unsubscribe based on stale/missing data would silently kill a live trigger.
    console.error(JSON.stringify({ event: "youtube_watches_fetch_error", error: String(e) }));
    return;
  }

  const rows = await env.LINK_DB
    .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE' AND is_active = 1")
    .all<{ id: string; config: string }>();

  for (const row of rows.results) {
    const config = JSON.parse(row.config) as { youtube_channel_id: string; websub_lease_expires_at?: string };

    // Not referenced by any published flow yet — skip renewal this cycle rather than
    // tearing the subscription down. A tenant may still be mid-build on the flow that
    // will reference this channel (binding happens before publish), and deactivating
    // here would permanently exclude the row from future runs (the query above only
    // selects is_active = 1), with no self-heal even after the flow is published.
    // If it truly stays unreferenced forever, the WebSub lease simply lapses on its
    // own near its ~10-day expiry.
    if (!referencedIds.has(row.id)) {
      continue;
    }

    const expiresAt = config.websub_lease_expires_at ? new Date(config.websub_lease_expires_at).getTime() : 0;
    if (expiresAt - Date.now() > YOUTUBE_RENEWAL_WINDOW_MS) continue;

    try {
      await subscribeWebSub(`${env.LINK_URL}/youtube/websub/${row.id}`, config.youtube_channel_id);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_resubscribe_error", channel_id: row.id, error: String(e) }));
    }
  }
}
```

Add it to `handleCron`'s `Promise.allSettled`:

```ts
export async function handleCron(env: Env): Promise<void> {
  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
    handlePolling(env),
    handleYouTubeRenewal(env),
  ]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/cron-youtube-renewal.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full link suite to check for regressions**

Run: `cd link && npx vitest run`
Expected: all tests pass (existing + new)

- [ ] **Step 6: Commit**

```bash
git add link/src/cron.ts link/tests/cron-youtube-renewal.test.ts
git commit -m "feat: add YouTube WebSub subscription renewal cron"
```

---

## Task 9: Flow engine trigger matching + node registry

**Files:**
- Modify: `flow/src/engine.ts`
- Modify: `flow/nodeTypeRegistry.ts`
- Test: `flow/tests/unit/engine.test.ts` (extend)
- Test: `flow/tests/unit/node-type-registry.test.ts` (extend)

**Interfaces:**
- Produces: `executeFlow` matches `youtubeContentTrigger` nodes on `eventType === "content.created" && node.data.channelId === payload.channel_id`; `NODE_TYPE_REGISTRY.youtubeContentTrigger` entry; `CONTENT_FLOW_SIDEBAR_ORDER` includes `"youtubeContentTrigger"`.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/engine.test.ts` (in the `executeFlow` / trigger-matching describe block):

```ts
it("matches a youtubeContentTrigger node on channelId for content.created events", () => {
  const graph = {
    nodes: [
      { id: "t1", type: "youtubeContentTrigger", data: { channelId: "chanY", conditions: [] } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const result = executeFlow(graph as any, "content.created", { channel_id: "chanY" });
  expect(result.matched).toBe(true);
});

it("does not match a youtubeContentTrigger node for a different channel", () => {
  const graph = {
    nodes: [{ id: "t1", type: "youtubeContentTrigger", data: { channelId: "chanY", conditions: [] } }],
    edges: [],
  };
  const result = executeFlow(graph as any, "content.created", { channel_id: "chanOther" });
  expect(result.matched).toBe(false);
});
```

Add to `flow/tests/unit/node-type-registry.test.ts`:

```ts
it("includes youtubeContentTrigger with domain content and a promptFragment", () => {
  expect(NODE_TYPE_REGISTRY.youtubeContentTrigger.domain).toBe("content");
  expect(NODE_TYPE_REGISTRY.youtubeContentTrigger.promptFragment).toContain("youtubeContentTrigger");
});

it("lists youtubeContentTrigger in the content sidebar order", () => {
  expect(CONTENT_FLOW_SIDEBAR_ORDER).toContain("youtubeContentTrigger");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts tests/unit/node-type-registry.test.ts`
Expected: FAIL — `youtubeContentTrigger` doesn't match / registry entry missing

- [ ] **Step 3: Add the trigger filter in `flow/src/engine.ts`**

In `executeFlow`, extend the `triggerNodes` filter (the block starting `const triggerNodes = graph.nodes.filter(...)`) by adding one more `||` clause after the `xContentTrigger` clause:

```ts
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id)
```

- [ ] **Step 4: Add the registry entry in `flow/nodeTypeRegistry.ts`**

Add immediately after the `xContentTrigger` entry:

```ts
  youtubeContentTrigger: {
    reactFlowType: "youtubeContentTrigger",
    label: "YouTube Trigger",
    description: "Watches a public YouTube channel",
    domain: "content",
    generatable: true,
    promptFragment: `youtubeContentTrigger - triggers when a watched YouTube channel publishes a new video
   data: { channelId: "", channelUrl: "", channelName: "", conditions: [] }
   - channelId/channelUrl/channelName are left blank ("") — the user pastes a channel URL into the Inspector after generation, which resolves and fills these in.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
  },
```

Update `CONTENT_FLOW_SIDEBAR_ORDER`:

```ts
export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "updateContentStatus",
  "wait", "timeCondition", "abSplit", "webhook",
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts tests/unit/node-type-registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add flow/src/engine.ts flow/nodeTypeRegistry.ts flow/tests/unit/engine.test.ts flow/tests/unit/node-type-registry.test.ts
git commit -m "feat: add youtubeContentTrigger engine matching and registry entry"
```

---

## Task 10: Flow frontend — node, Inspector, editor wiring

**Files:**
- Modify: `flow/frontend/config/trigger-fields.ts` (generalize `getContentTriggerFields`)
- Create: `flow/frontend/nodes/YouTubeContentTriggerNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/frontend/lib/api.ts`
- Modify: `flow/src/index.ts` (new proxy route)
- Test: `flow/tests/unit/trigger-fields.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `ContentMetadata_YouTube` (Task 1), `NODE_TYPE_REGISTRY.youtubeContentTrigger` (Task 9).
- Produces: a fully usable `youtubeContentTrigger` node in the canvas, Sidebar, and Inspector; `api.channels.youtubeWatch(channelUrl)`.

- [ ] **Step 1: Write the failing test for the generalized `getContentTriggerFields`**

Create `flow/tests/unit/trigger-fields.test.ts` (or extend if a similar file exists — check `flow/tests/unit/` first):

```ts
import { describe, it, expect } from "vitest";
import { getContentTriggerFields } from "../../frontend/config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../metadata/youtube";

describe("getContentTriggerFields", () => {
  it("still returns X's own-posts fields when passed ContentMetadata_X", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "own:get-posts");
    expect(fields.some((f) => f.id === "content_text")).toBe(true);
  });

  it("returns duration and has_face for the YouTube watch mode", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    expect(fields.map((f) => f.id)).toEqual(expect.arrayContaining(["duration", "has_face"]));
  });

  it("returns an empty array for an unknown sourceContentType", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "nonexistent");
    expect(fields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/trigger-fields.test.ts`
Expected: FAIL — `getContentTriggerFields` currently takes only `(mode, locale)`, not a metadata array

- [ ] **Step 3: Generalize `getContentTriggerFields` in `flow/frontend/config/trigger-fields.ts`**

Add the type import at the top:

```ts
import type { ContentMetadata } from "../../../metadata/dataTypes";
```

Replace the existing function:

```ts
export function getContentTriggerFields(mode: string, locale: Locale = "en"): TriggerFieldDefinition[] {
  const meta = ContentMetadata_X.find((m) => m.sourceContentType === mode);
  if (!meta) return [];
  return meta.contentProps
    .map((p) => propToField(p.propId, locale, "content"))
    .filter(Boolean) as TriggerFieldDefinition[];
}
```

with:

```ts
export function getContentTriggerFields(
  metadata: ContentMetadata[],
  sourceContentType: string,
  locale: Locale = "en"
): TriggerFieldDefinition[] {
  const meta = metadata.find((m) => m.sourceContentType === sourceContentType);
  if (!meta) return [];
  return meta.contentProps
    .map((p) => propToField(p.propId, locale, "content"))
    .filter(Boolean) as TriggerFieldDefinition[];
}
```

- [ ] **Step 4: Update the one existing call site in `flow/frontend/components/Inspector.tsx`**

Find (inside `XContentTriggerInspector`):

```tsx
        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(data.mode || CONTENT_X_TRIGGER_MODE_LIST_POSTS)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
```

Replace with:

```tsx
        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_X, data.mode || CONTENT_X_TRIGGER_MODE_LIST_POSTS)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/trigger-fields.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Add `api.channels.youtubeWatch` in `flow/frontend/lib/api.ts`**

Inside the `channels: { ... }` object, add:

```ts
    youtubeWatch: (channelUrl: string) =>
      request<{ channelId: string; channelName: string; thumbnailUrl: string }>(`/api/channels/youtube/watch`, {
        method: "POST",
        body: JSON.stringify({ channelUrl }),
      }),
```

- [ ] **Step 7: Add the proxy route in `flow/src/index.ts`**

Add immediately after the `/api/channels/:channelId/x-lists` proxy route:

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

- [ ] **Step 8: Create `flow/frontend/nodes/YouTubeContentTriggerNode.tsx`**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function YouTubeContentTriggerNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const channelName = (data.channelName as string) || "(no channel selected)";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-red-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">▶️</span>
        <div>
          <span className="font-semibold text-sm text-red-700">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</span>
          <p className="text-xs text-gray-500">{channelName}</p>
          {condCount > 0 && (
            <p className="text-xs text-red-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-red-500 !w-3 !h-3" />
    </div>
  );
}
```

- [ ] **Step 9: Register the node type in `flow/frontend/nodes/index.ts`**

Add the import:

```ts
import YouTubeContentTriggerNode from "./YouTubeContentTriggerNode";
```

Add to the `nodeTypes` map:

```ts
  youtubeContentTrigger: YouTubeContentTriggerNode,
```

- [ ] **Step 10: Add `YouTubeContentTriggerInspector` in `flow/frontend/components/Inspector.tsx`**

Add the import:

```tsx
import { ContentMetadata_YouTube } from "../../../metadata/youtube";
```

Add the component (place it after `XContentTriggerInspector`):

```tsx
function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const [urlInput, setUrlInput] = useState((data.channelUrl as string) || "");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");

  const resolveChannel = async () => {
    if (!urlInput) return;
    setResolving(true);
    setError("");
    try {
      const res = await api.channels.youtubeWatch(urlInput);
      updateNodeData(nodeId, { channelId: res.channelId, channelUrl: urlInput, channelName: res.channelName });
    } catch {
      setError("Could not resolve this channel URL");
    } finally {
      setResolving(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Channel URL</Label>
          <div className="flex gap-1">
            <Input
              type="text"
              value={urlInput}
              onChange={(e: InputChange) => setUrlInput(e.target.value)}
              placeholder="https://www.youtube.com/@handle"
              className="flex-1 h-8 text-sm"
            />
            <Button type="button" size="sm" onClick={resolveChannel} disabled={resolving || !urlInput}>
              {resolving ? "..." : "Watch"}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive mt-1">{error}</p>}
          {data.channelName && <p className="text-xs text-muted-foreground mt-1">Watching: {data.channelName}</p>}
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

Find the main Inspector switch/dispatch that renders `<XContentTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />` (around line 1016) and add a sibling case immediately after it, matching whatever conditional structure surrounds that line (e.g. `{node.type === "xContentTrigger" && (...)}` followed by a new `{node.type === "youtubeContentTrigger" && <YouTubeContentTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />}`).

- [ ] **Step 11: Wire defaults and edge rules in `flow/frontend/store/flow-editor.ts`**

Find the edge-validity check (the function containing `if (targetType === "xTrigger" || targetType === "cronTrigger" || targetType === "xContentTrigger") return false;`) and change to:

```ts
  if (targetType === "xTrigger" || targetType === "cronTrigger" || targetType === "xContentTrigger" || targetType === "youtubeContentTrigger") return false;
```

Find the `validSources` array on the next line and add `"youtubeContentTrigger"`:

```ts
  const validSources = ["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger", "wait", "waitForEvent", "action", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps"];
```

Find the node-creation branch (`} else if (type === "xContentTrigger") { ... }`) and add a sibling branch immediately after it:

```ts
    } else if (type === "youtubeContentTrigger") {
      nodeType = "youtubeContentTrigger";
      data = { channelId: "", channelUrl: "", channelName: "", conditions: [] };
```

(keep the existing `} else {` / `return;` fallthrough after it unchanged).

- [ ] **Step 12: Add the Sidebar entry in `flow/frontend/components/Sidebar.tsx`**

Find the `if (visible("xContentTrigger")) { ... }` block and add a sibling block immediately after it:

```tsx
  if (visible("youtubeContentTrigger")) {
    items.push({
      key: "youtubeContentTrigger",
      el: <DraggableItem key="youtubeContentTrigger" type="youtubeContentTrigger" label={NODE_TYPE_REGISTRY.youtubeContentTrigger.label!} description={NODE_TYPE_REGISTRY.youtubeContentTrigger.description!} color="border-primary/30 bg-primary/5" icon="▶️" />,
    });
  }
```

- [ ] **Step 13: Typecheck the frontend**

Run: `cd flow && npx tsc --noEmit -p frontend` (or the project's existing frontend typecheck command — check `flow/package.json`'s scripts if this path differs)
Expected: no new errors.

- [ ] **Step 14: Commit**

```bash
git add flow/frontend/config/trigger-fields.ts flow/frontend/nodes/YouTubeContentTriggerNode.tsx flow/frontend/nodes/index.ts flow/frontend/components/Inspector.tsx flow/frontend/components/Sidebar.tsx flow/frontend/store/flow-editor.ts flow/frontend/lib/api.ts flow/src/index.ts flow/tests/unit/trigger-fields.test.ts
git commit -m "feat: add youtubeContentTrigger node, Inspector, and Sidebar entry"
```

---

## Task 11: Deploy and self-test (per project convention)

**Files:** none (operational task)

- [ ] **Step 1: Set the `YOUTUBE_API_KEY` secret for dev**

This requires a real Google Cloud API key with the YouTube Data API v3 enabled (create one at https://console.cloud.google.com/apis/credentials if you don't have one). Run interactively:

```bash
cd link && wrangler secret put YOUTUBE_API_KEY --env dev
```

- [ ] **Step 2: Run the full test suites**

```bash
cd link && npx vitest run
cd flow && npx vitest run
```

Expected: all tests pass (existing suites + everything added in Tasks 1–10).

- [ ] **Step 3: Deploy both modules to dev**

```bash
cd link && npm run deploy:dev
cd flow && npm run deploy:dev
```

- [ ] **Step 4: Browser verification**

Using an already-logged-in dev session:
1. Open the flow editor, create a new content-domain flow.
2. Drag a "YouTube Trigger" node onto the canvas from the Sidebar — confirm it appears with the ▶️ icon.
3. Open its Inspector, paste a real YouTube channel URL (e.g. a `/@handle` URL for a channel that posts short videos), click "Watch" — confirm it resolves to a channel name and the canvas node's subtitle updates.
4. Add a condition: `duration <= 900` and `has_face == 0` — confirm both fields (`duration`, `has_face`) are selectable in the field picker.
5. Connect the trigger to an `xContentAction` node configured with `operation: create-post` and a connected X channel.
6. Publish the flow.
7. Check `link`'s logs (`wrangler tail --env dev`, filtered to `link`) for a `youtube_websub` verification log entry shortly after step 3 (confirms the WebSub subscribe+verify handshake completed).
8. If a real new video is available on the watched channel within the test window, confirm `youtube_video_ingested` appears in logs and, if conditions pass, that the X post gets created. If no new video is publishable within the test window, this end-to-end firing step may be deferred — note it explicitly rather than claiming full verification.

- [ ] **Step 5: Report status**

Summarize: tests passing (counts), dev deployment successful, which manual verification steps were completed vs. deferred (per CLAUDE.md's requirement to say so explicitly rather than claim untested success).

---

## Non-goals (carried from the spec)

- Safety-net polling as a backstop for missed WebSub notifications.
- `content_url` prop / auto-linking back to the source video from generated X posts.
- Full-video (multi-frame) face detection.
- Per-tenant BYOK YouTube API keys.
- `/c/CustomName` and `/user/LegacyName` URL resolution (only `/channel/UC...` and `@handle` are supported in Task 2 — flagged as a known v1 gap).
