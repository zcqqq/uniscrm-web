# Video Condition Flow Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move face-detection from always-on (computed for every ingested YouTube video) to on-demand (computed only when a published flow's graph contains a new `videoCondition` node downstream of its trigger), and relocate the model-invocation logic from `link` into `content`.

**Architecture:** New content-flow node `videoCondition` (own `reactFlowType`, `role: "condition"`, same architectural shape as the existing `webhook` node type) with three branches — `has-face` / `no-face` / `failed`. Executed asynchronously in `flow`'s queue consumer (real Workers AI I/O can't resolve synchronously like `userPropsCondition`). The model call itself (`@cf/moondream/moondream3.1-9B-A2B`, unchanged) moves from `link/src/services/youtube-vision.ts` into a new `content/src/services/vision.ts`, exposed via a new `POST /internal/detect-face` route, called from `flow` with the `cover_image_url` already present on the `content.created` payload. `has_face` is dropped entirely as a persisted content prop — nothing currently reads it as analytics, and no existing dev-tenant flow references it in a trigger condition (confirmed via `wrangler d1 execute` against `uniscrm-flow-dev`).

**Tech Stack:** Cloudflare Workers (Hono), Vitest + `@cloudflare/vitest-pool-workers`, React + Zustand (flow frontend), TypeScript throughout.

## Global Constraints

- No retry-on-failure and no rate-limit-detection machinery for this node — any error (model throw, non-2xx, missing/empty `cover_image_url`) resumes the graph on the `failed` branch immediately. This matches `content`'s existing `/generate` and `/generate-image` routes, neither of which has retry logic for internal Workers AI calls.
- No new per-tenant quota/rate limit for this node — matches `tiktokContentAction`'s uncapped image-generation precedent.
- `has_face` is removed entirely: no ingestion-time computation, no persisted content prop, no trigger-inline-condition filterability. Do not add a caching/persistence layer for the check result — if reused across multiple flows it re-runs, by design (see spec's Out of scope).
- The node is **not** restricted to sit only downstream of `youtubeContentTrigger` — gate placement the same way every other `domain: "content"` node type already is (no source-type-specific restriction).
- `videoCondition` is `generatable: true` (the AI flow-generation feature may produce it), consistent with every other node type in this codebase.
- Known pre-existing gap, explicitly OUT OF SCOPE for this plan: `webhook` has no execution handler in `flow/src/index.ts`'s `executeContentActions` (content-flow domain) despite being listed as a valid content-flow node — a content flow using `webhook` today silently does nothing at execution time. Do not fix this as part of this plan; it is a separate, already-known cleanup item.

---

## Task 1: `content` — relocate `detectFace` into a new `vision.ts` service

**Files:**
- Create: `content/src/services/vision.ts`
- Test: `content/tests/vision.test.ts`

**Interfaces:**
- Produces: `detectFace(ai: Ai, imageUrl: string): Promise<boolean>` — throws on model error (no internal try/catch, no fail-open/fail-closed default). Task 2's route is the sole caller and is responsible for turning a throw into an HTTP error response.

- [ ] **Step 1: Write the failing test**

Create `content/tests/vision.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { detectFace } from "../src/services/vision";

describe("detectFace", () => {
  it("returns true when the model detects at least one object", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [{ x: 1, y: 2 }] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(true);
    expect(ai.run).toHaveBeenCalledWith("@cf/moondream/moondream3.1-9B-A2B", {
      task: "detect",
      image: "https://img.example/thumb.jpg",
      target: "human face",
    });
  });

  it("returns false when the model detects no objects", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ objects: [] }) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(false);
  });

  it("returns false when objects is missing from the response", async () => {
    const ai = { run: vi.fn().mockResolvedValue({}) };
    const result = await detectFace(ai as any, "https://img.example/thumb.jpg");
    expect(result).toBe(false);
  });

  it("propagates the error when the model call throws (no fail-open/fail-closed default)", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model unavailable")) };
    await expect(detectFace(ai as any, "https://img.example/thumb.jpg")).rejects.toThrow("model unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/vision.test.ts`
Expected: FAIL — `Cannot find module '../src/services/vision'`

- [ ] **Step 3: Write the implementation**

Create `content/src/services/vision.ts`:

```ts
export async function detectFace(ai: Ai, imageUrl: string): Promise<boolean> {
  const response = (await ai.run("@cf/moondream/moondream3.1-9B-A2B", {
    task: "detect",
    image: imageUrl,
    target: "human face",
  })) as { objects?: unknown[] };
  return Array.isArray(response.objects) && response.objects.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/vision.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 4 passed (4)`

- [ ] **Step 5: Commit**

```bash
git add content/src/services/vision.ts content/tests/vision.test.ts
git commit -m "feat(content): add detectFace vision service (relocated from link)"
```

---

## Task 2: `content` — new `POST /internal/detect-face` route

**Files:**
- Modify: `content/src/routes-internal.ts`
- Test: `content/tests/routes-internal.test.ts`

**Interfaces:**
- Consumes: `detectFace(ai, imageUrl)` from Task 1.
- Produces: `POST /internal/detect-face` — request `{ imageUrl: string }`, response `{ hasFace: boolean }` on 200, `{ error: string }` on 400 (missing `imageUrl`) or 502 (model error). This is the endpoint Task 7's `flow` queue consumer calls.

- [ ] **Step 1: Write the failing test**

Add to `content/tests/routes-internal.test.ts` (append a new top-level `describe`, following the exact pattern the existing `describe("POST /internal/generate", ...)` block in this file already uses for `testEnv`/worker.fetch):

```ts
describe("POST /internal/detect-face", () => {
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
  };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns hasFace: true when the model detects a face", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => ({ objects: [{ x: 1 }] }) } as unknown as Ai }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ hasFace: boolean }>();
    expect(body.hasFace).toBe(true);
  });

  it("returns hasFace: false when the model detects no face", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => ({ objects: [] }) } as unknown as Ai }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ hasFace: boolean }>();
    expect(body.hasFace).toBe(false);
  });

  it("returns 400 when imageUrl is missing", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it("returns 502 when the model call throws", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/detect-face", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ imageUrl: "https://img/thumb.jpg" }),
      }),
      { ...testEnv, AI: { run: async () => { throw new Error("model down"); } } as unknown as Ai }
    );
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: the four authenticated-request tests FAIL with 404 (route doesn't exist yet); the missing-secret test passes already (existing `internalAuthMiddleware`).

- [ ] **Step 3: Write the implementation**

In `content/src/routes-internal.ts`, add the import and new route (after the existing `/generate-image` route, before `/skills/:id/refresh`):

```ts
import { detectFace } from "./services/vision";
```

```ts
  router.post("/detect-face", async (c) => {
    const { imageUrl } = await c.req.json<{ imageUrl?: string }>();
    if (!imageUrl) {
      return c.json({ error: "imageUrl required" }, 400);
    }
    try {
      const hasFace = await detectFace(c.env.AI, imageUrl);
      return c.json({ hasFace });
    } catch (err) {
      console.error(JSON.stringify({ event: "detect_face_failed", error: String(err) }));
      return c.json({ error: "Detection failed" }, 502);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: all tests pass, including the 5 new ones.

Also run the full module suite to confirm no regression: `cd content && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add content/src/routes-internal.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): add POST /internal/detect-face route"
```

---

## Task 3: `link` — drop `has_face`/`detectFace` from YouTube ingestion

**Files:**
- Modify: `link/src/services/pollers/youtube-content.ts`
- Delete: `link/src/services/youtube-vision.ts`
- Delete: `link/tests/services/youtube-vision.test.ts` (superseded by Task 1's `content/tests/vision.test.ts`)
- Modify: `link/tests/services/pollers/youtube-content.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only removes code.

- [ ] **Step 1: Update the poller test first (defines the new expected behavior)**

In `link/tests/services/pollers/youtube-content.test.ts`:
1. Remove the `import * as youtubeVision from "../../../src/services/youtube-vision";` line.
2. Replace the test `"parses duration, runs face detection on the thumbnail, and upserts content"` with:

```ts
  it("parses duration and upserts content", async () => {
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

    const tenantDb = createMockTenantDb();
    const ctx = baseCtx({ tenantDb });
    await ingestYouTubeVideo(ctx, "vid1");

    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall).toBeTruthy();
    const insertCols = insertCall![0] as string;
    expect(insertCols).not.toContain("has_face");
    expect(insertCols).toContain("duration");
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams).toContain(253); // parsed duration
  });
```

3. Delete the entire `"defaults has_face to 1 when there is no thumbnail to check"` test (no replacement — there is no `has_face` default behavior anymore).
4. In the `"emits content.created via flowQueue on a genuinely new video"` test, remove the line `vi.spyOn(youtubeVision, "detectFace").mockResolvedValue(0);`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: FAIL — `insertCols` still contains `"has_face"` (production code hasn't changed yet), so the `not.toContain("has_face")` assertion fails.

- [ ] **Step 3: Write the implementation**

In `link/src/services/pollers/youtube-content.ts`:
1. Remove the import `import { detectFace } from "../youtube-vision";`.
2. Remove the line:

```ts
  const thumbnailUrl = props.cover_image_url as string | undefined;
  props.has_face = thumbnailUrl ? await detectFace(ctx.ai, thumbnailUrl) : 1;
```

(Both lines removed — `cover_image_url` itself is still resolved earlier via `resolveProps`/`YOUTUBE_METADATA.contentProps`, unaffected by this removal.)

Then delete `link/src/services/youtube-vision.ts` and `link/tests/services/youtube-vision.test.ts` entirely:

```bash
rm link/src/services/youtube-vision.ts link/tests/services/youtube-vision.test.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: all tests pass.

Run the full `link` suite to confirm no other reference to `youtube-vision` broke: `cd link && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add -A link/src/services/pollers/youtube-content.ts link/src/services/youtube-vision.ts link/tests/services/youtube-vision.test.ts link/tests/services/pollers/youtube-content.test.ts
git commit -m "feat(link): drop has_face computation from YouTube ingestion (moved to content, on-demand)"
```

---

## Task 4: `metadata` — drop `has_face` prop definition

**Files:**
- Modify: `metadata/props.ts`
- Modify: `metadata/youtube.ts`
- Modify: `flow/nodeTypeRegistry.ts` (added after this plan was written — a concurrent, unrelated session's commit `8103063` touched `youtubeContentTrigger`'s `promptFragment` for OAuth-subscription work, but left the "has_face" mention in place; it must be updated here since it's now the actual live text)

**Interfaces:**
- Consumes: nothing (pure deletion).
- Produces: `getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")` (used by `flow/frontend/components/Inspector.tsx:356` for the `youtubeContentTrigger` ConditionsEditor) no longer offers `has_face` as a filterable field — this follows automatically from removing the `contentProps` entry below, no separate Inspector change needed.

- [ ] **Step 1: Remove the prop definition**

In `metadata/props.ts`, remove this entire block (currently at lines 237-247):

```ts
  {
    propId: "has_face",
    isInsight: true,
    dataType: "ENUM_INT",
    entity: ["content"],
    label: { en: "Has Face", zh: "含人脸" },
    enums: [
      { value: 0, label: { en: "No face", zh: "无人脸" } },
      { value: 1, label: { en: "Has face", zh: "含人脸" } },
    ],
  },
```

- [ ] **Step 2: Remove the contentProps entry and its comment**

In `metadata/youtube.ts`, replace:

```ts
      // duration and has_face are computed (not resolveProps-mapped) — declared here with
      // no dataId/value purely so the flow Inspector's ConditionsEditor field list includes
      // them (see getContentTriggerFields in Task 10). resolveProps skips entries with
      // neither `value` nor `dataId`, so these are safe no-ops during ingestion mapping.
      { propId: "duration" },
      { propId: "has_face" },
```

with:

```ts
      // duration is computed (not resolveProps-mapped) — declared here with no dataId/value
      // purely so the flow Inspector's ConditionsEditor field list includes it (see
      // getContentTriggerFields). resolveProps skips entries with neither `value` nor
      // `dataId`, so this is a safe no-op during ingestion mapping.
      { propId: "duration" },
```

- [ ] **Step 3: Remove the "has_face" mention from `nodeTypeRegistry.ts`'s `youtubeContentTrigger` promptFragment**

This line is the live text as of this task (do not use any older snapshot — it was edited by an unrelated concurrent commit after this plan was written):

```ts
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
```

Replace with:

```ts
   - conditions may filter on "duration" (seconds).`,
```

- [ ] **Step 4: Run the metadata-adjacent test suites to confirm nothing references the removed prop**

Run: `cd link && npx vitest run` and `cd flow && npx vitest run` and `cd content && npx vitest run`
Expected: all pass — no test in this repo asserts on `has_face` in `metadata/props.ts` directly (confirmed via `grep -rn "has_face"` before writing this plan; only the files this plan touches referenced it).

- [ ] **Step 5: Commit**

```bash
git add metadata/props.ts metadata/youtube.ts flow/nodeTypeRegistry.ts
git commit -m "feat(metadata): drop has_face content prop (superseded by videoCondition flow node)"
```

---

## Task 5: `flow` — register `videoCondition` in `nodeTypeRegistry.ts` and update the generate-prompt rules text

**Files:**
- Modify: `flow/nodeTypeRegistry.ts`
- Modify: `flow/src/generate-prompt.ts`
- Modify: `flow/tests/unit/generate-prompt.test.ts`

**Interfaces:**
- Produces: `NODE_TYPE_REGISTRY.videoCondition` — `{ reactFlowType: "videoCondition", label: "Video Condition", domain: "content", role: "condition", generatable: true, promptFragment: "..." }`. Tasks 6 and 8 read this entry for engine dispatch and frontend labels.

- [ ] **Step 1: Write the failing tests**

In `flow/tests/unit/generate-prompt.test.ts`:
1. In the `"content domain: documents every generatable content/both node type's fragment..."` test, add `"videoCondition"` to the `for (const key of [...])` array (alongside `"xContentTrigger", "youtubeContentTrigger", "wait", "timeCondition", "abSplit", "webhook"`).
2. Add a new assertion in that same test (after the existing `expect(prompt).toContain('actionType: "tiktokContentAction"');` line):

```ts
    expect(prompt).toContain("videoCondition nodes have sourceHandle \"has-face\", \"no-face\", or \"failed\"");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: FAIL — `NODE_TYPE_REGISTRY.videoCondition` is `undefined` (registry entry doesn't exist yet), and the new sourceHandle sentence isn't in the prompt.

- [ ] **Step 3: Write the implementation**

In `flow/nodeTypeRegistry.ts`, add a new entry after `tiktokContentAction` (still within the "--- content-domain triggers/actions ---" section, since despite the `role: "condition"` classification it is content-domain-only, not `"both"`):

```ts
  videoCondition: {
    reactFlowType: "videoCondition",
    label: "Video Condition",
    description: "Run a model-based check on the content's thumbnail",
    domain: "content",
    role: "condition",
    generatable: true,
    promptFragment: `videoCondition - runs a model-based check on the content's thumbnail, has "has-face"/"no-face"/"failed" branches
   data: { operation: "check-face" }
   - "check-face": detects whether the content's cover image contains a human face. "failed" covers a missing thumbnail or a model error — never guess a result on failure.`,
  },
```

Add `"videoCondition"` to `CONTENT_FLOW_SIDEBAR_ORDER`, after `"tiktokContentAction"`:

```ts
export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "videoCondition",
  "wait", "timeCondition", "abSplit", "webhook",
];
```

In `flow/src/generate-prompt.ts`'s `buildContentDomainPrompt()`, update the two hand-written rule sentences (these are prose, not derived from the registry, so they must be edited by hand or the LLM prompt will contradict the numbered node list that now includes `videoCondition`):

```ts
- Only use xContentTrigger, youtubeContentTrigger, wait, timeCondition, abSplit, webhook, videoCondition, and action (with actionType "xContentAction" or "tiktokContentAction") node types. Do NOT use xTrigger, cronTrigger, waitForEvent, userPropsCondition, changeUserProps, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
- action nodes with actionType "xContentAction" or "tiktokContentAction" have sourceHandle "success" or "failed" for branching
- abSplit nodes have sourceHandle "a" or "b"
- webhook nodes have sourceHandle "success" or "failed"
- videoCondition nodes have sourceHandle "has-face", "no-face", or "failed"
```

(Replace the existing four-line block — `Only use...`, `action nodes...`, `abSplit nodes...`, `webhook nodes...` — with this five-line version; the last line is new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: all tests pass.

Run the full `flow` suite to confirm no regression: `cd flow && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/src/generate-prompt.ts flow/tests/unit/generate-prompt.test.ts
git commit -m "feat(flow): register videoCondition node type + generate-prompt rules"
```

---

## Task 6: `flow` engine — `collectActions` dispatch + canvas connection rules

**Files:**
- Modify: `flow/src/engine.ts`
- Modify: `flow/frontend/store/flow-editor.ts`
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY.videoCondition` (Task 5) — not directly imported by `engine.ts` (which doesn't import the registry today for other condition types either — `webhook`'s branch, for example, is hand-written), but the node's `data.operation` field this task reads is the same field Task 8's Inspector writes.
- Produces: `collectActions` pushes `{ type: "videoCondition", nodeId, operation, hasBranches: true }` onto the `actions` array whenever the graph walk reaches a `videoCondition` node — this is what Task 7's `executeContentActions` consumes.

- [ ] **Step 1: Write the failing test**

Add to `flow/tests/unit/engine.test.ts`, in the same `describe` block that contains the `tiktokContentAction` collectActions tests (follow that block's `FlowGraph`/`executeFlow` pattern exactly):

```ts
  it("collects a videoCondition action, defaulting operation to 'check-face' when unset", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "videoCondition", nodeId: "a1", operation: "check-face", hasBranches: true },
    ]);
  });

  it("carries a set operation through for videoCondition", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: { operation: "check-face" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "videoCondition", nodeId: "a1", operation: "check-face", hasBranches: true },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: FAIL — `result.actions` is `[]` (the graph walk doesn't recognize `videoCondition` yet, and since it's a dead-end with no matching branch it produces no actions and no pendingWaits, so `executeFlow`'s `matched` is even `false` — but the assertion on `result.actions` is what fails here).

- [ ] **Step 3: Write the implementation**

In `flow/src/engine.ts`'s `collectActions`, add a new branch after the `webhook` block (around line 355):

```ts
    if (targetNode.type === "videoCondition") {
      actions.push({ type: "videoCondition", nodeId: targetNode.id, operation: (targetNode.data.operation as string) || "check-face", hasBranches: true });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      continue;
    }
```

In `flow/frontend/store/flow-editor.ts`'s `isValidConnection`, add `"videoCondition"` to both `validTargets` and `validSources`:

```ts
  const validTargets = ["action", "wait", "waitForEvent", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps", "videoCondition"];
  const validSources = ["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger", "wait", "waitForEvent", "action", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps", "videoCondition"];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add flow/src/engine.ts flow/frontend/store/flow-editor.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): collectActions dispatches videoCondition, allow it in canvas connections"
```

---

## Task 7: `flow` queue execution — the `videoCondition` branch in `executeContentActions`

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: `ActionResult` shape from Task 6 (`{ type: "videoCondition", nodeId, operation, hasBranches: true }`); `payload.cover_image_url` (already present on every `content.created` payload, unrelated to this feature); `POST ${env.CONTENT_URL}/internal/detect-face` (Task 2) returning `{ hasFace: boolean }`.
- Produces: resumes the graph via `resumeFromNode(graph, nodeId, payload, branch)` with `branch` one of `"has-face"`, `"no-face"`, `"failed"`.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/queue-content.test.ts`, a new `describe` block after `"queue(): tiktokContentAction dispatch"` (follow that block's exact `afterEach`/`fetchMock`/`makeBatch` pattern):

```ts
describe("queue(): videoCondition dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-video1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-video1'`).run();
    vi.unstubAllGlobals();
  });

  function graphWithVideoCondition() {
    return JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: { operation: "check-face" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: -50 } },
        { id: "a3", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 50 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2", sourceHandle: "has-face" },
        { id: "e3", source: "a1", target: "a3", sourceHandle: "no-face" },
      ],
    });
  }

  it("calls content's /internal/detect-face with the payload's cover_image_url and resumes on the has-face branch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasFace: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-1", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    const call = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/detect-face"));
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.imageUrl).toBe("https://img/thumb.jpg");

    const execution = await env.FLOW_DB.prepare(
      `SELECT * FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-1'`
    ).first();
    expect(execution).toBeTruthy(); // the has-face branch resolved into a2 (noopLeaf), proving the correct branch fired
  });

  it("resumes on the no-face branch when content's /internal/detect-face reports hasFace: false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ hasFace: false }), { status: 200 })));

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-2", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    const execution = await env.FLOW_DB.prepare(
      `SELECT * FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-2'`
    ).first();
    expect(execution).toBeTruthy(); // the no-face branch resolved into a3 (noopLeaf)
  });

  it("resumes on the failed branch when content's /internal/detect-face returns a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Detection failed" }), { status: 502 })));

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-3", channelId: "src-chan",
        payload: { cover_image_url: "https://img/thumb.jpg" },
      }),
      env
    );

    // Neither a2 (has-face) nor a3 (no-face) is wired to the failed branch in this graph, so no
    // downstream node resolves and no content_flow_executions row is written — asserting on the
    // absence of a match is how "it went to failed, not has-face/no-face" is verified here.
    const execution = await env.FLOW_DB.prepare(
      `SELECT * FROM content_flow_executions WHERE flow_id = 'flow-video1' AND content_id = 'content-vid-3'`
    ).first();
    expect(execution).toBeFalsy();
  });

  it("resumes on the failed branch without calling content when cover_image_url is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-video1', 1, 'video flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithVideoCondition()).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-vid-4", channelId: "src-chan",
        payload: {},
      }),
      env
    );

    const detectFaceCall = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/detect-face"));
    expect(detectFaceCall).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: all 4 new tests FAIL (no `videoCondition` handling exists yet in `executeContentActions`, so no `/internal/detect-face` call is ever made and `resumeFromNode` is never invoked for this node).

- [ ] **Step 3: Write the implementation**

In `flow/src/index.ts`'s `executeContentActions`, add a new `else if` branch after the `tiktokContentAction` block (which ends around line 435 with its closing `}` before the `for` loop's own closing brace):

```ts
    } else if (action.type === "videoCondition") {
      const imageUrl = payload?.cover_image_url as string | undefined;
      let branch: "has-face" | "no-face" | "failed" = "failed";

      if (imageUrl) {
        try {
          const res = await fetch(`${env.CONTENT_URL}/internal/detect-face`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
            body: JSON.stringify({ imageUrl }),
          });
          if (res.ok) {
            const body = await res.json() as { hasFace: boolean };
            branch = body.hasFace ? "has-face" : "no-face";
          }
        } catch {
          // network error: branch stays "failed"
        }
      }

      console.log(JSON.stringify({ event: "content_action_video_condition", contentId, branch }));

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

Note: unlike `xContentAction`/`tiktokContentAction`, there is no `rateLimited` check here (no retry machinery for this node, per Global Constraints) — any non-2xx or thrown fetch error simply resolves `branch = "failed"` and proceeds straight to `resumeFromNode`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: all tests pass, including the 4 new ones.

Run the full `flow` suite: `cd flow && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat(flow): execute videoCondition via content's /internal/detect-face, branch has-face/no-face/failed"
```

---

## Task 8: `flow` frontend — node component, Inspector, Sidebar

**Files:**
- Create: `flow/frontend/nodes/VideoConditionNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY.videoCondition` (Task 5) for label/description text.
- Produces: draggable "Video Condition" Sidebar item → canvas node with 3 handles (`has-face`/`no-face`/`failed`) → Inspector showing an Operation dropdown (one entry, "Check Face") that writes `data.operation`.

- [ ] **Step 1: Create the node component**

Create `flow/frontend/nodes/VideoConditionNode.tsx`, following `UserPropsConditionNode.tsx`'s two-handle pattern but with three evenly-spaced handles:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function VideoConditionNode({ data, selected }: NodeProps) {
  const operation = (data.operation as string) || "check-face";
  const summary = operation === "check-face" ? "Check Face" : operation;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-purple-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-purple-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base leading-none">👁️</span>
        <span className="font-semibold text-sm text-purple-700">{NODE_TYPE_REGISTRY.videoCondition.label}</span>
      </div>
      <p className="text-xs text-gray-700">{summary}</p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "25%", transform: "translateY(-50%)" }}>Has Face</span>
      <span className="absolute right-1 text-[10px] text-gray-500" style={{ top: "50%", transform: "translateY(-50%)" }}>No Face</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "75%", transform: "translateY(-50%)" }}>Failed</span>
      <Handle type="source" position={Position.Right} id="has-face" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "25%" }} />
      <Handle type="source" position={Position.Right} id="no-face" className="!bg-gray-400 !w-2.5 !h-2.5" style={{ top: "50%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "75%" }} />
    </div>
  );
}
```

- [ ] **Step 2: Register the node type**

In `flow/frontend/nodes/index.ts`, add the import and registry entry:

```ts
import VideoConditionNode from "./VideoConditionNode";
```

```ts
  videoCondition: VideoConditionNode,
```

(placed after `webhook: WebhookNode,`)

- [ ] **Step 3: Add the Inspector component**

In `flow/frontend/components/Inspector.tsx`, add a new component (near `UserPropsConditionInspector` or `WebhookInspector` — place alongside the other content-flow node inspectors, e.g. near `XContentActionInspector`):

```tsx
const VIDEO_CONDITION_OPERATIONS = [{ value: "check-face", label: "Check Face" }];

function VideoConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.videoCondition.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <OperationSelect
            value={data.operation || "check-face"}
            onChange={(v) => updateNodeData(nodeId, { operation: v })}
            options={VIDEO_CONDITION_OPERATIONS}
          />
        </div>
      </div>
    </div>
  );
}
```

Then register it in the render switch (after the `webhook` block, before the closing `</aside>`):

```tsx
      {node.type === "videoCondition" && (
        <VideoConditionInspector nodeId={node.id} data={node.data as Record<string, any>} />
      )}
```

- [ ] **Step 4: Add the Sidebar draggable item**

In `flow/frontend/components/Sidebar.tsx`, add to the `flowControlItems` array (after the `abSplit` block, before or after `webhook` — order will be resolved by `CONTENT_FLOW_SIDEBAR_ORDER` from Task 5 regardless of declaration order here):

```tsx
  if (visible("videoCondition")) {
    flowControlItems.push({
      key: "videoCondition",
      el: <DraggableItem key="videoCondition" type="videoCondition" label={NODE_TYPE_REGISTRY.videoCondition.label!} description={NODE_TYPE_REGISTRY.videoCondition.description!} color="border-secondary bg-secondary/30" icon="👁️" />,
    });
  }
```

- [ ] **Step 5: Wire up `addNode`'s default data**

In `flow/frontend/store/flow-editor.ts`'s `addNode`, add a new branch (after the `webhook` branch, before `changeUserProps`):

```ts
    } else if (type === "videoCondition") {
      nodeType = "videoCondition";
      data = { operation: "check-face" };
```

- [ ] **Step 6: Manual verification (no automated frontend test in this repo's convention for Inspector components)**

Run `wrangler dev` for `flow` locally (per this project's dev-workflow convention — local wrangler CLI, not a fresh deploy) and in the browser:
1. Build a flow with a `youtubeContentTrigger` node.
2. Drag a "Video Condition" item from the Flow Control section onto the canvas — confirm it renders with the 👁️ icon and three right-side handles labeled Has Face / No Face / Failed.
3. Click it, confirm the Inspector shows "Video Condition" with an Operation dropdown containing only "Check Face".
4. Connect all three handles to distinct downstream nodes, save, confirm no console errors and the graph round-trips correctly (reload the page, confirm the same graph loads).

- [ ] **Step 7: Commit**

```bash
git add flow/frontend/nodes/VideoConditionNode.tsx flow/frontend/nodes/index.ts flow/frontend/components/Inspector.tsx flow/frontend/components/Sidebar.tsx flow/frontend/store/flow-editor.ts
git commit -m "feat(flow): add Video Condition node UI (Sidebar, canvas node, Inspector)"
```

---

## Verification (after all tasks)

1. `cd content && npx vitest run`, `cd link && npx vitest run`, `cd flow && npx vitest run` — full suites green.
2. Deploy `content`, `link` (only if a prior task touched it — this plan's `link` change is ingestion-only, no new route, so `link` still needs redeploying since `youtube-content.ts` changed), and `flow` to dev via `wrangler deploy --env dev` (per this project's convention: local wrangler CLI for dev testing).
3. Manual end-to-end: build a flow `youtubeContentTrigger → videoCondition (Check Face) → xContentAction`, publish it, wait for (or manually trigger) a real YouTube video ingestion, and confirm via Cloudflare logs that `/internal/detect-face` is called exactly once and the correct branch fires.
4. Confirm via logs that a *different* published flow watching the same YouTube channel, with no `videoCondition` node, produces zero `/internal/detect-face` calls when the same video is ingested — this is the core cost-elimination this plan exists to deliver.
