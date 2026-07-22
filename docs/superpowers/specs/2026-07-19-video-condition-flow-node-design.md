# Video Condition Flow Node Design

## Context

The YouTube content trigger ([2026-07-18-youtube-content-trigger-design.md](2026-07-18-youtube-content-trigger-design.md)) computes `has_face` — a Workers AI (`@cf/moondream/moondream3.1-9B-A2B`) face-detection check on each video's thumbnail — unconditionally in the ingestion poller (`link/src/services/pollers/youtube-content.ts`), before any flow is evaluated. Every ingested video pays the model-call cost, regardless of whether any published flow's `youtubeContentTrigger` conditions actually filter on `has_face`. Zero existing dev-tenant flows reference `has_face` today, so there is no migration burden in changing this.

This design moves face-detection (and any future model-based video/thumbnail check) from **ingestion-time, always-on** to **flow-evaluation-time, on-demand** — gated by whether a published flow's graph actually contains a new `videoCondition` node downstream of its trigger. A flow that doesn't use the node never triggers the model call at all.

## Scope

- New `videoCondition` flow node (own `reactFlowType`, not folded into the shared `action`/`actionType` pattern) — same architectural shape as the existing `webhook` node: real I/O, its own dedicated type, result-based branching. Placed in the content-flow Sidebar's "Flow Control" section.
- One operation for v1: **Check Face** (`data.operation === "check-face"`), reusing the exact Moondream "detect target phrase in image" call already built for `has_face`, just relocated. The node's `operation` field is a dropdown scaffolded for future operations (e.g. object detection) even though only one entry exists today — different operations may need different per-operation config and this avoids reshaping the node's data contract later.
- Not restricted to a YouTube-sourced trigger specifically — placement is gated the same way every other content-domain node is (`domain: "content"` in `nodeTypeRegistry.ts`), so any future video-content trigger (X video, TikTok video) could use the same node without further engine changes.
- Three branches: `has-face` / `no-face` / `failed`. `failed` covers model error, non-2xx from the internal route, and a missing/empty `cover_image_url` on the triggering content — no fail-open/fail-closed guessing, no retry.
- Model-invocation logic relocates from `link` (`youtube-vision.ts`) into `content`, exposed as a new internal route, since this is pure AI inference on an already-resolved image URL — not a channel interaction (`link`'s stated domain).
- `has_face` dropped entirely: no longer computed at ingestion, no longer a persisted `content` prop, no longer filterable via `youtubeContentTrigger`'s inline `conditions`.

## Out of scope

- Any new per-tenant rate limit/quota for this node — matches `tiktokContentAction`'s image-generation precedent (uncapped beyond Cloudflare's own Workers AI limits). Revisit only if real usage volume becomes a measured problem.
- Retry-on-rate-limit machinery — `content`'s existing `/generate` and `/generate-image` routes have none for internal Workers AI calls (that mechanism is specific to TikTok's external-platform 429s), and this node follows the same precedent: any failure goes straight to `failed`.
- Caching/persisting the check result for reuse across multiple flows hitting the same content — dropped along with `has_face` (see Q5 rationale below); if duplicate-check volume becomes real, add caching against measured data then.
- Any change to `xContentAction`, `tiktokContentAction`, or non-video content sources.
- A second operation (e.g. object detection) — the dropdown scaffold exists, but only "Check Face" ships.

## 1. `content` module: relocated model call + new internal route

**New file `content/src/services/vision.ts`** (moved from `link/src/services/youtube-vision.ts`, logic unchanged):

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

Note the return type changes from `0 | 1` (fail-closed default baked in) to a plain `boolean` with **no internal try/catch** — the caller (the new internal route) is responsible for turning a thrown error into the route's own error response, which `flow` then maps to the `failed` branch. Fail-open/fail-closed guessing is removed; errors are surfaced, not hidden (see Q7/Q10 in the grilling transcript this spec is based on).

**`content/src/routes-internal.ts`**: new route, same shape as `/generate-image`:

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

`link/src/services/youtube-vision.ts` is deleted; its one caller (`link/src/services/pollers/youtube-content.ts`) is updated per §3.

## 2. `flow` module: new node type, engine dispatch, queue execution

**`flow/nodeTypeRegistry.ts`**: new entry, following the `webhook` precedent exactly:

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

Added to `CONTENT_FLOW_SIDEBAR_ORDER` after `tiktokContentAction`.

**`flow/src/engine.ts`**:
- `collectActions`: new `else if (targetNode.type === "videoCondition")` branch, pushing `{ type: "videoCondition", nodeId: targetNode.id, operation: targetNode.data.operation || "check-face", hasBranches: true }` onto `actions` — mirrors the `webhook`/`xContentAction` pattern of building an `ActionResult` synchronously; the actual model call happens later in the async queue consumer.
- `validTargets`/`validSources` (`flow/frontend/store/flow-editor.ts`): add `"videoCondition"` to both lists, same as `webhook`.

**`flow/src/index.ts`** (`executeContentActions`): new `else if (action.type === "videoCondition")` branch:
- Reads `payload.cover_image_url` (already present on every `content.created` payload via `resolvedProps` — confirmed independent of any `has_face` computation, so no new plumbing needed to obtain it).
- If missing/empty: skip the network call entirely, log `content_action_video_condition` with `result: "failed"`, resume via `resumeFromNode(graph, action.nodeId, payload, "failed")`.
- Otherwise: `POST ${env.CONTENT_URL}/internal/detect-face` with `{ imageUrl: payload.cover_image_url }`. On non-2xx or fetch error: `resumeFromNode(..., "failed")`. On 2xx: `resumeFromNode(..., data.hasFace ? "has-face" : "no-face")`.
- Same `pendingWaits` walk as `xContentAction`/`tiktokContentAction` after resuming (a `wait` node downstream of any branch must still be scheduled correctly).
- No `rateLimited` handling — any failure is terminal for this node's evaluation (see Out of scope).

## 3. `link` module: drop `has_face` from ingestion

**`link/src/services/pollers/youtube-content.ts`**: remove the `detectFace` import and the line:

```ts
props.has_face = thumbnailUrl ? await detectFace(ctx.ai, thumbnailUrl) : 1;
```

`resolvedProps`/`props` continues to include `cover_image_url` as before (used by §2's queue-time check) — only the `has_face` computation is removed, nothing else about ingestion changes.

## 4. `metadata`: drop `has_face`

- `metadata/props.ts`: remove the `has_face` prop definition (lines ~230-245 today).
- `metadata/youtube.ts`: remove the `{ propId: "has_face" }` contentProps entry and its explanatory comment.
- `flow/nodeTypeRegistry.ts`: update `youtubeContentTrigger`'s `promptFragment` — drop the `"has_face"` mention from the conditions-filtering note (conditions may still filter on `"duration"`, the check-face capability moves entirely to the new node).
- `flow/frontend` condition-field pickers for `youtubeContentTrigger`'s inline `ConditionsEditor` (wherever `has_face` is offered as a filterable field) drop that option.

## 5. Frontend: `VideoConditionInspector`

New Inspector component (`flow/frontend/components/Inspector.tsx`), following the `xAction`/`OperationSelect` pattern — an "Operation" dropdown with one entry ("Check Face"), no other config fields for this operation. New node component (`flow/frontend/nodes/VideoConditionNode.tsx`) rendering the three output handles (`has-face` / `no-face` / `failed`), mirroring `WebhookNode.tsx`'s `success`/`failed` handle rendering. New Sidebar draggable item in the "Flow Control" section, icon `👁️` (not used by any other content-flow node today: `𝕏`, `▶️`, `✨`, `📸`, `⏳`, `🕐`, `⚡`, `🔗`).

## Verification

1. `cd content && npx vitest run` — new test for `/internal/detect-face` (mock `AI.run`, assert `hasFace: true`/`false`/502-on-throw).
2. `cd flow && npx vitest run` — engine test asserting `collectActions` produces a `videoCondition` action; queue-consumer test asserting all three branches (`has-face`/`no-face`/`failed` including missing-image case) resume the graph correctly and that `pendingWaits` still fires for a downstream `wait` node.
3. `cd link && npx vitest run` — updated `youtube-content.ts` poller test confirms no `detectFace` call and no `has_face` field written.
4. Manual: deploy dev, build a flow `youtubeContentTrigger → videoCondition (Check Face) → xContentAction`, trigger a real ingested video, confirm the correct branch fires and the model call only happens for flows that include the node (spot-check by ingesting the same channel through a flow with no `videoCondition` node and confirming no `/internal/detect-face` call in logs).
