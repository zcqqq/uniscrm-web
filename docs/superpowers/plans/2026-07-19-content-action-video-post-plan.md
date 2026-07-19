# Content Actions: Video Posting (X create-post, TikTok video-post) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `xContentAction`'s `create-post` operation optionally attach a video, and
add a new `tiktokContentAction` `video-post` operation — both sourced from
`$content.processed_video_url`, a payload field an upstream (not-yet-built) video
node will write.

**Architecture:** X requires a 3-step chunked upload (INIT/APPEND/FINALIZE) followed by
async STATUS polling before a `media_id` can be attached to a tweet; `flow` owns that
wait via its existing `content_flow_pending` per-minute sweep, `link` exposes stateless
upload/status endpoints. TikTok's video posting reuses its existing `PULL_FROM_URL`
fire-and-forget pattern against a different endpoint than photos.

**Tech Stack:** Hono (Cloudflare Workers), D1, Vitest + `cloudflare:test` (real D1 via
vitest-pool-workers), React (flow-editor Inspector).

## Global Constraints

- `payload` is already threaded through the whole flow-engine recursion
  (`resumeFromNode`/`collectActions`/`executeContentActions`) as the same mutable object
  reference — no engine schema change is needed for a value written into `payload` to
  reach downstream `$content.*` interpolation.
- `$content.processed_video_url` is the exact, fixed field name this plan consumes —
  never user-editable, never a dropdown of alternatives.
- X chunked media upload: `POST https://api.x.com/2/media/upload` for
  `command=INIT|APPEND|FINALIZE`; `GET https://api.x.com/2/media/upload?command=STATUS&media_id=...`
  for polling. `media_category: "tweet_video"`. Tweet creation attaches via
  `media: {media_ids: [mediaId]}` on `POST /2/tweets`.
- TikTok video posting: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
  (different from photo's `.../content/init/`), `source_info: {source: "PULL_FROM_URL",
  video_url}`. Fire-and-forget — no status polling, matching today's `photo-post`.
- Video size cap: 50MB, enforced by rejecting before/during a streamed read — never
  buffer the whole file into one `ArrayBuffer`.
- `X_CHANNEL_SCOPES` (`shared/x-scopes.ts`) gains `"media.write"` — the single source
  both `web/worker/api/oauth.ts` and `link/src/oauth.ts` read from.
- Poll ceiling for X's async STATUS: reuse the existing `retry_count < 5` pattern
  already used for rate-limit retries in `flow/src/index.ts`'s `scheduled()` sweep — no
  new threshold. The sweep runs every minute (`flow/wrangler.toml:65,112`, `crons = ["*
  * * * *"]`), so 5 retries is roughly 5 minutes of wall-clock time.
- Missing `payload.processed_video_url` when a video action actually needs it → fail
  immediately, resolve the `"failed"` branch, no network call.
- Test convention: mock `fetch` via `vi.stubGlobal("fetch", ...)`; `flow` module tests
  use real D1 via `cloudflare:test`'s `env` with by-hand `CREATE TABLE IF NOT EXISTS`
  schema (see existing `flow/tests/unit/queue-content.test.ts`,
  `scheduled-content.test.ts`); `link` module tests mock D1 via hand-rolled
  `prepare().bind().first()/.run()` stubs (see `link/tests/services/routes-internal-content.test.ts`).
- No React component test harness exists anywhere in `flow/frontend` today (confirmed:
  zero `.test.tsx` files in the `flow` module). The frontend task in this plan is
  verified via manual dev-server browser check, not new automated component tests —
  consistent with existing project practice, not a shortcut invented for this plan.
- This feature is inert end-to-end until the sibling
  `2026-07-19-video-action-add-subtitle-design.md` is separately implemented (nothing
  will ever populate `processed_video_url` until then). "Done" for every task below
  means its own tests pass — never a live click-through of the full pipeline.

---

## Task 1: Metadata + X scope + prompt-generation fixes

**Files:**
- Modify: `shared/x-scopes.ts`
- Modify: `metadata/x-byok.ts`
- Modify: `metadata/tiktok.ts`
- Modify: `flow/nodeTypeRegistry.ts:71-77` (bullets/hasAiProp), `flow/nodeTypeRegistry.ts:203-212` (tiktokContentAction promptFragment)
- Test: `link/tests/oauth.test.ts` (scope assertion)
- Test: `flow/tests/unit/node-type-registry.test.ts`
- Test: `flow/tests/unit/generate-prompt.test.ts`

**Interfaces:**
- Produces: `ContentMetadata_X` entry `"create-post"` now has `contentProps: [{propId:
  "message_text", aiType:"TEXT"}, {propId: "message_video", aiType:"VIDEO"}]`.
  `ContentMetadata_TikTok` gains a `"video-post"` entry (`flowType: "action"`,
  `contentProps: [{propId:"title",...,aiType:"TEXT"}, {propId:"description",...,aiType:"TEXT"}]`,
  no video prop). `X_CHANNEL_SCOPES` includes `"media.write"`.
- Consumes: nothing from other tasks (this is the foundation task).

- [ ] **Step 1: Write the failing test for the X scope**

Add to `link/tests/oauth.test.ts`, near the top after the existing imports (this file
already does `export { X_CHANNEL_SCOPES }` from `link/src/oauth.ts:14`):

```ts
describe("X_CHANNEL_SCOPES", () => {
  it("includes media.write (required for attaching video to a tweet)", async () => {
    const { X_CHANNEL_SCOPES } = await import("../src/oauth");
    expect(X_CHANNEL_SCOPES).toContain("media.write");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/oauth.test.ts -t "X_CHANNEL_SCOPES"`
Expected: FAIL — `expected [...] to include 'media.write'`

- [ ] **Step 3: Add the scope**

In `shared/x-scopes.ts`:

```ts
// x既可以注册账号、也要授权应用，所以scope放到shared
export const X_CHANNEL_SCOPES = [
  "tweet.read", "tweet.write", "users.read", "follows.read", "follows.write",
  "dm.read", "dm.write", "like.read", "list.read", "space.read",
  "bookmark.read", "mute.read", "mute.write", "offline.access",
  "media.write",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/oauth.test.ts -t "X_CHANNEL_SCOPES"`
Expected: PASS

- [ ] **Step 5: Write the failing test for the new metadata entries**

Add to `flow/tests/unit/node-type-registry.test.ts` (this file already imports
`ContentMetadata_X`/`ContentMetadata_TikTok` and `NODE_TYPE_REGISTRY` — follow the
existing `describe`/`it` blocks' style at lines 105-136):

```ts
it("create-post's contentProps include an optional VIDEO-aiType prop (message_video), alongside the existing TEXT prop", () => {
  const createPost = ContentMetadata_X.find((m) => m.sourceContentType === "create-post")!;
  expect(createPost.contentProps).toEqual([
    { propId: "message_text", aiType: "TEXT" },
    { propId: "message_video", aiType: "VIDEO" },
  ]);
});

it("xContentAction's AI-generation-guidance bullet check only fires for TEXT/IMAGE aiType props, not VIDEO — create-post (TEXT+VIDEO) still gets the AI-generation suffix from its TEXT prop", () => {
  const fragment = NODE_TYPE_REGISTRY.xContentAction.promptFragment!;
  expect(fragment).toContain('operation "create-post": Publish a new post via the triggering channel — prompt = free-text instructions for AI generation, left blank for the user to fill in.');
});

it("ContentMetadata_TikTok has a video-post action entry distinct from photo-post, with only TEXT contentProps (video is implicit, not a toggle)", () => {
  const videoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video-post")!;
  expect(videoPost.flowType).toBe("action");
  expect(videoPost.contentProps).toEqual([
    { propId: "title", dataId: "post_info.title", aiType: "TEXT" },
    { propId: "description", dataId: "post_info.description", aiType: "TEXT" },
  ]);
});

it("tiktokContentAction's promptFragment is derived from ContentMetadata_TikTok's action entries (not hand-typed), and documents both photo-post and video-post", () => {
  const fragment = NODE_TYPE_REGISTRY.tiktokContentAction.promptFragment!;
  const photoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "photo-post")!;
  const videoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video-post")!;
  expect(fragment).toContain(photoPost.description!.en);
  expect(fragment).toContain(videoPost.description!.en);
  expect(fragment).toContain('operation: "photo-post"|"video-post"');
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts`
Expected: FAIL (metadata entries and promptFragment text don't exist yet)

- [ ] **Step 7: Add `message_video` to `create-post` in `metadata/x-byok.ts`**

Replace the existing `create-post` entry (currently at the end of the file):

```ts
  {
    sourceContentType: "create-post", // https://docs.x.com/x-api/posts/create-post
    flowType: "action",
    price:0.010,
    label: {"en":"Create Post", "zh":"发推文"},
    description: {"en":"Publish a new post via the triggering channel", "zh":"通过触发该内容的账号发布新推文"},
    contentProps: [
      {propId: "message_text", aiType:"TEXT"},
      {propId: "message_video", aiType:"VIDEO"},
    ],
  },
```

- [ ] **Step 8: Add the `video-post` entry to `metadata/tiktok.ts`**

Append after the existing `photo-post` entry, before the closing `];`:

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

- [ ] **Step 9: Narrow the `hasAiProp` check in `flow/nodeTypeRegistry.ts:71-77`**

Current code:

```ts
const CONTENT_X_ACTION_BULLETS = CONTENT_X_ACTION_ENTRIES.map((m) => {
  const hasAiProp = m.contentProps.some((p) => p.aiType);
  const guidance = hasAiProp
    ? "prompt = free-text instructions for AI generation, left blank for the user to fill in."
    : "needs no additional fields; leave prompt/provider at these defaults.";
  return `   - operation "${m.sourceContentType}": ${m.description!.en} — ${guidance}`;
}).join("\n");
```

Replace with:

```ts
const CONTENT_X_ACTION_BULLETS = CONTENT_X_ACTION_ENTRIES.map((m) => {
  // Only TEXT/IMAGE aiType props mean "AI generates this from a prompt" — VIDEO means
  // "optionally attach $content.processed_video_url", never AI-generated, never prompted.
  const hasAiProp = m.contentProps.some((p) => p.aiType === "TEXT" || p.aiType === "IMAGE");
  const guidance = hasAiProp
    ? "prompt = free-text instructions for AI generation, left blank for the user to fill in."
    : "needs no additional fields; leave prompt/provider at these defaults.";
  return `   - operation "${m.sourceContentType}": ${m.description!.en} — ${guidance}`;
}).join("\n");
```

- [ ] **Step 10: Derive `tiktokContentAction`'s promptFragment from metadata**

Current code at `flow/nodeTypeRegistry.ts:203-212`:

```ts
  tiktokContentAction: {
    reactFlowType: "action",
    label: "TikTok Action",
    description: "Generate images + caption and send to TikTok as a draft",
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For TikTok photo-post actions: data: { actionType: "tiktokContentAction", channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - ${ContentMetadata_TikTok.find((m) => m.sourceContentType === "photo-post")!.description!.en} Leave all fields at these defaults for the user to configure via the Inspector.`,
  },
```

Add these two derivation constants right after `CONTENT_X_ACTION_BULLETS` (near line
77, before `export const CONTENT_X_TRIGGER_MODE_LIST_POSTS`):

```ts
const CONTENT_TIKTOK_ACTION_ENTRIES = ContentMetadata_TikTok.filter((m) => m.flowType === "action");
const CONTENT_TIKTOK_ACTION_OPERATIONS = CONTENT_TIKTOK_ACTION_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");
const CONTENT_TIKTOK_ACTION_BULLETS = CONTENT_TIKTOK_ACTION_ENTRIES.map((m) => {
  return `   - operation "${m.sourceContentType}": ${m.description!.en}`;
}).join("\n");
```

Then replace the `tiktokContentAction` entry with:

```ts
  tiktokContentAction: {
    reactFlowType: "action",
    label: "TikTok Action",
    description: `${CONTENT_TIKTOK_ACTION_ENTRIES.length} actions`,
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For TikTok content actions: data: { actionType: "tiktokContentAction", operation: ${CONTENT_TIKTOK_ACTION_OPERATIONS}, channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - Leave all fields at these defaults for the user to configure via the Inspector. imageCount/imageProvider/imageSkillId only apply to "photo-post".
${CONTENT_TIKTOK_ACTION_BULLETS}`,
  },
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts tests/unit/generate-prompt.test.ts`
Expected: PASS — all tests in both files, including the pre-existing ones (the
`generatableKeysForDomain("content")` test at line 187-194 doesn't change since
`tiktokContentAction` was already in that list).

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: PASS — all tests in the file (no regressions).

- [ ] **Step 12: Commit**

```bash
git add shared/x-scopes.ts metadata/x-byok.ts metadata/tiktok.ts flow/nodeTypeRegistry.ts link/tests/oauth.test.ts flow/tests/unit/node-type-registry.test.ts
git commit -m "feat: add media.write X scope and video-post metadata for TikTok/X content actions"
```

---

## Task 2: X chunked media upload service functions

**Files:**
- Modify: `link/src/services/x-posts-api.ts`
- Test: `link/tests/services/x-posts-api.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (for Task 4/5 to call):
  - `initMediaUpload(accessToken: string, totalBytes: number, mediaType: string): Promise<{ok: true, mediaId: string} | {ok: false}>`
  - `appendMediaChunk(accessToken: string, mediaId: string, segmentIndex: number, chunk: Uint8Array): Promise<{ok: boolean}>`
  - `finalizeMediaUpload(accessToken: string, mediaId: string): Promise<{ok: true, state: string, checkAfterSecs?: number} | {ok: false}>`
  - `getMediaUploadStatus(accessToken: string, mediaId: string): Promise<{ok: true, state: string, checkAfterSecs?: number} | {ok: false}>`
  - `createPost(accessToken: string, text: string, mediaId?: string): Promise<CreatePostResult>` (existing function, extended — signature is backward compatible, `mediaId` optional)

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/services/x-posts-api.test.ts` (follow the exact mocking pattern
already in this file: `vi.fn()` + `vi.stubGlobal("fetch", ...)` in `beforeEach`,
`vi.unstubAllGlobals()` in `afterEach`, responses built as real `Response` objects):

```ts
import { initMediaUpload, appendMediaChunk, finalizeMediaUpload, getMediaUploadStatus, createPost } from "../../src/services/x-posts-api";

describe("initMediaUpload", () => {
  it("posts command=INIT with total_bytes/media_type/media_category and returns the media_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "media-1", media_key: "mk-1", expires_after_secs: 86400 } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await initMediaUpload("access-token-1", 1048576, "video/mp4");

    expect(result).toEqual({ ok: true, mediaId: "media-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/media/upload");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ command: "INIT", media_type: "video/mp4", total_bytes: 1048576, media_category: "tweet_video" });
    vi.unstubAllGlobals();
  });

  it("returns ok: false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 400 })));
    const result = await initMediaUpload("access-token-1", 1048576, "video/mp4");
    expect(result).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});

describe("appendMediaChunk", () => {
  it("posts command=APPEND with the media_id/segment_index/chunk and returns ok: true on 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const chunk = new Uint8Array([1, 2, 3]);
    const result = await appendMediaChunk("access-token-1", "media-1", 0, chunk);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/media/upload");
    expect(init.method).toBe("POST");
    const formData = init.body as FormData;
    expect(formData.get("command")).toBe("APPEND");
    expect(formData.get("media_id")).toBe("media-1");
    expect(formData.get("segment_index")).toBe("0");
    expect(formData.get("media")).toBeInstanceOf(Blob);
    vi.unstubAllGlobals();
  });

  it("returns ok: false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 400 })));
    const result = await appendMediaChunk("access-token-1", "media-1", 0, new Uint8Array([1]));
    expect(result).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});

describe("finalizeMediaUpload", () => {
  it("posts command=FINALIZE and returns the processing state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "pending", check_after_secs: 5 } } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeMediaUpload("access-token-1", "media-1");

    expect(result).toEqual({ ok: true, state: "pending", checkAfterSecs: 5 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ command: "FINALIZE", media_id: "media-1" });
    vi.unstubAllGlobals();
  });

  it("returns state: succeeded with no checkAfterSecs when processing_info is absent (small/simple media)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 })));
    const result = await finalizeMediaUpload("access-token-1", "media-1");
    expect(result).toEqual({ ok: true, state: "succeeded" });
    vi.unstubAllGlobals();
  });

  it("returns ok: false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 400 })));
    const result = await finalizeMediaUpload("access-token-1", "media-1");
    expect(result).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});

describe("getMediaUploadStatus", () => {
  it("gets command=STATUS with the media_id and returns the processing state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "succeeded" } } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getMediaUploadStatus("access-token-1", "media-1");

    expect(result).toEqual({ ok: true, state: "succeeded" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/media/upload?command=STATUS&media_id=media-1");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    vi.unstubAllGlobals();
  });

  it("returns ok: false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("error", { status: 400 })));
    const result = await getMediaUploadStatus("access-token-1", "media-1");
    expect(result).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});

describe("createPost with media", () => {
  it("includes media.media_ids in the body when mediaId is passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "tweet-1", text: "hello" } }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPost("access-token-1", "hello", "media-1");

    expect(result).toEqual({ ok: true, id: "tweet-1" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: "hello", media: { media_ids: ["media-1"] } });
    vi.unstubAllGlobals();
  });

  it("omits media when mediaId is not passed (existing text-only behavior, unchanged)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "tweet-2", text: "hi" } }), { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await createPost("access-token-1", "hi");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: "hi" });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: FAIL — `initMediaUpload`/`appendMediaChunk`/`finalizeMediaUpload`/
`getMediaUploadStatus` are not exported yet; `createPost` with media fails on the body
shape.

- [ ] **Step 3: Implement the chunked upload functions and extend `createPost`**

Add to `link/src/services/x-posts-api.ts` (after the existing `CreatePostResult`
interface, before the existing `createPost` function):

```ts
export interface MediaUploadResult {
  ok: boolean;
  mediaId?: string;
}

// https://docs.x.com/x-api/media/quickstart/media-upload-chunked
export async function initMediaUpload(accessToken: string, totalBytes: number, mediaType: string): Promise<MediaUploadResult> {
  const res = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "INIT", media_type: mediaType, total_bytes: totalBytes, media_category: "tweet_video" }),
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { data: { id: string } };
  return { ok: true, mediaId: body.data.id };
}

export async function appendMediaChunk(accessToken: string, mediaId: string, segmentIndex: number, chunk: Uint8Array): Promise<{ ok: boolean }> {
  const form = new FormData();
  form.set("command", "APPEND");
  form.set("media_id", mediaId);
  form.set("segment_index", String(segmentIndex));
  form.set("media", new Blob([chunk]));

  const res = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  return { ok: res.ok };
}

export interface MediaProcessingResult {
  ok: boolean;
  state?: string;
  checkAfterSecs?: number;
}

export async function finalizeMediaUpload(accessToken: string, mediaId: string): Promise<MediaProcessingResult> {
  const res = await fetch("https://api.x.com/2/media/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: "FINALIZE", media_id: mediaId }),
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { data: { processing_info?: { state: string; check_after_secs?: number } } };
  const info = body.data.processing_info;
  if (!info) return { ok: true, state: "succeeded" };
  return { ok: true, state: info.state, checkAfterSecs: info.check_after_secs };
}

export async function getMediaUploadStatus(accessToken: string, mediaId: string): Promise<MediaProcessingResult> {
  const res = await fetch(`https://api.x.com/2/media/upload?command=STATUS&media_id=${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ok: false };
  const body = (await res.json()) as { data: { processing_info?: { state: string; check_after_secs?: number } } };
  const info = body.data.processing_info;
  if (!info) return { ok: true, state: "succeeded" };
  return { ok: true, state: info.state, checkAfterSecs: info.check_after_secs };
}
```

Replace the existing `createPost` function:

```ts
export async function createPost(accessToken: string, text: string, mediaId?: string): Promise<CreatePostResult> {
  const body: { text: string; media?: { media_ids: string[] } } = { text };
  if (mediaId) body.media = { media_ids: [mediaId] };

  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    return { ok: false };
  }

  const respBody = (await res.json()) as { data: { id: string; text: string } };
  return { ok: true, id: respBody.data.id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: PASS — all tests in the file, including pre-existing ones (unchanged).

- [ ] **Step 5: Commit**

```bash
git add link/src/services/x-posts-api.ts link/tests/services/x-posts-api.test.ts
git commit -m "feat: add X chunked media upload functions and media_ids support to createPost"
```

---

## Task 3: TikTok `initVideoPost` service function

**Files:**
- Modify: `link/src/services/tiktok-publish.ts`
- Test: `link/tests/services/tiktok-publish.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (for Task 6 to call): `initVideoPost(accessToken: string, videoUrl: string, title: string, description: string): Promise<{ok: true, publishId?: string, rateLimited?: boolean} | {ok: false, rateLimited?: boolean}>`

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/services/tiktok-publish.test.ts`, mirroring the exact
`describe("initPhotoPost", ...)` block already in this file:

```ts
import { initPhotoPost, initVideoPost } from "../../src/services/tiktok-publish";

describe("initVideoPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls TikTok's video-post init endpoint with PULL_FROM_URL and returns ok + publishId on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await initVideoPost("access-token-1", "https://content-dev.uni-scrm.com/public/media/vid-key", "My Title", "My description");

    expect(result).toEqual({ ok: true, publishId: "pub-vid-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      post_info: { title: "My Title", description: "My description" },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: "https://content-dev.uni-scrm.com/public/media/vid-key",
      },
    });
  });

  it("returns rateLimited: true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "" } }), { status: 429 })
    ));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4", "T", "D");
    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok: false for any other error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_param", message: "" } }), { status: 400 })
    ));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4", "T", "D");
    expect(result).toEqual({ ok: false });
  });

  it("returns ok: false when response body is not valid JSON, even with 2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const result = await initVideoPost("access-token-1", "https://x/video.mp4", "T", "D");
    expect(result).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/tiktok-publish.test.ts`
Expected: FAIL — `initVideoPost` is not exported yet.

- [ ] **Step 3: Implement `initVideoPost`**

Append to `link/src/services/tiktok-publish.ts`:

```ts
export async function initVideoPost(
  accessToken: string,
  videoUrl: string,
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }> {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      post_info: { title, description },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: videoUrl,
      },
    }),
  });

  const rawText = await res.text();
  let body: { data?: { publish_id?: string }; error?: { code: string; message: string } } | undefined;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = undefined;
  }

  if (body === undefined) {
    return { ok: false };
  }

  const errorCode = body?.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok || (errorCode && errorCode !== "ok")) {
    return { ok: false };
  }

  return { ok: true, publishId: body?.data?.publish_id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/tiktok-publish.test.ts`
Expected: PASS — all tests, including pre-existing `initPhotoPost` ones (unchanged).

- [ ] **Step 5: Commit**

```bash
git add link/src/services/tiktok-publish.ts link/tests/services/tiktok-publish.test.ts
git commit -m "feat: add TikTok initVideoPost service function"
```

---

## Task 4: `link` route — extend `POST /internal/content/create-post` for video

**Files:**
- Modify: `link/src/routes-internal.ts` (the `/content/create-post` route, currently lines ~287-343)
- Test: `link/tests/services/routes-internal-content.test.ts`

**Interfaces:**
- Consumes: `initMediaUpload`, `appendMediaChunk`, `finalizeMediaUpload`, `createPost`
  from Task 2 (`link/src/services/x-posts-api.ts`).
- Produces (for Task 8 to call): `POST /internal/content/create-post` now accepts an
  optional `videoUrl: string` in its request body. Response shapes:
  - `{ok: true, id: string}` — text-only, or video finalized as `"succeeded"`
    immediately.
  - `{ok: false}` — any failure (unchanged from today).
  - `{ok: false, rateLimited: true, rateLimitReset: string}` — unchanged from today.
  - **New**: `{pending: true, mediaId: string, channelId: string, text: string, checkAfterSecs: number}` —
    video FINALIZE returned `pending`/`in_progress`; caller must poll (Task 5's
    endpoint) later. `channelId`/`text` are echoed back so the caller (Task 8) doesn't
    need to remember them separately.

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/services/routes-internal-content.test.ts`, in the same
`describe`/`it` block area as the existing `/internal/content/create-post` tests
(around line 273), reusing the file's existing `mockLinkDb`/`mockWebDb`/`testEnv`
helpers:

```ts
it("POST /internal/content/create-post with videoUrl under 50MB uploads to X and posts with media_ids when processing succeeds immediately", async () => {
  const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
  tenantDataDbRunMock.mockClear();

  const videoBytes = new Uint8Array(1024); // tiny, well under 50MB
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
    if (u === "https://content-dev.uni-scrm.com/public/media/vid-1") {
      return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length), "Content-Type": "video/mp4" } });
    }
    if (u === "https://api.x.com/2/media/upload" && init?.method === "POST") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.command === "INIT") return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 });
      if (body?.command === "FINALIZE") return new Response(JSON.stringify({ data: { id: "media-1" } }), { status: 200 }); // no processing_info -> succeeded
      // APPEND (FormData body)
      return new Response(null, { status: 204 });
    }
    if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ data: { id: "tweet-vid-1", text: "caption text" } }), { status: 201 });
    throw new Error(`Unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const res = await worker.fetch(
    new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
      body: JSON.stringify({
        contentId: "content-vid-1", interpolatedPrompt: "raw prompt", provider: "default",
        channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
        videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-1",
      }),
    }),
    { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
  );

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, id: "tweet-vid-1" });

  const tweetCall = fetchMock.mock.calls.find(([u]: [string]) => u === "https://api.x.com/2/tweets");
  const tweetBody = JSON.parse(tweetCall![1].body as string);
  expect(tweetBody).toEqual({ text: "caption text", media: { media_ids: ["media-1"] } });
  vi.unstubAllGlobals();
});

it("POST /internal/content/create-post with videoUrl returns pending:true when X reports processing still in progress", async () => {
  const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

  const videoBytes = new Uint8Array(1024);
  const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
    if (u === "https://content-dev.uni-scrm.com/public/media/vid-2") {
      return new Response(videoBytes, { status: 200, headers: { "Content-Length": String(videoBytes.length) } });
    }
    if (u === "https://api.x.com/2/media/upload" && init?.method === "POST") {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.command === "INIT") return new Response(JSON.stringify({ data: { id: "media-2" } }), { status: 200 });
      if (body?.command === "FINALIZE") return new Response(JSON.stringify({ data: { id: "media-2", processing_info: { state: "pending", check_after_secs: 5 } } }), { status: 200 });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const res = await worker.fetch(
    new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
      body: JSON.stringify({
        contentId: "content-vid-2", interpolatedPrompt: "raw prompt", provider: "default",
        channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
        videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-2",
      }),
    }),
    { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
  );

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ pending: true, mediaId: "media-2", channelId: "tgt-chan", text: "caption text", checkAfterSecs: 5 });
  vi.unstubAllGlobals();
});

it("POST /internal/content/create-post rejects a videoUrl reporting over 50MB via Content-Length without uploading anything to X", async () => {
  const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };

  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes("/internal/generate")) return new Response(JSON.stringify({ text: "caption text" }), { status: 200 });
    if (u === "https://content-dev.uni-scrm.com/public/media/vid-big") {
      return new Response(new Uint8Array(0), { status: 200, headers: { "Content-Length": String(60 * 1024 * 1024) } });
    }
    throw new Error(`Unexpected fetch to X: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const res = await worker.fetch(
    new Request("https://link-dev.uni-scrm.com/internal/content/create-post", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
      body: JSON.stringify({
        contentId: "content-vid-big", interpolatedPrompt: "raw prompt", provider: "default",
        channelId: "tgt-chan", flowId: "flow-1", skillId: "none",
        videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-big",
      }),
    }),
    { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
  );

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: false });
  expect(fetchMock.mock.calls.some(([u]: [string]) => String(u).includes("api.x.com"))).toBe(false);
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: FAIL — the route doesn't read `videoUrl` yet.

- [ ] **Step 3: Implement the video path in the route**

In `link/src/routes-internal.ts`, update the imports:

```ts
import { createPost, repostPost, createBookmark, likePost, initMediaUpload, appendMediaChunk, finalizeMediaUpload } from "./services/x-posts-api";
```

Add a helper above `internalRoutes()` (after the `ACTION_TO_EVENT_TYPE` const):

```ts
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_CHUNK_BYTES = 5 * 1024 * 1024;

async function uploadVideoToX(
  accessToken: string,
  videoUrl: string
): Promise<{ ok: true; mediaId: string; state: string; checkAfterSecs?: number } | { ok: false }> {
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok || !videoRes.body) return { ok: false };

  const contentLength = Number(videoRes.headers.get("Content-Length") || "0");
  if (contentLength > MAX_VIDEO_BYTES) return { ok: false };

  const contentType = videoRes.headers.get("Content-Type") || "video/mp4";
  const init = await initMediaUpload(accessToken, contentLength, contentType);
  if (!init.ok || !init.mediaId) return { ok: false };

  const reader = videoRes.body.getReader();
  let segmentIndex = 0;
  let buffered: Uint8Array = new Uint8Array(0);
  let totalRead = 0;

  const flush = async (chunk: Uint8Array): Promise<boolean> => {
    const appendResult = await appendMediaChunk(accessToken, init.mediaId!, segmentIndex, chunk);
    segmentIndex++;
    return appendResult.ok;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      totalRead += value.length;
      if (totalRead > MAX_VIDEO_BYTES) return { ok: false };
      const combined = new Uint8Array(buffered.length + value.length);
      combined.set(buffered, 0);
      combined.set(value, buffered.length);
      buffered = combined;
      while (buffered.length >= VIDEO_CHUNK_BYTES) {
        const toSend = buffered.slice(0, VIDEO_CHUNK_BYTES);
        if (!(await flush(toSend))) return { ok: false };
        buffered = buffered.slice(VIDEO_CHUNK_BYTES);
      }
    }
    if (done) break;
  }
  if (buffered.length > 0) {
    if (!(await flush(buffered))) return { ok: false };
  }

  const final = await finalizeMediaUpload(accessToken, init.mediaId!);
  if (!final.ok || !final.state) return { ok: false };
  return { ok: true, mediaId: init.mediaId!, state: final.state, checkAfterSecs: final.checkAfterSecs };
}
```

First, update the route's existing top-level destructuring (the line reading `const {
contentId, interpolatedPrompt, provider, channelId, flowId, skillId } = await
c.req.json<{...}>();`) to also read `videoUrl`:

```ts
    const { contentId, interpolatedPrompt, provider, channelId, flowId, skillId, videoUrl } = await c.req.json<{
      contentId: string; interpolatedPrompt: string; provider: "default" | "openai" | "anthropic" | "none"; channelId: string; flowId?: string | null; skillId?: string; videoUrl?: string;
    }>();
```

Then replace the body of the `/content/create-post` route from `const tokenService =
new XTokenService(...)` through the final `return c.json({ ok: true })` (keep the
route registration, generation step, and tenant-row lookup above this point exactly as
they are today):

```ts
    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);

    let mediaId: string | undefined;
    if (videoUrl) {
      const upload = await uploadVideoToX(accessToken, videoUrl);
      if (!upload.ok) {
        console.error(JSON.stringify({ event: "create_post_video_upload_failed", contentId, channelId }));
        return c.json({ ok: false }, 200);
      }
      if (upload.state === "succeeded") {
        mediaId = upload.mediaId;
      } else {
        console.log(JSON.stringify({ event: "create_post_video_pending", contentId, channelId, mediaId: upload.mediaId, state: upload.state }));
        return c.json({ pending: true, mediaId: upload.mediaId, channelId, text, checkAfterSecs: upload.checkAfterSecs ?? 60 });
      }
    }

    const postResult = await createPost(accessToken, text, mediaId);

    console.log(JSON.stringify({ event: "create_post_x_post", contentId, channelId, provider, ok: postResult.ok, rateLimited: !!postResult.rateLimited }));

    if (postResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!postResult.ok || !postResult.id) {
      return c.json({ ok: false }, 200);
    }

    const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
    const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, channel.tenant_id);
    await contentService.recordPublishedContent(channelId, "X", postResult.id, text, {
      generatedFromContentId: contentId,
      flowId: flowId || "",
    });

    return c.json({ ok: true, id: postResult.id });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: PASS — all tests, including the pre-existing text-only `create-post` tests
(unchanged — `videoUrl` is optional and absent in those requests).

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts
git commit -m "feat: support video upload in POST /internal/content/create-post"
```

---

## Task 5: `link` route — new `POST /internal/content/x-video-status`

**Files:**
- Modify: `link/src/routes-internal.ts` (new route)
- Test: `link/tests/services/routes-internal-content.test.ts`

**Interfaces:**
- Consumes: `getMediaUploadStatus`, `createPost` from Task 2. `mockLinkDb` from the
  existing test file.
- Produces (for Task 10's sweep to call): `POST /internal/content/x-video-status` body
  `{channelId, mediaId, text, contentId, flowId}` → `{ok: true, id: string}` (posted),
  `{ok: false}` (terminal failure), or `{pending: true, checkAfterSecs: number}` (still
  processing).

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/services/routes-internal-content.test.ts`:

```ts
describe("POST /internal/content/x-video-status", () => {
  it("posts the tweet and records content when status is succeeded", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
    tenantDataDbRunMock.mockClear();

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("command=STATUS")) return new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "succeeded" } } }), { status: 200 });
      if (u === "https://api.x.com/2/tweets") return new Response(JSON.stringify({ data: { id: "tweet-status-1", text: "caption text" } }), { status: 201 });
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "tweet-status-1" });
    expect(tenantDataDbRunMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("returns pending:true with checkAfterSecs when status is still processing", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "in_progress", check_after_secs: 10 } } }), { status: 200 })
    ));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: true, checkAfterSecs: 10 });
    vi.unstubAllGlobals();
  });

  it("returns ok:false when status is failed", async () => {
    const channelRow = { config: JSON.stringify({ x_user_id: "x-user-1", access_token: "tok", refresh_token: null }), channel_type: "X", tenant_id: 1 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "media-1", processing_info: { state: "failed" } } }), { status: 200 })
    ));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/x-video-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "tgt-chan", mediaId: "media-1", text: "caption text", contentId: "content-1", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts -t "x-video-status"`
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Implement the route**

Add to `link/src/routes-internal.ts`, update the import line from Task 4 to also
include `getMediaUploadStatus`:

```ts
import { createPost, repostPost, createBookmark, likePost, initMediaUpload, appendMediaChunk, finalizeMediaUpload, getMediaUploadStatus } from "./services/x-posts-api";
```

Add the new route, right after the `/content/create-post` route's closing `});`:

```ts
  router.post("/content/x-video-status", async (c) => {
    const { channelId, mediaId, text, contentId, flowId } = await c.req.json<{
      channelId: string; mediaId: string; text: string; contentId: string; flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!channel || channel.channel_type !== "X") return c.json({ ok: false }, 200);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);
    const status = await getMediaUploadStatus(accessToken, mediaId);

    if (!status.ok || status.state === "failed") {
      console.log(JSON.stringify({ event: "x_video_status_failed", contentId, channelId, mediaId }));
      return c.json({ ok: false }, 200);
    }
    if (status.state !== "succeeded") {
      return c.json({ pending: true, checkAfterSecs: status.checkAfterSecs ?? 60 });
    }

    const postResult = await createPost(accessToken, text, mediaId);
    console.log(JSON.stringify({ event: "x_video_status_post", contentId, channelId, ok: postResult.ok }));
    if (!postResult.ok || !postResult.id) {
      return c.json({ ok: false }, 200);
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(channel.tenant_id).first<{ d1_database_id: string | null }>();
    if (tenantRow?.d1_database_id) {
      const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
      const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, channel.tenant_id);
      await contentService.recordPublishedContent(channelId, "X", postResult.id, text, {
        generatedFromContentId: contentId,
        flowId: flowId || "",
      });
    }

    return c.json({ ok: true, id: postResult.id });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts
git commit -m "feat: add stateless POST /internal/content/x-video-status endpoint"
```

---

## Task 6: `link` route — new `POST /internal/tiktok/video-post`

**Files:**
- Modify: `link/src/routes-internal.ts` (new route)
- Test: `link/tests/services/routes-internal-tiktok-video-post.test.ts` (new file)

**Interfaces:**
- Consumes: `initVideoPost` from Task 3.
- Produces (for Task 9 to call): `POST /internal/tiktok/video-post` body `{contentId,
  channelId, prompts: {title, description}, textProvider, textSkillId, videoUrl,
  flowId}` → `{ok: boolean, rateLimited?: boolean, rateLimitReset?: string}`.

- [ ] **Step 1: Write the failing tests**

Create `link/tests/services/routes-internal-tiktok-video-post.test.ts`, copying the
imports/mock scaffold (`tenantDataDbRunMock`, `TenantDataDB` mock, `mockWebDb`,
`mockLinkDb`, `worker`, `testSecret`, `testEnv`) exactly from
`link/tests/services/routes-internal-tiktok-photo-post.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

const tenantDataDbRunMock = vi.fn().mockResolvedValue({ changes: 1 });

vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query() { return Promise.resolve([]); }
    run(...args: unknown[]) { return tenantDataDbRunMock(...args); }
  },
}));

function mockWebDb(d1DatabaseId: string | null) {
  return { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null),
  }) }) };
}

function mockLinkDb(channelRow: { config: string; channel_type: string; tenant_id: number } | null) {
  return { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({
    first: vi.fn().mockResolvedValue(channelRow),
  }) }) };
}

const testSecret = "test-internal-secret";
const testEnv = { ...env, INTERNAL_SECRET: testSecret };

describe("POST /internal/tiktok/video-post", () => {
  const baseBody = {
    contentId: "content-vid-1", channelId: "tiktok-chan-1",
    prompts: { title: "Write a catchy title", description: "Write a caption" },
    textProvider: "none" as const,
    videoUrl: "https://content-dev.uni-scrm.com/public/media/vid-key-1",
    flowId: "flow-1",
  };
  const channelRow = { config: JSON.stringify({ access_token: "tok-1" }), channel_type: "TIKTOK", tenant_id: 1 };

  it("publishes the video and records content on success", async () => {
    tenantDataDbRunMock.mockClear();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/v2/post/publish/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const publishCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/v2/post/publish/video/init/"));
    const publishBody = JSON.parse(publishCall![1].body as string);
    expect(publishBody.source_info).toEqual({ source: "PULL_FROM_URL", video_url: baseBody.videoUrl });
    expect(tenantDataDbRunMock).toHaveBeenCalledTimes(1);
    const [insertSql, insertParams] = tenantDataDbRunMock.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO content/);
    expect(insertParams[3]).toBe("VIDEO_POST");
    vi.unstubAllGlobals();
  });

  it("returns ok:false for a non-TIKTOK channel without calling TikTok", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb({ ...channelRow, channel_type: "X" }), WEB_DB: mockWebDb("tenant-db-1") }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns rateLimited:true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "" } }), { status: 429 })
    ));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") }
    );

    const body = await res.json() as { ok: boolean; rateLimited?: boolean };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-video-post.test.ts`
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Implement the route**

In `link/src/routes-internal.ts`, update the TikTok import:

```ts
import { initPhotoPost, initVideoPost } from "./services/tiktok-publish";
```

Add the new route, right after the existing `/tiktok/photo-post` route's closing
`});`:

```ts
  router.post("/tiktok/video-post", async (c) => {
    const {
      contentId, channelId, prompts, textProvider, textSkillId, videoUrl, flowId,
    } = await c.req.json<{
      contentId: string; channelId: string;
      prompts: { title: string; description: string };
      textProvider: "default" | "openai" | "anthropic" | "none"; textSkillId?: string;
      videoUrl: string;
      flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!channel || channel.channel_type !== "TIKTOK") return c.json({ ok: false }, 200);

    const tenantId = channel.tenant_id;

    const generateText = async (prompt: string): Promise<string | null> => {
      if (textProvider === "none") return prompt;
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt, provider: textProvider, skillId: textSkillId }),
      });
      if (!res.ok) return null;
      const body = await res.json<{ text: string }>();
      return body.text;
    };

    const [title, description] = await Promise.all([generateText(prompts.title), generateText(prompts.description)]);
    if (title === null || description === null) {
      console.error(JSON.stringify({ event: "tiktok_video_post_text_failed", contentId, channelId }));
      return c.json({ ok: false }, 200);
    }

    const tokenService = new TikTokTokenService(c.env.LINK_DB, c.env.TIKTOK_CLIENT_KEY, c.env.TIKTOK_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);
    const publishResult = await initVideoPost(accessToken, videoUrl, title, description);

    console.log(JSON.stringify({
      event: "tiktok_video_post", contentId, channelId,
      ok: publishResult.ok, rateLimited: !!publishResult.rateLimited,
    }));

    if (publishResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!publishResult.ok) {
      return c.json({ ok: false }, 200);
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId).first<{ d1_database_id: string | null }>();
    if (tenantRow?.d1_database_id) {
      const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
      const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
      await contentService.recordPublishedContent(
        channelId, "TIKTOK", publishResult.publishId || crypto.randomUUID(), description,
        { generatedFromContentId: contentId, flowId: flowId || "" }, "VIDEO_POST"
      );
    }

    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-video-post.test.ts`
Expected: PASS.

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: PASS — regression check, unchanged.

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-tiktok-video-post.test.ts
git commit -m "feat: add POST /internal/tiktok/video-post endpoint"
```

---

## Task 7: `flow` engine — `buildActionData` for video fields

**Files:**
- Modify: `flow/src/engine.ts:244-270` (`buildActionData`)
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (for Task 8/9 to read): `ActionResult` for `xContentAction` gains
  `attachVideo: boolean`. `ActionResult` for `tiktokContentAction` gains `operation:
  string` (defaults `"photo-post"`).

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/engine.test.ts`, alongside the existing xContentAction/
tiktokContentAction `collectActions` tests (following the exact `executeFlow`/
`toMatchObject` pattern already there):

```ts
it("collects attachVideo:true on an xContentAction node when data.attachVideo is set", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
  expect(result.actions[0]).toMatchObject({ attachVideo: true });
});

it("defaults attachVideo to false when not set on an xContentAction node", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
  expect(result.actions[0]).toMatchObject({ attachVideo: false });
});

it("defaults tiktokContentAction operation to 'photo-post' when not set", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "tiktokContentAction", channelId: "tiktok-chan-1", prompts: {}, textProvider: "default", imageProvider: "default" }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
  expect(result.actions[0]).toMatchObject({ operation: "photo-post" });
});

it("carries a set 'video-post' operation through on a tiktokContentAction node", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: {}, textProvider: "default" }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
  const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
  expect(result.actions[0]).toMatchObject({ operation: "video-post" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: FAIL — `attachVideo` and `operation` (for tiktok) are `undefined`.

- [ ] **Step 3: Update `buildActionData`**

In `flow/src/engine.ts:254-268`, replace:

```ts
  if (actionType === "xContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "create-post";
    actionData.prompt = targetNode.data.prompt as string;
    actionData.provider = targetNode.data.provider as string;
    actionData.skillId = (targetNode.data.skillId as string) || "none";
  }
  if (actionType === "tiktokContentAction") {
    actionData.channelId = targetNode.data.channelId as string;
    actionData.prompts = (targetNode.data.prompts as Record<string, string>) || {};
    actionData.textProvider = targetNode.data.textProvider as string;
    actionData.textSkillId = (targetNode.data.textSkillId as string) || "none";
    actionData.imageCount = (targetNode.data.imageCount as number) || 1;
    actionData.imageProvider = targetNode.data.imageProvider as string;
    actionData.imageSkillId = (targetNode.data.imageSkillId as string) || "none";
  }
```

with:

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
    actionData.prompts = (targetNode.data.prompts as Record<string, string>) || {};
    actionData.textProvider = targetNode.data.textProvider as string;
    actionData.textSkillId = (targetNode.data.textSkillId as string) || "none";
    actionData.imageCount = (targetNode.data.imageCount as number) || 1;
    actionData.imageProvider = targetNode.data.imageProvider as string;
    actionData.imageSkillId = (targetNode.data.imageSkillId as string) || "none";
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: PASS — all tests, including the pre-existing exact-shape `toEqual` tests at
lines 116-164/185-231 (these will now include `attachVideo: false`/`operation:
"photo-post"` in their `toEqual` object — update those two pre-existing assertions to
add the new default fields, or they will now fail on the added keys):

In the pre-existing test "collects an xContentAction action carrying its operation,
prompt, and provider..." (around line 116-131), add `attachVideo: false` to the
expected object:

```ts
  expect(result.actions).toEqual([
    { type: "xContentAction", nodeId: "a1", hasBranches: true, operation: "repost-post", prompt: "Rewrite this: $content.content_text", provider: "default", skillId: "none", attachVideo: false },
  ]);
```

In the pre-existing test "collects a tiktokContentAction action carrying its prompts
record..." (around line 185-215), add `operation: "photo-post"` to the expected
object:

```ts
  expect(result.actions).toEqual([
    {
      type: "tiktokContentAction", nodeId: "a1", hasBranches: true, operation: "photo-post", channelId: "tiktok-chan-1",
      prompts: { title: "Write a title: $content.title", description: "Write a caption: $content.content_text", message_image: "A photo of: $content.title" },
      textProvider: "default", textSkillId: "none",
      imageCount: 1, imageProvider: "default", imageSkillId: "none",
    },
  ]);
```

Re-run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat: carry attachVideo (X) and operation (TikTok) fields through buildActionData"
```

---

## Task 8: `flow` — `executeContentActions` dispatches X video upload + pending row

**Files:**
- Modify: `flow/src/index.ts:300-344` (the `xContentAction` branch, `create-post`
  sub-branch)
- Test: `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: `action.attachVideo` (Task 7), `payload.processed_video_url`, `/internal/content/create-post`'s
  new `{pending: true, mediaId, channelId, text, checkAfterSecs}` response shape (Task 4).
- Produces (for Task 10 to read): a `content_flow_pending` row with `retry_action =
  JSON.stringify({type: "xVideoStatusPoll", channelId, mediaId, text, nodeId})` when
  the link call returns `pending: true`.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/queue-content.test.ts`, inside the existing `describe("queue():
xContentAction branch resolution", ...)` block (reuse `graphWithBranches`/
`makeBatch`/the describe-level `beforeEach`/`afterEach` already there):

```ts
it("resolves failed immediately (no fetch to link) when attachVideo is true but payload has no processed_video_url", async () => {
  const graphVideoNoUrl = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES ('flow-video-no-url', 1, 'video no url flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(graphVideoNoUrl).run();

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-no-url", channelId: "src-chan", payload: {} }),
    env
  );

  expect(fetchMock).not.toHaveBeenCalled();
  const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video-no-url'`).first<{ c: number }>();
  expect(execCount?.c).toBeGreaterThanOrEqual(1);

  await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-no-url'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-no-url'`).run();
  vi.unstubAllGlobals();
});

it("passes payload.processed_video_url as videoUrl to /internal/content/create-post when attachVideo is true", async () => {
  const graphVideo = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  });
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES ('flow-video-url', 1, 'video url flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(graphVideo).run();

  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "tweet-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-url", channelId: "src-chan", payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-9" } }),
    env
  );

  const createPostCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/content/create-post"));
  expect(createPostCall).toBeDefined();
  const body = JSON.parse((createPostCall![1] as RequestInit).body as string);
  expect(body.videoUrl).toBe("https://content-dev.uni-scrm.com/public/media/vid-9");

  await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-url'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-url'`).run();
  vi.unstubAllGlobals();
});

it("inserts a content_flow_pending row with an xVideoStatusPoll retry_action when link returns pending:true, without resolving success/failed yet", async () => {
  const graphVideo = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
    ],
  });
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES ('flow-video-pending', 1, 'video pending flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(graphVideo).run();

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ pending: true, mediaId: "media-9", channelId: "src-chan", text: "caption", checkAfterSecs: 5 }), { status: 200 })
  ));

  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-video-pending", channelId: "src-chan", payload: { processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-10" } }),
    env
  );

  const pending = await env.FLOW_DB.prepare(
    `SELECT retry_action, retry_count, execute_at FROM content_flow_pending WHERE flow_id = 'flow-video-pending' AND content_id = 'content-video-pending'`
  ).first<{ retry_action: string; retry_count: number; execute_at: string }>();
  expect(pending).toBeTruthy();
  expect(pending!.retry_count).toBe(0);
  expect(JSON.parse(pending!.retry_action)).toMatchObject({ type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-9", text: "caption", nodeId: "a1" });
  expect(new Date(pending!.execute_at).getTime()).toBeGreaterThan(Date.now());

  const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-video-pending'`).first<{ c: number }>();
  // Only the initial dispatch row (matching the trigger) — no resumed-branch row yet, since
  // the branch hasn't resolved.
  expect(execCount?.c).toBe(1);

  await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video-pending'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video-pending'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-video-pending'`).run();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts -t "video"`
Expected: FAIL — `attachVideo`/`processed_video_url` aren't read yet, no `pending`
handling exists.

- [ ] **Step 3: Update `executeContentActions`'s `xContentAction`/`create-post` branch**

In `flow/src/index.ts`, replace the `else` branch (the `create-post` default case,
currently lines 333-344):

```ts
      } else {
        const provider = action.provider as string;
        const skillId = (action.skillId as string) || "none";
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, channelId, flowId: flowId || null, skillId }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { channelId, provider, skillId };
      }
```

with:

```ts
      } else {
        const provider = action.provider as string;
        const skillId = (action.skillId as string) || "none";
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));

        if (action.attachVideo) {
          const videoUrl = String(payload?.processed_video_url ?? "");
          if (!videoUrl) {
            console.log(JSON.stringify({ event: "content_action_x_content_action_missing_video", contentId, channelId }));
            const nodeId = action.nodeId as string;
            const resumed = resumeFromNode(graph, nodeId, payload, "failed");
            if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
            if (resumed.actions.length > 0) {
              const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
              rateLimited.push(...nested.rateLimited);
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
            }
            continue;
          }
          res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
            body: JSON.stringify({ contentId, interpolatedPrompt, provider, channelId, flowId: flowId || null, skillId, videoUrl }),
          });
          const videoBody = await res.json().catch(() => ({})) as {
            ok?: boolean; pending?: boolean; rateLimited?: boolean; rateLimitReset?: string;
            mediaId?: string; channelId?: string; text?: string; checkAfterSecs?: number;
          };
          if (videoBody.pending) {
            const nodeId = action.nodeId as string;
            const executeAt = new Date(Date.now() + Math.max(videoBody.checkAfterSecs || 60, 60) * 1000).toISOString();
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
            ).bind(
              crypto.randomUUID(), flowId || "", nodeId, contentId, Number(tenantId),
              JSON.stringify({ ...payload, channel_id: channelId }), executeAt, new Date().toISOString(),
              JSON.stringify({ type: "xVideoStatusPoll", channelId: videoBody.channelId, mediaId: videoBody.mediaId, text: videoBody.text, nodeId })
            ).run();
            console.log(JSON.stringify({ event: "content_action_x_video_pending", contentId, channelId, mediaId: videoBody.mediaId }));
            continue;
          }
          if (videoBody.rateLimited) {
            // Video already uploaded to X successfully — only the final createPost() call hit
            // a rate limit. Reschedule like the non-video rate-limit path below does, rather than
            // treating this as a permanent failure (the uploaded media_id would otherwise be
            // wasted and the tenant's video silently dropped).
            rateLimited.push({ action, retryAt: videoBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
            continue;
          }
          console.log(JSON.stringify({ event: "content_action_x_content_action", contentId, status: res.status, ok: !!videoBody.ok, channelId, provider, skillId, attachVideo: true }));
          const branch = videoBody.ok ? "success" : "failed";
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
          continue;
        }

        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, channelId, flowId: flowId || null, skillId }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { channelId, provider, skillId };
      }
```

Note: the `continue` statements inside the `if (action.attachVideo)` block skip the
shared success/failed resolution logic further down in the surrounding `for (const
action of actions)` loop (the code at lines 346-379 in the original file, which reads
`body.rateLimited`/computes `branch`/calls `resumeFromNode` again) — that shared logic
still runs unmodified for every OTHER `xContentAction` sub-branch (bookmark/like/
repost/text-only create-post), since only the `attachVideo` path takes its own early
`continue`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: PASS — all tests in the file, including every pre-existing test (text-only
`create-post`, `repost-post`/`create-bookmark`/`like-post` routing, rate-limit
scheduling) — none of those set `attachVideo`, so they take the unchanged final
`else`-tail path.

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat: dispatch X video upload and schedule async status-poll in executeContentActions"
```

---

## Task 9: `flow` — `executeContentActions` TikTok operation branching

**Files:**
- Modify: `flow/src/index.ts:380-433` (the `tiktokContentAction` branch)
- Test: `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: `action.operation` (Task 7), `payload.processed_video_url`, `/internal/tiktok/video-post`
  (Task 6).
- Produces: nothing new for later tasks — this is a leaf dispatch, same shape as the
  existing `photo-post` call.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/queue-content.test.ts`, inside the existing `describe("queue():
tiktokContentAction dispatch", ...)` block:

```ts
it("resolves failed immediately (no fetch) when operation is video-post but payload has no processed_video_url", async () => {
  const graphTiktokVideoNoUrl = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: { title: "t", description: "d" }, textProvider: "none" }, position: { x: 200, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES ('flow-tiktok-video-no-url', 1, 'tiktok video no url flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(graphTiktokVideoNoUrl).run();

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tiktok-video-no-url", channelId: "src-chan", payload: {} }),
    env
  );

  expect(fetchMock).not.toHaveBeenCalled();

  await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok-video-no-url'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok-video-no-url'`).run();
  vi.unstubAllGlobals();
});

it("routes operation:'video-post' to /internal/tiktok/video-post with the interpolated video URL, and 'photo-post' (default) still routes to /internal/tiktok/photo-post", async () => {
  const graphTiktokVideo = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: { title: "Title: $content.title", description: "Desc" }, textProvider: "none" }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  });
  await env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES ('flow-tiktok-video', 1, 'tiktok video flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(graphTiktokVideo).run();

  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tiktok-video", channelId: "src-chan", payload: { title: "My Title", processed_video_url: "https://content-dev.uni-scrm.com/public/media/vid-tt-1" } }),
    env
  );

  const videoPostCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/internal/tiktok/video-post"));
  expect(videoPostCall).toBeDefined();
  const body = JSON.parse((videoPostCall![1] as RequestInit).body as string);
  expect(body.videoUrl).toBe("https://content-dev.uni-scrm.com/public/media/vid-tt-1");
  expect(body.prompts.title).toBe("Title: My Title");
  expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/internal/tiktok/photo-post"))).toBe(false);

  await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok-video'`).run();
  await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok-video'`).run();
  vi.unstubAllGlobals();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts -t "video-post"`
Expected: FAIL — `operation` isn't branched on yet, `/internal/tiktok/video-post` is
never called.

- [ ] **Step 3: Update the `tiktokContentAction` branch**

In `flow/src/index.ts`, replace the `} else if (action.type === "tiktokContentAction")
{` block's body (currently lines 380-402, the interpolation + single `fetch` call —
leave the branch-resolution code after it, lines 403-433, unchanged):

```ts
    } else if (action.type === "tiktokContentAction") {
      const interpolate = (s: string) => String(s || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
      const operation = (action.operation as string) || "photo-post";

      if (operation === "video-post") {
        const videoUrl = String(payload?.processed_video_url ?? "");
        if (!videoUrl) {
          console.log(JSON.stringify({ event: "content_action_tiktok_video_post_missing_video", contentId, channelId: action.channelId }));
          const nodeId = action.nodeId as string;
          const resumed = resumeFromNode(graph, nodeId, payload, "failed");
          if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
          if (resumed.actions.length > 0) {
            const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
            rateLimited.push(...nested.rateLimited);
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
               VALUES (?, ?, ?, ?, 1, ?)`
            ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
          }
          continue;
        }
        const rawPrompts = (action.prompts as Record<string, string>) || {};
        const body = {
          contentId,
          channelId: action.channelId as string,
          prompts: { title: interpolate(rawPrompts.title), description: interpolate(rawPrompts.description) },
          textProvider: action.textProvider as string,
          textSkillId: action.textSkillId as string,
          videoUrl,
          flowId: flowId || null,
        };
        const res = await fetch(`${env.LINK_URL}/internal/tiktok/video-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify(body),
        });
        const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
        console.log(JSON.stringify({ event: "content_action_tiktok_content_action", contentId, status: res.status, ok: respBody.ok, channelId: body.channelId, operation: "video-post" }));

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
        continue;
      }

      const rawPrompts = (action.prompts as Record<string, string>) || {};
      const interpolatedPrompts: Record<string, string> = {};
      for (const key of Object.keys(rawPrompts)) {
        interpolatedPrompts[key] = interpolate(rawPrompts[key]);
      }
      const body = {
        contentId,
        channelId: action.channelId as string,
        prompts: interpolatedPrompts,
        textProvider: action.textProvider as string,
        textSkillId: action.textSkillId as string,
        imageCount: action.imageCount as number,
        imageProvider: action.imageProvider as string,
        imageSkillId: action.imageSkillId as string,
        flowId: flowId || null,
      };
      const res = await fetch(`${env.LINK_URL}/internal/tiktok/photo-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify(body),
      });
```

(Leave everything from the existing `const respBody = await res.json()...` line
through the end of this `tiktokContentAction` block, currently index.ts lines 403-433,
completely unchanged — it's reached only for the `photo-post` fallthrough now.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: PASS — all tests, including every pre-existing `tiktokContentAction` test
(which never set `operation`, so they default to `"photo-post"` and take the unchanged
fallthrough path).

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat: branch tiktokContentAction on operation, dispatch video-post to its own endpoint"
```

---

## Task 10: `flow` — `scheduled()` sweep handles `xVideoStatusPoll`

**Files:**
- Modify: `flow/src/index.ts` (the `content_flow_pending` sweep's `if
  (row.retry_action)` branch, currently around lines 1241-1298)
- Test: `flow/tests/unit/scheduled-content.test.ts`

**Interfaces:**
- Consumes: rows inserted by Task 8 (`retry_action` with `type: "xVideoStatusPoll"`),
  `/internal/content/x-video-status` (Task 5).
- Produces: nothing for later tasks — this is the terminal consumer of the async
  video-post mechanism.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/scheduled-content.test.ts`, inside (or as a sibling
`describe`, following the exact same `graphWithBranches`/insert-pending-row/
`worker.scheduled({} as any, env)` pattern as) the existing `describe("scheduled():
content_flow_pending retry_action handling", ...)` block:

```ts
describe("scheduled(): content_flow_pending xVideoStatusPoll handling", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-vpoll1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-vpoll1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-vpoll1'`).run();
    vi.unstubAllGlobals();
  });

  const graphWithBranches = JSON.stringify({
    nodes: [
      { id: "t1", type: "xContentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
      { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "a2", sourceHandle: "success" },
      { id: "e3", source: "a1", target: "a3", sourceHandle: "failed" },
    ],
  });

  it("resolves the success branch and calls x-video-status once, when it reports ok:true", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-1", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-1', 'flow-vpoll1', 'a1', 'content-vpoll-1', 1, ?, ?, datetime('now'), ?, 0)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "tweet-poll-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.scheduled({} as any, env);

    const statusCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/content/x-video-status"));
    expect(statusCall).toBeDefined();
    const body = JSON.parse((statusCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ channelId: "src-chan", mediaId: "media-1", text: "caption" });

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-1'`).first();
    expect(remaining).toBeNull();

    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-vpoll1' AND content_id = 'content-vpoll-1'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });

  it("resolves the failed branch when x-video-status reports ok:false", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-2", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-2', 'flow-vpoll1', 'a1', 'content-vpoll-2', 1, ?, ?, datetime('now'), ?, 0)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-2'`).first();
    expect(remaining).toBeNull();
    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-vpoll1' AND content_id = 'content-vpoll-2'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });

  it("reschedules (retry_count+1) when still pending and under the 5-attempt ceiling", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-3", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-3', 'flow-vpoll1', 'a1', 'content-vpoll-3', 1, ?, ?, datetime('now'), ?, 1)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: true, checkAfterSecs: 10 }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const row = await env.FLOW_DB.prepare(`SELECT retry_count, execute_at FROM content_flow_pending WHERE id = 'pend-vpoll-3'`).first<{ retry_count: number; execute_at: string }>();
    expect(row?.retry_count).toBe(2);
    expect(new Date(row!.execute_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("resolves the failed branch once pending retries are exhausted (retry_count >= 5)", async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-vpoll1', 1, 'vpoll flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithBranches).run();

    const pollAction = { type: "xVideoStatusPoll", channelId: "src-chan", mediaId: "media-4", text: "caption", nodeId: "a1" };
    const past = new Date(Date.now() - 1000).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
       VALUES ('pend-vpoll-4', 'flow-vpoll1', 'a1', 'content-vpoll-4', 1, ?, ?, datetime('now'), ?, 5)`
    ).bind(JSON.stringify({ channel_id: "src-chan" }), past, JSON.stringify(pollAction)).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ pending: true, checkAfterSecs: 10 }), { status: 200 })));

    await worker.scheduled({} as any, env);

    const remaining = await env.FLOW_DB.prepare(`SELECT id FROM content_flow_pending WHERE id = 'pend-vpoll-4'`).first();
    expect(remaining).toBeNull();
    const execCount = await env.FLOW_DB.prepare(`SELECT COUNT(*) as c FROM content_flow_executions WHERE flow_id = 'flow-vpoll1' AND content_id = 'content-vpoll-4'`).first<{ c: number }>();
    expect(execCount?.c).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/scheduled-content.test.ts -t "xVideoStatusPoll"`
Expected: FAIL — the sweep always treats `retry_action` as an `ActionResult` for
`executeContentActions`, never dispatches to `/internal/content/x-video-status`.

- [ ] **Step 3: Update the sweep**

In `flow/src/index.ts`, the `content_flow_pending` sweep's `for (const row of
contentPending.results)` loop currently starts its `if (row.retry_action)` branch
(around line 1243) with:

```ts
        if (row.retry_action) {
          const action = JSON.parse(row.retry_action) as ActionResult;
          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(row.flow_id)
            .first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            continue;
          }
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const payload = JSON.parse(row.payload);
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, [action], row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
```

Insert a new discriminated branch immediately after `const payload =
JSON.parse(row.payload);` and before the `executeContentActions` call, checking the
parsed `retry_action`'s `type` — `xVideoStatusPoll` rows never go through
`executeContentActions` at all (they call the link status endpoint directly):

```ts
        if (row.retry_action) {
          const action = JSON.parse(row.retry_action) as ActionResult;
          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(row.flow_id)
            .first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            continue;
          }
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const payload = JSON.parse(row.payload);
          const channelId = String(payload.channel_id ?? "");

          if (action.type === "xVideoStatusPoll") {
            const statusRes = await fetch(`${env.LINK_URL}/internal/content/x-video-status`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
              body: JSON.stringify({ channelId: action.channelId, mediaId: action.mediaId, text: action.text, contentId: row.content_id, flowId: row.flow_id }),
            });
            const statusBody = await statusRes.json().catch(() => ({ ok: false })) as { ok?: boolean; pending?: boolean; checkAfterSecs?: number };

            if (statusBody.pending && row.retry_count < 5) {
              const nextAt = new Date(Date.now() + Math.max(statusBody.checkAfterSecs || 60, 60) * 1000).toISOString();
              await env.FLOW_DB.prepare(
                `UPDATE content_flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
              ).bind(nextAt, row.retry_count + 1, row.id).run();
              console.log(JSON.stringify({ event: "x_video_poll_rescheduled", id: row.id, retryCount: row.retry_count + 1 }));
              continue;
            }

            const branch = !statusBody.pending && statusBody.ok ? "success" : "failed";
            const resolved = resumeFromNode(graph, action.nodeId as string, payload, branch);
            if (resolved.nodeLogs.length > 1) await emitContentNodeLogs(resolved.nodeLogs.slice(1), row.flow_id, row.content_id, row.tenant_id, env);
            if (resolved.actions.length > 0) {
              const { rateLimited: nestedRateLimited } = await executeContentActions(graph, resolved.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
              for (const rl of nestedRateLimited) {
                await env.FLOW_DB.prepare(
                  `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                   VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
                ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
              }
            }
            for (const wait of resolved.pendingWaits) {
              const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.content_id, row.tenant_id, row.payload, executeAt, now, wait.awaitingEvent || "").run();
            }
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            console.log(JSON.stringify({ event: statusBody.pending ? "x_video_poll_exhausted" : "x_video_poll_resolved", id: row.id, branch }));
            continue;
          }

          const { rateLimited } = await executeContentActions(graph, [action], row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
```

(Everything after this point — the existing rate-limit reschedule/exhaustion handling
using the `rateLimited` variable — is unchanged; it's simply now reached only for
non-`xVideoStatusPoll` `retry_action` rows, exactly as it is today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/scheduled-content.test.ts`
Expected: PASS — all tests, including the pre-existing rate-limit-retry tests
(unchanged — they never set `type: "xVideoStatusPoll"`, so they fall through to the
existing `executeContentActions` path exactly as before).

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/scheduled-content.test.ts
git commit -m "feat: resolve xVideoStatusPoll rows in the content_flow_pending sweep"
```

---

## Task 11: Frontend — X video checkbox + TikTok operation dropdown

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:608-687` (`XContentActionInspector`)
- Modify: `flow/frontend/components/Inspector.tsx:711-847` (`TikTokContentActionInspector`)

**Interfaces:**
- Consumes: `ContentMetadata_X`'s `create-post` entry now has a `VIDEO`-aiType prop
  (Task 1). `ContentMetadata_TikTok` now has a `video-post` action entry (Task 1).
  `data.attachVideo`/`data.operation` (tiktok) map onto `buildActionData`'s new fields
  (Task 7) — the Inspector writes `node.data`, the engine reads it; there's no direct
  code dependency, only a shared field-name contract.
- Produces: nothing consumed by later tasks — this is the plan's final task.

No automated test is added for this task (see Global Constraints — no React component
test harness exists anywhere in this module). Verification is a manual dev-server
check, itself a required step below.

- [ ] **Step 1: Update `XContentActionInspector` — separate the TEXT prompt-prop lookup from the VIDEO checkbox-prop lookup**

In `flow/frontend/components/Inspector.tsx`, replace lines 613-614:

```ts
  const selectedOperation = CONTENT_ACTION_OPERATIONS.find((op) => op.sourceContentType === (data.operation || "create-post"));
  const aiProp = selectedOperation?.contentProps.find((p) => p.aiType);
```

with:

```ts
  const selectedOperation = CONTENT_ACTION_OPERATIONS.find((op) => op.sourceContentType === (data.operation || "create-post"));
  // VIDEO never means "AI-generates from this prompt" (unlike TEXT/IMAGE) — it means
  // "optionally attach $content.processed_video_url". Exclude it from the prompt-box lookup.
  const aiProp = selectedOperation?.contentProps.find((p) => p.aiType && p.aiType !== "VIDEO");
  const videoProp = selectedOperation?.contentProps.find((p) => p.aiType === "VIDEO");
```

- [ ] **Step 2: Render the video checkbox**

In the same component, after the closing `</>` of the `{aiProp && (...)}` block
(currently ending right before line 683's `)}`), add a sibling conditional block. The
region currently reads (lines 643-684):

```ts
        {aiProp && (
          <>
            ...
          </>
        )}
      </div>
    </div>
  );
}
```

Replace the closing with:

```ts
        {aiProp && (
          <>
            ...
          </>
        )}
        {videoProp && (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`${nodeId}-attach-video`}
              checked={!!data.attachVideo}
              onChange={(e) => updateNodeData(nodeId, { attachVideo: e.target.checked })}
            />
            <Label htmlFor={`${nodeId}-attach-video`} className="text-xs cursor-pointer">
              Attach video (uses this flow's processed video, if any)
            </Label>
          </div>
        )}
      </div>
    </div>
  );
}
```

(Leave the `{aiProp && (...)}` block's own internals — the provider select, prompt
textarea, skill select — entirely untouched.)

- [ ] **Step 3: Add an operation dropdown to `TikTokContentActionInspector`**

In `flow/frontend/components/Inspector.tsx`, `TikTokContentActionInspector` (starting
line 711) currently has no operation state and hardcodes `TIKTOK_PHOTO_POST_PROPS`
(line 601, module-level, unchanged — still used for the `photo-post` case). Add a
module-level constant next to it (near line 601):

```ts
const CONTENT_TIKTOK_ACTION_OPERATIONS = ContentMetadata_TikTok.filter((m) => m.flowType === "action");
const TIKTOK_VIDEO_POST_PROPS = CONTENT_TIKTOK_ACTION_OPERATIONS.find((m) => m.sourceContentType === "video-post")!.contentProps;
```

Inside the component function, replace:

```ts
  const prompts = (data.prompts as Record<string, string>) || {};
  const updatePrompt = (propId: string, value: string) => updateNodeData(nodeId, { prompts: { ...prompts, [propId]: value } });
  const textProps = TIKTOK_PHOTO_POST_PROPS.filter((p) => p.aiType === "TEXT");
  const imageProps = TIKTOK_PHOTO_POST_PROPS.filter((p) => p.aiType === "IMAGE");
```

with:

```ts
  const operation = (data.operation as string) || "photo-post";
  const isVideoPost = operation === "video-post";
  const activeProps = isVideoPost ? TIKTOK_VIDEO_POST_PROPS : TIKTOK_PHOTO_POST_PROPS;
  const prompts = (data.prompts as Record<string, string>) || {};
  const updatePrompt = (propId: string, value: string) => updateNodeData(nodeId, { prompts: { ...prompts, [propId]: value } });
  const textProps = activeProps.filter((p) => p.aiType === "TEXT");
  const imageProps = activeProps.filter((p) => p.aiType === "IMAGE");
```

Then insert an Operation dropdown right after the existing "Target Account" `<div>`
block (before the `{textProps.map(...)}` line), mirroring `XContentActionInspector`'s
`OperationSelect` usage:

```tsx
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <OperationSelect
            value={operation}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={CONTENT_TIKTOK_ACTION_OPERATIONS.map((op) => ({
              value: op.sourceContentType,
              label: op.label ? localizeLabel(op.label, "en") : op.sourceContentType,
            }))}
          />
        </div>
```

Finally, wrap the existing image-specific fields (`{imageProps.map(...)}`, the "Image
Count" `<div>`, the "Image Provider" `<div>`, and the "Image Skill" `<div>` — currently
lines 795-843) in `{!isVideoPost && (...)}` so they only render for `photo-post`:

```tsx
        {!isVideoPost && (
          <>
            {imageProps.map((prop) => (
              <div key={prop.propId}>
                <Label className="text-xs block mb-1">{propLabel(prop.propId)} Prompt</Label>
                <Textarea
                  value={prompts[prop.propId] || ""}
                  onChange={(e: TextareaChange) => updatePrompt(prop.propId, e.target.value)}
                  placeholder="A photo of: $content.title"
                  rows={3}
                  className="w-full text-sm font-mono"
                />
              </div>
            ))}
            <div>
              <Label className="text-xs block mb-1">Image Count</Label>
              <Input
                type="number"
                min={1}
                max={9}
                value={data.imageCount || 1}
                onChange={(e: InputChange) => updateNodeData(nodeId, { imageCount: Math.max(1, Math.min(9, parseInt(e.target.value) || 1)) })}
                className="w-24 text-sm"
              />
            </div>
            <div>
              <Label className="text-xs block mb-1">Image Provider</Label>
              <Select
                value={data.imageProvider || "default"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { imageProvider: e.target.value })}
                className="w-full text-sm"
              >
                <option value="default">Default (Cloudflare Workers AI)</option>
                {providers.filter((p) => p.provider === "openai").map((p) => (
                  <option key={p.provider} value="openai">OpenAI (gpt-image-1)</option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="text-xs block mb-1">Image Skill</Label>
              <Select
                value={data.imageSkillId || "none"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { imageSkillId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="none">None (current behavior)</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? " (not yet fetched)" : ""}</option>
                ))}
              </Select>
            </div>
          </>
        )}
```

`textProps.map(...)` (title/description prompts) stays outside this wrapper —
`video-post` also has `title`/`description` as `TEXT` props (from
`TIKTOK_VIDEO_POST_PROPS`), so those fields correctly render for both operations
unchanged.

- [ ] **Step 4: Start the dev server and verify manually in a browser**

Run: `cd flow && wrangler dev --env dev` (or the project's existing dev-server command
— check `flow/package.json`'s `dev` script if this differs) alongside `flow/frontend`'s
dev server per this module's existing local-dev setup.

In the flow editor:
1. Add an `xContentAction` node, select operation `create-post`. Confirm a new
   checkbox "Attach video (uses this flow's processed video, if any)" appears below
   the existing prompt/provider/skill fields, unchecked by default. Toggle it and
   confirm the node's underlying data updates (inspect via browser devtools or the
   flow JSON export, since `attachVideo` isn't otherwise visible in the canvas).
   Switch to a different operation (e.g. `repost-post`) and confirm the checkbox
   disappears (no `VIDEO`-aiType prop on that operation).
2. Add a `tiktokContentAction` node. Confirm a new "Operation" dropdown appears with
   "Photo Posting" and "Video Posting" options. With `photo-post` selected, confirm
   the UI is unchanged from before this task (title/description prompts, image
   prompts, image count, image provider/skill all present). Switch to `video-post` and
   confirm the image-specific fields (image prompt, image count, image provider,
   image skill) disappear, while title/description prompts remain.

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/components/Inspector.tsx
git commit -m "feat: add X video-attach checkbox and TikTok operation dropdown to Inspector"
```

---

## Final verification

- [ ] Run the full `link` test suite: `cd link && npx vitest run`
- [ ] Run the full `flow` test suite: `cd flow && npx vitest run`
- [ ] Confirm no regressions: every pre-existing test in both suites still passes.
- [ ] Confirm the manual browser check from Task 11 Step 4 was performed and both
      Inspector changes render/behave as described.

Per this feature's completion bar (see design spec, Decision 10), this is the full
scope of "done" — there is no live end-to-end video-posting to click through until the
sibling video-action node ships.
