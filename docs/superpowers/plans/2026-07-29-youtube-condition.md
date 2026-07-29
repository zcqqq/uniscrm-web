# YouTube Condition Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 content flow 加一个 `youtubeCondition` 节点，重新从 YouTube 拉取触发视频的当前数据并按条件分支（`true` / `false` / `failed`），让流程能表达"发布一天后再看这条视频跑得怎么样"。

**Architecture:** link 侧把已有的"取视频 → resolveProps → 解析 duration"抽成可复用函数并开一个只取数的内部路由；flow 侧新增两个纯函数（构造请求 / 由响应决定分支）并在 `executeContentActions` 里同步调用，条件求值直接复用 `engine.ts` 已导出的 `evaluateCondition`；前端加节点组件、Inspector 面板、Sidebar 项，并在保存时校验该节点必须配 YouTube Trigger。

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, React + @xyflow/react, Zustand, Vitest (`@cloudflare/vitest-pool-workers`)

## Global Constraints

- 仓库根是 `/Users/zc/Documents/UniSCRM/uniscrm-web`，所有路径相对它。**该目录才是 git 仓库**，不是它的父目录。
- **绝不 `git add -A` / `git add .`**：同一棵工作树上有其他 session 未提交的改动（当前已知 `shared/frontend/Sidebar.tsx`、`shared/frontend/sidebar-state.ts`、`web/tests/unit/sidebar-state.test.ts`）。每次 commit 只 `git add` 本任务明确列出的文件。
- **绝不 `git stash`**，绝不跨工具调用留下已 staged 未 commit 的文件。
- **不 push**，不碰 remote。全部提交留在本地 `main`。
- 不用 git worktree。
- 前端不写 inline CSS，用现有 shadcn/ui 组件与 Tailwind 类；**所有 icon 都要有 tooltip 文字**。
- 命名逐字固定：node type `youtubeCondition`；label `YouTube Condition`；description `Re-check the trigger video's current stats`；link 路由 `POST /internal/youtube/video-stats`；导出函数 `fetchYouTubeVideoProps`、`youtubeConditionRequest`、`resolveYouTubeCondition`、`VideoStatsResponse`。
- 分支 handle id 逐字为 `"true"` / `"false"` / `"failed"`。
- `failure_reason` 前缀逐字为 `video_unavailable: ` 与 `youtube_api_error: `。
- 不改 `metadata/youtube.ts`。不给这个节点标价。
- 取不到数据一律走 `failed`，绝不猜 `true`/`false`；解析不出的 duration 绝不填 0。
- 跑测试用 `npx vitest run <path>`（各模块目录下），部署一律不做 —— 本计划只到测试通过为止。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `link/src/services/pollers/youtube-content.ts` | 导出 `fetchYouTubeVideoProps`，`ingestYouTubeVideo` 改为调它 | 1 |
| `link/src/routes-internal.ts` | 新路由 `POST /internal/youtube/video-stats` | 2 |
| `link/tests/routes-internal-youtube-video-stats.test.ts` | 路由测试 | 2 |
| `flow/src/youtube-condition.ts` | 两个纯函数：构造请求、由响应定分支并合并 payload | 3 |
| `flow/tests/unit/youtube-condition.test.ts` | 纯函数测试 | 3 |
| `flow/nodeTypeRegistry.ts` | `youtubeCondition` 注册项 + sidebar 顺序 | 4 |
| `flow/src/engine.ts` | `processTargetNode` 认识 `youtubeCondition` | 5 |
| `flow/src/index.ts` | `executeContentActions` 分派 `youtubeCondition` | 5 |
| `flow/frontend/nodes/YouTubeConditionNode.tsx` | 画布节点 | 6 |
| `flow/frontend/nodes/index.ts` | 注册组件 | 6 |
| `flow/frontend/store/flow-editor.ts` | 默认 data + 连线合法性 | 6 |
| `flow/frontend/components/Sidebar.tsx` | 侧栏项 | 6 |
| `flow/frontend/components/Inspector.tsx` | 属性面板 | 7 |
| `flow/frontend/lib/validate-flow-graph.ts` | 保存时校验前置 trigger | 8 |
| `flow/frontend/pages/EditorPage.tsx` | 消费校验结果、区分文案 | 8 |

---

## Task 1: link 抽出 `fetchYouTubeVideoProps`

**Files:**
- Modify: `link/src/services/pollers/youtube-content.ts:32-51`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces: `export async function fetchYouTubeVideoProps(apiKey: string, videoId: string): Promise<Record<string, unknown> | null>` —— 返回已按 `ContentMetadata_YouTube` 的 `watch:get-videos` 映射好的 props（含 `content_url`，`duration` 仅在能解析出时存在），视频不存在/私密时返回 `null`。Task 2 会调它。

**背景：** 这段取数+映射逻辑目前内联在 `ingestYouTubeVideo` 里。抽出来是为了让新的内部路由复用同一份实现 —— "YouTube 字段怎么映射成 contentProps"全系统只能有一份，否则 metadata 改动会漏掉一边。抽取必须**行为逐字不变**，靠现有测试保证。

- [ ] **Step 1: 先跑现有测试，记录基线**

```bash
cd link && npx vitest run tests/webhook-youtube.test.ts
```

Expected: PASS。这是本任务的回归网 —— 抽取后必须仍然全绿。

- [ ] **Step 2: 抽出函数**

打开 `link/src/services/pollers/youtube-content.ts`。当前 `ingestYouTubeVideo` 开头是：

```ts
export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const item = await fetchVideoDetails(ctx.apiKey, videoId);
  if (!item) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  // Leave props.duration unset (not a fake 0) when we can't parse it — e.g. live/upcoming
  // broadcasts ("P0D") or videos over 24h. passesPropsFilter fails closed on a missing prop.
  const parsedDuration = durationIso ? parseISO8601Duration(durationIso) : null;
  if (parsedDuration !== null) {
    props.duration = parsedDuration;
  }

  const contentService = new ContentService(/* ... */);
```

把它改成（在 `ingestYouTubeVideo` **之前**插入新函数，`ingestYouTubeVideo` 开头替换为调用）：

```ts
// videos.list 的一条 item → 已按 metadata 映射好的 contentProps。ingest 路径与 flow 的
// youtubeCondition 节点（经 /internal/youtube/video-stats）共用这一份实现：字段怎么映射
// 只能有一个答案，否则 metadata 改一次得记得改两处。
// 返回 null = videos.list 没返回这个视频（已删除、转私密、id 不存在）——不是错误，是"没有"。
export async function fetchYouTubeVideoProps(
  apiKey: string,
  videoId: string
): Promise<Record<string, unknown> | null> {
  const item = await fetchVideoDetails(apiKey, videoId);
  if (!item) return null;

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  // Leave props.duration unset (not a fake 0) when we can't parse it — e.g. live/upcoming
  // broadcasts ("P0D") or videos over 24h. passesPropsFilter fails closed on a missing prop.
  const parsedDuration = durationIso ? parseISO8601Duration(durationIso) : null;
  if (parsedDuration !== null) {
    props.duration = parsedDuration;
  }
  return props;
}

export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const props = await fetchYouTubeVideoProps(ctx.apiKey, videoId);
  if (!props) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }

  const contentService = new ContentService(/* 原样不动，下面整段都不要改 */);
```

`ingestYouTubeVideo` 后半段（`const contentService = ...` 到函数结尾）**一行都不要动**。

- [ ] **Step 3: 确认没有残留的 `item` 引用**

```bash
cd link && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "youtube-content" || echo "clean"
```

Expected: `clean`（`item` 已经不在 `ingestYouTubeVideo` 作用域里，若忘了删旧代码这里会报 `Cannot find name 'item'`）。

- [ ] **Step 4: 回归测试**

```bash
cd link && npx vitest run tests/webhook-youtube.test.ts
```

Expected: PASS，与 Step 1 完全相同的结果。行为若有任何变化就说明抽取错了。

- [ ] **Step 5: Commit**

```bash
git add link/src/services/pollers/youtube-content.ts
git commit -m "refactor(link): extract fetchYouTubeVideoProps from ingestYouTubeVideo"
```

---

## Task 2: link 新增 `POST /internal/youtube/video-stats`

**Files:**
- Modify: `link/src/routes-internal.ts`（在 `/youtube/playlist-insert` 路由之后插入）
- Create: `link/tests/routes-internal-youtube-video-stats.test.ts`

**Interfaces:**
- Consumes: `fetchYouTubeVideoProps(apiKey: string, videoId: string): Promise<Record<string, unknown> | null>`（Task 1），从 `./services/pollers/youtube-content` 导入
- Produces: `POST /internal/youtube/video-stats`，请求体 `{ videoId: string }`，响应 `{ ok: true, props: Record<string, unknown> }` 或 `{ ok: false, reason: string }`，缺 `videoId` 时 HTTP 400。Task 5 的 flow 侧调它。

**背景：** 这个路由只做一件事 —— 按 videoId 取最新数据。它**不认识 flow 的条件语义**，条件求值留在 flow 侧（那样 trigger 的判定和这个节点的判定是字面上同一个函数，操作符语义不会分叉）。也不需要 channelId / OAuth：`fetchVideoDetails` 走 `YOUTUBE_API_KEY`，读操作 1 unit。

- [ ] **Step 1: 写失败的测试**

创建 `link/tests/routes-internal-youtube-video-stats.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { internalRoutes } from "../src/routes-internal";
import type { Env } from "../src/types";

// videos.list 的最小真实响应形状——字段路径必须和 metadata/youtube.ts 的 dataId 对得上，
// 否则这个测试会假绿（props 里什么都没有也算"成功"）。用真的 Response 而不是手搓假对象，
// 与 link/tests/oauth-youtube.test.ts 的既有写法一致。
function videosListResponse(item: Record<string, unknown> | null) {
  return new Response(JSON.stringify({ items: item ? [item] : [] }), { status: 200 });
}

const SAMPLE_ITEM = {
  id: "vid123",
  snippet: {
    publishedAt: "2026-07-01T00:00:00Z",
    title: "How I built it",
    description: "a description",
    thumbnails: { default: { url: "https://i.ytimg.com/vi/vid123/default.jpg" } },
  },
  contentDetails: { duration: "PT3M20S" },
  statistics: { viewCount: "12000", likeCount: "800" },
};

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/internal", internalRoutes());
  return (body: unknown) =>
    a.fetch(
      new Request("https://link.test/internal/youtube/video-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { YOUTUBE_API_KEY: "test-key" } as unknown as Env
    );
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /internal/youtube/video-stats", () => {
  it("returns props mapped by the YouTube content metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => videosListResponse(SAMPLE_ITEM)));
    const res = await app()({ videoId: "vid123" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.props.source_content_id).toBe("vid123");
    expect(body.props.title).toBe("How I built it");
    expect(body.props.view_count).toBe("12000");
    expect(body.props.like_count).toBe("800");
    // ISO8601 → 秒，证明走了 parseISO8601Duration 而不是把原串透传
    expect(body.props.duration).toBe(200);
    expect(body.props.content_url).toBe("https://www.youtube.com/watch?v=vid123");
  });

  it("reports video_unavailable when videos.list returns no item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => videosListResponse(null)));
    const res = await app()({ videoId: "gone" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason.startsWith("video_unavailable")).toBe(true);
  });

  it("reports youtube_api_error when the API call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason.startsWith("youtube_api_error")).toBe(true);
  });

  it("leaves duration unset rather than faking 0 when it cannot be parsed", async () => {
    // "P0D" = 直播/待发布，没有已知时长。填 0 会让下游条件判定得出假结论。
    vi.stubGlobal("fetch", vi.fn(async () =>
      videosListResponse({ ...SAMPLE_ITEM, contentDetails: { duration: "P0D" } })
    ));
    const res = await app()({ videoId: "vid123" });
    const body = await res.json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect("duration" in body.props).toBe(false);
  });

  it("rejects a missing videoId", async () => {
    const res = await app()({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npx vitest run tests/routes-internal-youtube-video-stats.test.ts
```

Expected: FAIL —— 路由不存在，返回 404。

- [ ] **Step 3: 实现路由**

在 `link/src/routes-internal.ts` 顶部的 import 区加：

```ts
import { fetchYouTubeVideoProps } from "./services/pollers/youtube-content";
```

在 `router.post("/youtube/playlist-insert", ...)` 那个路由的**闭合之后**插入：

```ts
  // 只取数，不判定：按 videoId 拉一次 videos.list 并按 ContentMetadata_YouTube 映射成
  // contentProps。flow 的 youtubeCondition 节点用它做"发布若干天后视频跑得怎么样"的复查，
  // 条件求值留在 flow 侧（engine.ts 的 evaluateCondition），这里不认识 flow 的条件语义。
  // 走 API key 的读操作（1 unit），不需要 channelId 或用户 OAuth。
  router.post("/youtube/video-stats", async (c) => {
    const { videoId } = await c.req.json<{ videoId?: string }>().catch(() => ({ videoId: undefined }));
    if (!videoId) return c.json({ error: "videoId required" }, 400);

    let props: Record<string, unknown> | null;
    try {
      props = await fetchYouTubeVideoProps(c.env.YOUTUBE_API_KEY, videoId);
    } catch (e) {
      console.log(JSON.stringify({ event: "youtube_video_stats_error", videoId, error: String(e) }));
      return c.json({ ok: false, reason: `youtube_api_error: ${String(e)}` });
    }
    if (!props) {
      console.log(JSON.stringify({ event: "youtube_video_stats_empty", videoId }));
      return c.json({ ok: false, reason: "video_unavailable: video not found or private" });
    }

    console.log(JSON.stringify({ event: "youtube_video_stats", videoId, view_count: props.view_count, like_count: props.like_count }));
    return c.json({ ok: true, props });
  });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npx vitest run tests/routes-internal-youtube-video-stats.test.ts
```

Expected: 5 passed。

- [ ] **Step 5: 跑 link 全量测试**

```bash
cd link && npx vitest run
```

Expected: 全绿（Task 1 的抽取 + 本任务的新路由都不该影响任何既有用例）。

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-internal.ts link/tests/routes-internal-youtube-video-stats.test.ts
git commit -m "feat(link): add /internal/youtube/video-stats for live video props"
```

---

## Task 3: flow 的两个纯函数

**Files:**
- Create: `flow/src/youtube-condition.ts`
- Create: `flow/tests/unit/youtube-condition.test.ts`

**Interfaces:**
- Consumes: `evaluateCondition(field: string, operator: string, value: string, payload: Record<string, unknown>): boolean`，已从 `flow/src/engine.ts:124` 导出
- Produces:
  - `export interface VideoStatsResponse { ok: boolean; props?: Record<string, unknown>; reason?: string }`
  - `export function youtubeConditionRequest(args: { env: { LINK_URL: string; INTERNAL_SECRET: string }; contentId: string; flowId?: string | null; payload: Record<string, unknown> }): { url: string; body: string }`
  - `export interface YouTubeConditionOutcome { branch: "true" | "false" | "failed"; payload: Record<string, unknown>; failureReason?: string }`
  - `export function resolveYouTubeCondition(conditions: { field: string; operator: string; value: string }[], payload: Record<string, unknown>, resp: VideoStatsResponse): YouTubeConditionOutcome`
  - Task 5 会在 `flow/src/index.ts` 里调这两个函数。

**背景：** 把"发什么请求"和"拿到响应后走哪个分支"与 I/O 分离，`index.ts` 已经三千多行，且本仓库现有做法就是测导出的纯 helper（见 `flow/tests/unit/dispatch-youtube-action.test.ts` 测 `youtubeActionRequest`）而不是整个 `executeContentActions`（后者需要 env/D1）。

- [ ] **Step 1: 写失败的测试**

创建 `flow/tests/unit/youtube-condition.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { youtubeConditionRequest, resolveYouTubeCondition } from "../../src/youtube-condition";

describe("youtubeConditionRequest", () => {
  it("posts the trigger video's id to link's video-stats route", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { source_content_id: "vid123", view_count: "10" },
    });
    expect(req.url).toBe("https://link/internal/youtube/video-stats");
    expect(JSON.parse(req.body)).toEqual({ videoId: "vid123", contentId: "c1", flowId: "f1" });
  });

  it("sends an empty videoId rather than 'undefined' when the payload has none", () => {
    const req = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: null,
      payload: {},
    });
    expect(JSON.parse(req.body)).toEqual({ videoId: "", contentId: "c1", flowId: null });
  });
});

describe("resolveYouTubeCondition", () => {
  const stale = { source_content_id: "vid123", view_count: "10", like_count: "1", title: "old" };
  const fresh = { source_content_id: "vid123", view_count: "12000", like_count: "800", title: "new" };

  it("takes the true branch when every condition passes against the fresh props", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1000" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
  });

  it("evaluates against the fresh values, not the trigger-time snapshot", () => {
    // stale.view_count 是 "10"，若判定读的是快照，这条 >1000 会走 false —— 那样整个节点没意义。
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1000" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
    expect(r.payload.view_count).toBe("12000");
    expect(r.payload.title).toBe("new");
  });

  it("takes the false branch when a condition fails", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "99999" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("false");
    expect(r.failureReason).toBeUndefined();
  });

  it("requires ALL conditions to pass (AND)", () => {
    const r = resolveYouTubeCondition(
      [
        { field: "view_count", operator: ">", value: "1000" },
        { field: "like_count", operator: ">", value: "99999" },
      ],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("false");
  });

  it("takes the true branch when there are no conditions at all", () => {
    const r = resolveYouTubeCondition([], stale, { ok: true, props: fresh });
    expect(r.branch).toBe("true");
  });

  it("skips half-filled rows whose field is still empty", () => {
    // Inspector 的 "+ Add" 先插一条空行，用户没选字段就保存了——不该因此判 false。
    const r = resolveYouTubeCondition(
      [{ field: "", operator: "==", value: "" }],
      stale,
      { ok: true, props: fresh }
    );
    expect(r.branch).toBe("true");
  });

  it("merges fresh props over the old payload without dropping keys the fetch didn't return", () => {
    const r = resolveYouTubeCondition(
      [],
      { ...stale, channel_id: "ch1", content_url: "https://youtu.be/vid123" },
      { ok: true, props: { view_count: "12000" } }
    );
    expect(r.payload.view_count).toBe("12000");
    expect(r.payload.channel_id).toBe("ch1");
    expect(r.payload.title).toBe("old");
  });

  it("takes the failed branch and carries link's reason when the fetch did not succeed", () => {
    const r = resolveYouTubeCondition(
      [{ field: "view_count", operator: ">", value: "1" }],
      stale,
      { ok: false, reason: "video_unavailable: video not found or private" }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("video_unavailable: video not found or private");
  });

  it("leaves the payload untouched on failure", () => {
    const r = resolveYouTubeCondition([], stale, { ok: false, reason: "youtube_api_error: boom" });
    expect(r.payload).toEqual(stale);
  });

  it("falls back to a generic reason when the failure carries none", () => {
    const r = resolveYouTubeCondition([], stale, { ok: false });
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("youtube_api_error: no reason reported");
  });

  it("treats an ok response with no props as a failure rather than guessing", () => {
    const r = resolveYouTubeCondition([], stale, { ok: true });
    expect(r.branch).toBe("failed");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd flow && npx vitest run tests/unit/youtube-condition.test.ts
```

Expected: FAIL —— `Cannot find module '../../src/youtube-condition'`。

- [ ] **Step 3: 实现**

创建 `flow/src/youtube-condition.ts`：

```ts
import { evaluateCondition } from "./engine";

export interface VideoStatsResponse {
  ok: boolean;
  props?: Record<string, unknown>;
  reason?: string;
}

export interface YouTubeConditionOutcome {
  branch: "true" | "false" | "failed";
  payload: Record<string, unknown>;
  failureReason?: string;
}

// videoId 取自 payload.source_content_id，与 youtubeActionRequest 一致（index.ts）。
// contentId/flowId 只用于 link 侧日志关联，link 不拿它们做任何判定。
export function youtubeConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload } = args;
  return {
    url: `${env.LINK_URL}/internal/youtube/video-stats`,
    body: JSON.stringify({
      videoId: String(payload?.source_content_id ?? ""),
      contentId,
      flowId: flowId ?? null,
    }),
  };
}

// 判定用刚取回的新鲜值，不用 trigger 时的快照——否则这个节点的结果与 trigger 当场判定
// 逐字相同，毫无意义。合并后的 payload 也交给下游：用户显式放了一个"重新检查"节点，
// 之后引用 $content.view_count 还拿到一天前的旧数字才是反直觉的。
// 取不到数据一律 "failed"，绝不猜 true/false——"没涨到 1000 赞"和"视频没了"是两回事。
export function resolveYouTubeCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: VideoStatsResponse
): YouTubeConditionOutcome {
  if (!resp.ok || !resp.props) {
    return {
      branch: "failed",
      payload,
      failureReason: resp.reason || "youtube_api_error: no reason reported",
    };
  }

  const merged = { ...payload, ...resp.props };
  // field 为空的半成品条目跳过——与 executeFlow 里 trigger 的 allPass 写法逐字一致。
  const allPass = (conditions || []).every(
    (c) => !c.field || evaluateCondition(c.field, c.operator, String(c.value), merged)
  );
  return { branch: allPass ? "true" : "false", payload: merged };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd flow && npx vitest run tests/unit/youtube-condition.test.ts
```

Expected: 13 passed。

- [ ] **Step 5: Commit**

```bash
git add flow/src/youtube-condition.ts flow/tests/unit/youtube-condition.test.ts
git commit -m "feat(flow): youtube-condition request builder and branch resolver"
```

---

## Task 4: 注册 `youtubeCondition` 节点类型

**Files:**
- Modify: `flow/nodeTypeRegistry.ts`（`videoCondition` 条目之后；`CONTENT_FLOW_SIDEBAR_ORDER`）
- Modify: `flow/src/generate-prompt.ts:64`
- Test: `flow/tests/unit/node-type-registry.test.ts`、`flow/tests/unit/generate-prompt.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `NODE_TYPE_REGISTRY.youtubeCondition`（`reactFlowType: "youtubeCondition"`, `label: "YouTube Condition"`, `description: "Re-check the trigger video's current stats"`, `domain: "content"`, `role: "condition"`, `generatable: true`）。Task 5-8 全都读它。

- [ ] **Step 1: 先看清现有断言，写失败的测试**

```bash
cd flow && sed -n 1,60p tests/unit/node-type-registry.test.ts
```

看清该文件的断言风格后，在其中加一个用例（放在文件里现有 `videoCondition` 相关断言旁边；若没有则追加到最后一个 `describe` 里）：

```ts
  it("registers youtubeCondition as a generatable content-domain condition", () => {
    const cfg = NODE_TYPE_REGISTRY.youtubeCondition;
    expect(cfg).toBeDefined();
    expect(cfg.reactFlowType).toBe("youtubeCondition");
    expect(cfg.role).toBe("condition");
    expect(cfg.domain).toBe("content");
    expect(cfg.generatable).toBe(true);
    expect(cfg.label).toBe("YouTube Condition");
    expect(cfg.description).toBe("Re-check the trigger video's current stats");
  });

  it("puts youtubeCondition in the content sidebar right after videoCondition", () => {
    const order = CONTENT_FLOW_SIDEBAR_ORDER;
    expect(order.indexOf("youtubeCondition")).toBe(order.indexOf("videoCondition") + 1);
  });

  it("does not offer youtubeCondition in the user-flow sidebar", () => {
    expect(USER_FLOW_SIDEBAR_ORDER).not.toContain("youtubeCondition");
  });
```

若该测试文件尚未 import `CONTENT_FLOW_SIDEBAR_ORDER` / `USER_FLOW_SIDEBAR_ORDER`，把它们加进现有的 import 语句。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd flow && npx vitest run tests/unit/node-type-registry.test.ts
```

Expected: FAIL —— `cfg` 为 `undefined`。

- [ ] **Step 3: 加注册项**

在 `flow/nodeTypeRegistry.ts` 的 `videoCondition` 条目**之后**插入：

```ts
  youtubeCondition: {
    reactFlowType: "youtubeCondition",
    label: "YouTube Condition",
    description: "Re-check the trigger video's current stats",
    domain: "content",
    role: "condition",
    generatable: true,
    promptFragment: `youtubeCondition - re-fetches the trigger video's current stats from YouTube and branches on them, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }] }
   - Requires a youtubeContentTrigger in the same flow. Put a wait node before it to check the video some time after publication (e.g. wait 1 day, then check whether it passed 10000 views).
   - Fields are the same content props youtubeContentTrigger filters on (view_count, like_count, title, duration, ...), re-read live rather than taken from the trigger-time snapshot.
   - All conditions must pass (AND) for "true"; "failed" means the video is gone/private or the API errored — never guessed.`,
  },
```

在 `CONTENT_FLOW_SIDEBAR_ORDER` 里把 `"videoCondition"` 改成 `"videoCondition", "youtubeCondition"`。

- [ ] **Step 4: 把新类型加进 content 域的 prompt 允许列表**

`flow/src/generate-prompt.ts:64` 当前是：

```
- Only use xContentTrigger, youtubeContentTrigger, wait, timeCondition, abSplit, webhook, videoCondition, and action (with actionType "xContentAction", "tiktokContentAction", or "videoAction") node types. Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
```

把 `videoCondition,` 改为 `videoCondition, youtubeCondition,`。

紧邻的第 68 行是 `- videoCondition nodes have sourceHandle "true", "false", or "failed"`；在它下面加一行：

```
- youtubeCondition nodes have sourceHandle "true", "false", or "failed"
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd flow && npx vitest run tests/unit/node-type-registry.test.ts tests/unit/generate-prompt.test.ts
```

Expected: PASS。若 `generate-prompt.test.ts` 有对 prompt 全文的快照/逐字断言而挂掉，按新增的两处把断言同步更新 —— 不要为了让测试过而回退 prompt 内容。

- [ ] **Step 6: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/src/generate-prompt.ts flow/tests/unit/node-type-registry.test.ts flow/tests/unit/generate-prompt.test.ts
git commit -m "feat(flow): register youtubeCondition node type"
```

---

## Task 5: 引擎与运行时分派

**Files:**
- Modify: `flow/src/engine.ts`（`processTargetNode`，`videoCondition` 那一支之后，约 `:444-448`）
- Modify: `flow/src/index.ts`（`executeContentActions` 里 `youtubeContentAction` 那一支之后）
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: `youtubeConditionRequest` / `resolveYouTubeCondition` / `VideoStatsResponse`（Task 3，从 `./youtube-condition` 导入）；`NODE_TYPE_REGISTRY.youtubeCondition`（Task 4）
- Produces: `ActionResult` 形如 `{ type: "youtubeCondition", nodeId: string, hasBranches: true }`，由 `executeContentActions` 消费

**背景：** 执行是**同步**的 —— `videos.list` 是一次几百毫秒的 HTTP 调用，不像 `videoCondition` 的人脸检测要拉视频跑容器，所以不进队列、不写 `content_flow_pending`。也因此 `scheduled` 里处理 pending 超时的分支判定（`index.ts` 里 `isTimedOutVideoJob` 那段）**不需要改**。

- [ ] **Step 1: 写失败的测试**

在 `flow/tests/unit/engine.test.ts` 里，`"collects a videoCondition action, defaulting operation to 'check-face' when unset"` 用例之后加：

```ts
  it("collects a youtubeCondition action with branches", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "youtubeContentTrigger", data: { channelId: "chan1", subscriptionChannelId: "sub1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "view_count", operator: ">", value: "1000" }] }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "yc1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1", subscription_channel_id: "sub1" });
    expect(result.actions).toEqual([
      { type: "youtubeCondition", nodeId: "yc1", hasBranches: true },
    ]);
    expect(result.nodeLogs.map((l) => `${l.nodeId}:${l.direction}`)).toEqual(["t1:enter", "t1:exit", "yc1:enter", "yc1:exit"]);
  });
```

再在 `"dispatches a videoCondition wired to a branch handle"` 用例之后加：

```ts
  it("dispatches a youtubeCondition wired to a branch handle", () => {
    const graph = graphWithBranchInto({
      id: "yc1", type: "youtubeCondition", data: { conditions: [] }, position: { x: 200, y: 0 },
    });
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "youtubeCondition", nodeId: "yc1", hasBranches: true },
    ]);
    expect(result.nodeLogs.map((l) => `${l.nodeId}:${l.direction}`)).toEqual(["a1:outcome", "yc1:enter", "yc1:exit"]);
  });

  it("routes each youtubeCondition branch to its own downstream node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "youtubeContentTrigger", data: { channelId: "chan1", subscriptionChannelId: "sub1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "yc1", type: "youtubeCondition", data: { conditions: [] }, position: { x: 200, y: 0 } },
        { id: "aTrue", type: "action", data: { actionType: "youtubeContentAction", operation: "rate-like" }, position: { x: 400, y: 0 } },
        { id: "aFalse", type: "action", data: { actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1" }, position: { x: 400, y: 100 } },
        { id: "aFailed", type: "webhook", data: { url: "https://example.test/hook", method: "POST" }, position: { x: 400, y: 200 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "yc1" },
        { id: "e2", source: "yc1", sourceHandle: "true", target: "aTrue" },
        { id: "e3", source: "yc1", sourceHandle: "false", target: "aFalse" },
        { id: "e4", source: "yc1", sourceHandle: "failed", target: "aFailed" },
      ],
    };
    expect(resumeFromNode(graph, "yc1", {}, "true").actions).toMatchObject([{ nodeId: "aTrue" }]);
    expect(resumeFromNode(graph, "yc1", {}, "false").actions).toMatchObject([{ nodeId: "aFalse" }]);
    expect(resumeFromNode(graph, "yc1", {}, "failed").actions).toMatchObject([{ nodeId: "aFailed" }]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: FAIL —— `result.actions` 是空数组（`processTargetNode` 不认识 `youtubeCondition`，整支静默丢弃）。

- [ ] **Step 3: 让引擎认识这个节点**

在 `flow/src/engine.ts` 的 `processTargetNode` 里，`videoCondition` 那一支**之后**插入：

```ts
  if (targetNode.type === "youtubeCondition") {
    // conditions 留在 graph 里（executeContentActions 用 nodeId 回查），不塞进 ActionResult——
    // 与 videoCondition 把 operator/threshold 留在 graph 的做法一致：阈值改了是纯配置变更。
    actions.push({ type: "youtubeCondition", nodeId: targetNode.id, hasBranches: true });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }
```

（`enter` 由 `processTargetNode` 开头统一 push，不要重复加。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd flow && npx vitest run tests/unit/engine.test.ts
```

Expected: PASS。

- [ ] **Step 5: 在 `executeContentActions` 里分派**

在 `flow/src/index.ts` 顶部 import 区加：

```ts
import { youtubeConditionRequest, resolveYouTubeCondition, type VideoStatsResponse } from "./youtube-condition";
```

在 `executeContentActions` 里 `} else if (action.type === "youtubeContentAction") { ... }` 那一支**之后**插入：

```ts
    } else if (action.type === "youtubeCondition") {
      // 同步执行：videos.list 是一次几百毫秒的读调用，不像 videoCondition 的人脸检测需要
      // 拉视频跑容器，所以不进队列、不写 content_flow_pending。
      const nodeId = action.nodeId as string;
      const conditions = ((graph.nodes.find((n) => n.id === nodeId)?.data?.conditions) as
        { field: string; operator: string; value: string }[] | undefined) || [];
      const { url, body } = youtubeConditionRequest({ env, contentId, flowId, payload });

      let resp: VideoStatsResponse;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body,
        });
        resp = res.ok
          ? (await res.json().catch(() => ({ ok: false, reason: "youtube_api_error: malformed response" })) as VideoStatsResponse)
          : { ok: false, reason: `youtube_api_error: link returned ${res.status}` };
      } catch (e) {
        resp = { ok: false, reason: `youtube_api_error: ${String(e)}` };
      }

      const outcome = resolveYouTubeCondition(conditions, payload, resp);
      console.log(JSON.stringify({ event: "content_condition_youtube", contentId, flowId: flowId || null, nodeId, branch: outcome.branch, ok: resp.ok }));

      const resumed = resumeFromNode(graph, nodeId, outcome.payload, outcome.branch, outcome.failureReason);
      if (resumed.nodeLogs.length > 0) await emitContentNodeLogs(resumed.nodeLogs, flowId || "", contentId, tenantId, env, outcome.payload);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, outcome.payload, flowId);
        rateLimited.push(...nested.rateLimited);
      }
      for (const wait of resumed.pendingWaits) {
        const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), flowId || "", wait.nodeId, contentId, Number(tenantId),
          JSON.stringify({ ...outcome.payload, channel_id: channelId }), executeAt, new Date().toISOString(),
          wait.awaitingEvent || "", wait.conditions ? JSON.stringify(wait.conditions) : ""
        ).run();
      }
```

注意：`resumed` 之后的三段（nodeLogs / nested actions / pendingWaits）一律用 `outcome.payload`，不要用原 `payload` —— 新鲜值必须传给下游。

- [ ] **Step 6: 类型检查 + flow 全量测试**

```bash
cd flow && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
npx vitest run
```

Expected: tsc 只剩仓库既有的报错（`FlowDetail.enabled` 那条是已知的既有问题，与本任务无关）；vitest 全绿。

- [ ] **Step 7: Commit**

```bash
git add flow/src/engine.ts flow/src/index.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): dispatch youtubeCondition against link's live video stats"
```

---

## Task 6: 画布节点、注册、连线、侧栏

**Files:**
- Create: `flow/frontend/nodes/YouTubeConditionNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`
- Modify: `flow/frontend/store/flow-editor.ts`（`addNode` 的 `videoCondition` 分支之后；`isValidConnection` 的两个数组，`:72-73`）
- Modify: `flow/frontend/components/Sidebar.tsx`（`videoCondition` 项之后）
- Test: `flow/tests/unit/canvas-connection-rules.test.ts`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY.youtubeCondition`（Task 4）
- Produces: 画布上可拖入、可连线的 `youtubeCondition` 节点，`addNode("youtubeCondition")` 产出 `data = { conditions: [] }`

- [ ] **Step 1: 写失败的测试**

`flow/tests/unit/canvas-connection-rules.test.ts` 已经 `import { isValidConnection } from "../../frontend/store/flow-editor"`，并在文件顶部定义了 `function node(type: string): Node` 辅助函数。在该文件的 `describe` 块里追加：

```ts
  it("allows a youtubeCondition to sit between a YouTube trigger and an action", () => {
    expect(isValidConnection(node("youtubeContentTrigger"), node("youtubeCondition"))).toBe(true);
    expect(isValidConnection(node("youtubeCondition"), node("action"))).toBe(true);
  });

  it("rejects wiring a youtubeCondition back into a trigger", () => {
    expect(isValidConnection(node("youtubeCondition"), node("youtubeContentTrigger"))).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd flow && npx vitest run tests/unit/canvas-connection-rules.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 创建画布组件**

创建 `flow/frontend/nodes/YouTubeConditionNode.tsx`：

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";

export default function YouTubeConditionNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-purple-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><YouTubeIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>YouTube</TooltipContent>
        </Tooltip>
        <span className="font-semibold text-sm text-purple-700">{NODE_TYPE_REGISTRY.youtubeCondition.label}</span>
      </div>
      <p className="text-xs text-gray-700">
        {condCount === 0 ? "No conditions" : `${condCount} condition${condCount > 1 ? "s" : ""}`}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "25%", transform: "translateY(-50%)" }}>True</span>
      <span className="absolute right-1 text-[10px] text-gray-500" style={{ top: "50%", transform: "translateY(-50%)" }}>False</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "75%", transform: "translateY(-50%)" }}>Failed</span>
      <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "25%" }} />
      <Handle type="source" position={Position.Right} id="false" className="!bg-gray-400 !w-2.5 !h-2.5" style={{ top: "50%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "75%" }} />
    </div>
  );
}
```

（`style` 里的 `top`/`transform` 是 React Flow handle 定位的既有写法，与 `VideoConditionNode.tsx` 逐字一致 —— 不是新引入的 inline CSS。）

- [ ] **Step 4: 注册组件**

`flow/frontend/nodes/index.ts`：加 `import YouTubeConditionNode from "./YouTubeConditionNode";`，并在 `nodeTypes` 里 `videoCondition: VideoConditionNode,` 之后加 `youtubeCondition: YouTubeConditionNode,`。

- [ ] **Step 5: store —— 默认数据与连线规则**

`flow/frontend/store/flow-editor.ts`：

在 `addNode` 里 `} else if (type === "videoCondition") { ... }` 之后插入：

```ts
    } else if (type === "youtubeCondition") {
      nodeType = "youtubeCondition";
      data = { conditions: [] };
```

在 `:72-73` 的两个数组末尾各加 `"youtubeCondition"`：

```ts
  const validTargets = ["action", "wait", "waitForEvent", "timeCondition", "userPropsCondition", "abSplit", "webhook", "videoCondition", "youtubeCondition"];
  const validSources = ["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger", "wait", "waitForEvent", "action", "timeCondition", "userPropsCondition", "abSplit", "webhook", "videoCondition", "youtubeCondition"];
```

- [ ] **Step 6: 侧栏项**

`flow/frontend/components/Sidebar.tsx`：在 `if (visible("videoCondition")) { ... }` 之后插入：

```tsx
  if (visible("youtubeCondition")) {
    flowControlItems.push({
      key: "youtubeCondition",
      el: <DraggableItem key="youtubeCondition" type="youtubeCondition" label={NODE_TYPE_REGISTRY.youtubeCondition.label!} description={NODE_TYPE_REGISTRY.youtubeCondition.description!} color="border-secondary bg-secondary/30" icon="📊" />,
    });
  }
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd flow && npx vitest run tests/unit/canvas-connection-rules.test.ts tests/unit/single-trigger-constraint.test.ts
```

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add flow/frontend/nodes/YouTubeConditionNode.tsx flow/frontend/nodes/index.ts flow/frontend/store/flow-editor.ts flow/frontend/components/Sidebar.tsx flow/tests/unit/canvas-connection-rules.test.ts
git commit -m "feat(flow): YouTube Condition canvas node, palette item and connection rules"
```

---

## Task 7: Inspector 面板

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`（新增 `YouTubeConditionInspector`，放在 `VideoConditionInspector` 之后；并在文件末尾的 `node.type` 分派区加一支）
- Test: `flow/tests/unit/content-trigger-fields.test.ts`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY.youtubeCondition`（Task 4）；`ConditionsEditor`（同文件内已有）；`getContentTriggerFields(metadata, sourceContentType, locale?)`（`frontend/config/trigger-fields.ts`，同文件已 import）；`ContentMetadata_YouTube`（同文件已 import）
- Produces: 选中 `youtubeCondition` 节点时右侧显示的属性面板

**背景：** 字段集**原样复用 trigger 的**（同一句 `getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")`），metadata 一行不改。唯一的区别是**不传 `systemFilters`** —— trigger 上锁着的 `duration <= 600` 是 link 入队前的摄取门槛，与一天后的复查无关。

- [ ] **Step 1: 写失败的测试**

在 `flow/tests/unit/content-trigger-fields.test.ts` 追加：

```ts
  it("offers the same YouTube content props to the condition node as to the trigger", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    const ids = fields.map((f) => f.id);
    // 这些是随时间会变、值得一天后复查的字段——少了任何一个，这个节点就没法表达核心场景。
    expect(ids).toContain("view_count");
    expect(ids).toContain("like_count");
    expect(ids).toContain("title");
    expect(ids).toContain("duration");
    // 每个字段都得有可选操作符，否则条件行渲染出来是空的下拉框。
    expect(fields.every((f) => f.operators.length > 0)).toBe(true);
  });
```

若该文件尚未 import `ContentMetadata_YouTube` / `getContentTriggerFields`，按文件现有 import 风格补上。

- [ ] **Step 2: 跑测试确认通过或失败**

```bash
cd flow && npx vitest run tests/unit/content-trigger-fields.test.ts
```

Expected: 这条大概率**直接 PASS**（字段来自既有 metadata）。它是防回归的护栏 —— 将来谁动了 `metadata/youtube.ts` 的 `contentProps`，这个节点会先在这里报警。**不要**为了"看到红色"而人为改坏代码。

- [ ] **Step 3: 加 Inspector 面板**

在 `flow/frontend/components/Inspector.tsx` 的 `VideoConditionInspector` 函数**之后**插入：

```tsx
// 与 YouTubeContentTriggerInspector 共用同一套字段与同一个 ConditionsEditor：判定语义必须
// 与 trigger 完全一致，否则用户要记两套。区别只有一个——不传 systemFilters：trigger 上锁着的
// duration <= 600 是 link 入队前的摄取门槛，与"发布一天后复查"无关。
function YouTubeConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions = (data.conditions as Condition[]) || [];

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeCondition.label}</h4>
      <div className="space-y-3">
        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          label="Content Props"
        />
        <p className="text-xs text-muted-foreground">
          Re-reads the video's current stats from YouTube. Put a Wait node before this to check it some time after publication.
        </p>
      </div>
    </div>
  );
}
```

在文件末尾的分派区，`{node.type === "videoCondition" && (...)}` 之后加：

```tsx
      {node.type === "youtubeCondition" && (
        <YouTubeConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
```

- [ ] **Step 4: 类型检查**

```bash
cd flow && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "Inspector" || echo "clean"
```

Expected: `clean`。若报 `Condition` 未定义，说明该类型名在本文件里叫别的 —— 用文件里 `ConditionsEditor` 的 `conditions` prop 实际使用的类型名。

- [ ] **Step 5: 跑 flow 全量测试**

```bash
cd flow && npx vitest run
```

Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/components/Inspector.tsx flow/tests/unit/content-trigger-fields.test.ts
git commit -m "feat(flow): YouTube Condition inspector reusing the trigger's condition editor"
```

---

## Task 8: 保存时校验必须配 YouTube Trigger

**Files:**
- Modify: `flow/frontend/lib/validate-flow-graph.ts`
- Modify: `flow/frontend/pages/EditorPage.tsx:106-112`
- Test: `flow/tests/unit/validate-flow-graph.test.ts`

**Interfaces:**
- Consumes: 无（纯图结构判断，不读 registry）
- Produces: `validateFlowGraph(nodes, edges)` 返回值扩为 `{ valid: boolean; orphanNodeIds: string[]; misplacedNodeIds: string[] }`

**背景：** 由于 `addNode` 拒绝第二个 trigger（`flow-editor.ts:113`），"前置必须有 YouTube Trigger" 等价于"这个 flow 的唯一 trigger 是 `youtubeContentTrigger`" —— 不需要图遍历判断上游可达性。Sidebar **不**做禁用/灰掉，只在保存时拦。

**注意：** 现有两条断言写的是 `toEqual({ valid: true, orphanNodeIds: [] })`，加第三个 key 会让它们挂掉。本任务必须把它们一并更新 —— 这不是"修坏测试"，是返回值契约变了。

- [ ] **Step 1: 写失败的测试**

在 `flow/tests/unit/validate-flow-graph.test.ts` 的 `describe("validateFlowGraph", ...)` 里，先把两条既有断言更新为包含新字段：

```ts
  it("is valid when there are no orphan nodes", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const edges = [{ source: "t1", target: "a1" }];
    expect(validateFlowGraph(nodes, edges)).toEqual({ valid: true, orphanNodeIds: [], misplacedNodeIds: [] });
  });

  it("is invalid and lists orphan ids when nodes are unreachable", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const result = validateFlowGraph(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.orphanNodeIds).toEqual(["a1"]);
    expect(result.misplacedNodeIds).toEqual([]);
  });
```

再追加：

```ts
  it("flags a youtubeCondition whose flow is triggered by something other than YouTube", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
    // 它是连着的——不该同时被算成孤儿，否则两条错误文案会同时弹出来
    expect(result.orphanNodeIds).toEqual([]);
  });

  it("accepts a youtubeCondition under a YouTube trigger", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.misplacedNodeIds).toEqual([]);
  });

  it("flags a youtubeCondition in a flow with no trigger at all", () => {
    const nodes = [{ id: "yc1", type: "youtubeCondition" }];
    const result = validateFlowGraph(nodes, []);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
  });

  it("flags every misplaced youtubeCondition, not just the first", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
      { id: "yc2", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }, { source: "yc1", target: "yc2" }];
    expect(validateFlowGraph(nodes, edges).misplacedNodeIds).toEqual(["yc1", "yc2"]);
  });

  it("stays quiet about flows that contain no youtubeCondition", () => {
    const nodes = [{ id: "t1", type: "xContentTrigger" }, { id: "a1", type: "action" }];
    const edges = [{ source: "t1", target: "a1" }];
    expect(validateFlowGraph(nodes, edges).misplacedNodeIds).toEqual([]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts
```

Expected: FAIL —— 返回值里没有 `misplacedNodeIds`。

- [ ] **Step 3: 实现校验**

改写 `flow/frontend/lib/validate-flow-graph.ts` 的 `validateFlowGraph`，并在它上面加新函数（`findOrphanNodeIds` 与 `TRIGGER_NODE_TYPES` 保持原样不动）：

```ts
// youtubeCondition 复查的是"触发这条流程的那个 YouTube 视频"，所以它只在 YouTube Trigger
// 开的流程里有意义。addNode 保证每个 flow 至多一个 trigger（flow-editor.ts），因此这里
// 判断唯一那个 trigger 的类型即可，不需要遍历上游可达性。
export function findMisplacedYouTubeConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const hasYouTubeTrigger = nodes.some((n) => n.type === "youtubeContentTrigger");
  if (hasYouTubeTrigger) return [];
  return nodes.filter((n) => n.type === "youtubeCondition").map((n) => n.id);
}

export function validateFlowGraph(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): { valid: boolean; orphanNodeIds: string[]; misplacedNodeIds: string[] } {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  return {
    valid: orphanNodeIds.length === 0 && misplacedNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts
```

Expected: PASS。

- [ ] **Step 5: EditorPage 消费新字段**

`flow/frontend/pages/EditorPage.tsx` 当前 Publish 按钮开头是：

```tsx
          const { nodes, edges } = useFlowEditor.getState();
          const { valid, orphanNodeIds } = validateFlowGraph(nodes, edges);
          // Always resolve against the current graph first, so a second Publish click
          // after a partial fix doesn't compound a stale highlight from the first click.
          useFlowEditor.getState().setErrorNodeIds(orphanNodeIds);
          if (!valid) {
            toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
            return;
          }
```

替换为：

```tsx
          const { nodes, edges } = useFlowEditor.getState();
          const { valid, orphanNodeIds, misplacedNodeIds } = validateFlowGraph(nodes, edges);
          // Always resolve against the current graph first, so a second Publish click
          // after a partial fix doesn't compound a stale highlight from the first click.
          useFlowEditor.getState().setErrorNodeIds([...orphanNodeIds, ...misplacedNodeIds]);
          if (!valid) {
            // 两类错误的修法完全不同（连线 vs 换 trigger），文案必须分开，否则用户会对着
            // 一个连得好好的节点找"哪里没连上"。孤儿优先——它更常见也更基础。
            toast({
              title: orphanNodeIds.length > 0
                ? `${orphanNodeIds.length} 个节点未连接，无法发布`
                : `YouTube Condition 需要 YouTube Trigger 才能工作，无法发布`,
              variant: "destructive",
            });
            return;
          }
```

- [ ] **Step 6: 类型检查 + flow 全量测试**

```bash
cd flow && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "EditorPage\|validate-flow-graph" || echo "clean"
npx vitest run
```

Expected: `clean` + 全绿。

- [ ] **Step 7: Commit**

```bash
git add flow/frontend/lib/validate-flow-graph.ts flow/frontend/pages/EditorPage.tsx flow/tests/unit/validate-flow-graph.test.ts
git commit -m "feat(flow): block publishing a YouTube Condition without a YouTube trigger"
```

---

## Task 9: 全量回归

**Files:** 无改动（除非发现回归）

- [ ] **Step 1: link 全量**

```bash
cd link && npx vitest run
```

Expected: 全绿。

- [ ] **Step 2: flow 全量**

```bash
cd flow && npx vitest run
```

Expected: 全绿。

- [ ] **Step 3: 租户隔离审计**

```bash
node scripts/tenant-scope-audit.mjs
```

Expected: 无新增的未豁免项。新加的 `/internal/youtube/video-stats` 不查数据库（只调外部 API），若审计脚本仍标记它，加 `// tenant-scope-ok: <理由>` 注释豁免，理由写明"不触库，videoId 来自调用方已鉴权的 flow 上下文"。

- [ ] **Step 4: 确认工作树只含本计划的改动**

```bash
git status --short
```

Expected: 只剩其他 session 的既有未提交文件（`shared/frontend/Sidebar.tsx`、`shared/frontend/sidebar-state.ts`、`web/tests/unit/sidebar-state.test.ts`），**不要碰它们**。本计划的文件应全部已提交。

- [ ] **Step 5: 确认提交历史**

```bash
git log --oneline -9
```

Expected: 8 个本计划的 commit，加上 spec 的 `d26472d`。

---

## 自测（部署后，由人或后续会话执行）

本计划不含部署。功能自测需要真实 dev 环境（localhost 不算完成）：

1. `cd link && npm run deploy:dev`、`cd flow && npm run deploy:dev`（**必须走 `npm run deploy:dev`**；裸 `wrangler deploy` 会打到 PROD 并剥掉 bindings，手写 `--env dev` 会跳过 vite build 发布过期前端）。
2. 在 `https://flow-dev.uni-scrm.com` 建一条 content flow：YouTube Trigger → Wait(1 minute) → YouTube Condition(`view_count > 1`) → YouTube Action(Like)。
3. 保存：应通过。把 trigger 换成 X Trigger 再保存：应弹"YouTube Condition 需要 YouTube Trigger 才能工作"，且该节点标红。
4. 发布后触发一次，在 analytics 页确认 YouTube Condition 节点有 enter/exit/outcome 记录且 outcome 是 `true`。
5. 把条件改成 `view_count > 99999999` 重跑，确认走 `false` 分支。
