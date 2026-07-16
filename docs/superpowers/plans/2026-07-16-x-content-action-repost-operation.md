# X Content Action Repost Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Repost" as a metadata-driven Operation of the `xContentAction` flow node (backed by a real X repost API call), delete the standalone half-implemented `repost` node type, remove `xContentAction`'s Target Platform selector, and make its "Create Post" Operation's Inspector fields metadata-driven.

**Architecture:** The flow engine (`flow/src/engine.ts`) forwards a node's selected `operation` string through to execution. `flow/src/index.ts`'s content-action executor branches on that operation to call one of two `link` endpoints — the existing `/internal/content/create-post` (generates/posts new text) or a newly-real `/internal/x/repost` (reposts the trigger's own tweet via the triggering channel's account) — both converging on the same success/failed branch-resolution logic. The Inspector's field layout is driven by whether the selected operation's metadata declares an `aiType`-tagged prop, not by a hardcoded operation-name switch.

**Tech Stack:** Cloudflare Workers (Hono), Vitest (`@cloudflare/vitest-pool-workers`), React + Zustand (`flow/frontend`), existing `/metadata/` TypeScript-literal registry.

## Global Constraints

- Repost's account is always the *triggering* channel (`channelId` already threaded through `executeContentActions`) — never a user-picked Target Account. This is specific to Repost; Create Post keeps its existing Target Account picker.
- `xContentAction` becomes X-only: no Target Platform selector anywhere in its Inspector (TikTok gets a separate future node type — out of scope here).
- No credit-charging for the new repost call — matches `create-post`'s existing behavior (content-domain actions don't charge credits today); do not add a new credit gate.
- No new generic "operations" registry/admin UI — metadata stays plain TypeScript array literals, consistent with the rest of `/metadata/`.
- Confirmed via direct read-only query against both `uniscrm-flow-dev` and `uniscrm-flow` (prod) D1: zero existing flows reference the standalone `repost` node type — its removal needs no data migration.
- Frontend: no inline CSS; reuse existing `shared/frontend/ui/*` components only (per repo-wide `CLAUDE.md` convention).
- This codebase has no unit tests for React components (`Inspector.tsx`, `ActionNode.tsx`, `Sidebar.tsx`, `flow-editor.ts` are all untested today) — follow that existing convention; frontend tasks are verified via `npm run typecheck` plus the final manual browser check, not new component tests.

---

### Task 1: Engine forwards `operation`; retires the `repost` action type

**Files:**
- Modify: `flow/src/engine.ts:239-258` (`buildActionData`)
- Test: `flow/tests/unit/engine.test.ts:72-117`

**Interfaces:**
- Produces: `ActionResult` for `actionType === "xContentAction"` now includes `operation: string` (defaults to `"create-post"` when `targetNode.data.operation` is unset). A bare `actionType === "repost"` node (dead type — nothing creates these anymore) no longer gets `hasBranches: true`.

- [ ] **Step 1: Write the failing tests**

In `flow/tests/unit/engine.test.ts`, replace the existing test at lines 73-83 (`"collects a repost action with hasBranches true"`) with:

```ts
  it("no longer grants hasBranches to a bare 'repost' actionType (the standalone repost node type has been removed; it now behaves like any unrecognized actionType)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "repost" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([{ type: "repost", nodeId: "a1", hasBranches: false }]);
  });
```

Then replace the test at lines 85-97 (`"collects an xContentAction action carrying its target channel, prompt, and provider"`) with:

```ts
  it("collects an xContentAction action carrying its operation, target channel, prompt, and provider", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post", channelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "xContentAction", nodeId: "a1", hasBranches: true, operation: "repost-post", targetChannelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" },
    ]);
  });

  it("defaults operation to 'create-post' when not set on an xContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-2" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ operation: "create-post" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: FAIL — the "no longer grants hasBranches" test fails because `repost` still yields `hasBranches: true`; the operation-forwarding tests fail because `operation` is `undefined` in the actual result.

- [ ] **Step 3: Implement**

In `flow/src/engine.ts`, change line 241 from:

```ts
  const isExternalApi = actionType === "xAction" || actionType === "repost" || actionType === "xContentAction";
```

to:

```ts
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction";
```

Change lines 249-253 from:

```ts
  if (actionType === "xContentAction") {
    actionData.targetChannelId = targetNode.data.channelId as string;
    actionData.prompt = targetNode.data.prompt as string;
    actionData.provider = targetNode.data.provider as string;
  }
```

to:

```ts
  if (actionType === "xContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "create-post";
    actionData.targetChannelId = targetNode.data.channelId as string;
    actionData.prompt = targetNode.data.prompt as string;
    actionData.provider = targetNode.data.provider as string;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS (other suites reference `xContentAction`/`repost` but don't assert on `hasBranches` or `operation`, so they're unaffected — confirm no regressions).

- [ ] **Step 6: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): forward operation on xContentAction; retire repost action type"
```

---

### Task 2: Real X repost API call in `link`

**Files:**
- Modify: `link/src/services/x-posts-api.ts`
- Test: `link/tests/services/x-posts-api.test.ts`

**Interfaces:**
- Produces: `repostPost(accessToken: string, sourceUserId: string, tweetId: string): Promise<{ ok: boolean; rateLimited?: boolean }>`, exported from `link/src/services/x-posts-api.ts`.

- [ ] **Step 1: Write the failing tests**

In `link/tests/services/x-posts-api.test.ts`, change the import on line 2 from:

```ts
import { fetchPostsPage, createPost, fetchOwnedLists, fetchListPostsPage } from "../../src/services/x-posts-api";
```

to:

```ts
import { fetchPostsPage, createPost, repostPost, fetchOwnedLists, fetchListPostsPage } from "../../src/services/x-posts-api";
```

Then add this new `describe` block after the existing `createPost` block (after line 94):

```ts
describe("repostPost", () => {
  it("posts tweet_id to /2/users/:id/repost and returns ok:true", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 }));

    const result = await repostPost("tok", "x-user-1", "tweet-999");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/users/x-user-1/repost");
    expect((init as Record<string, any>).headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    const result = await repostPost("tok", "x-user-1", "tweet-999");
    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok:false on other non-ok statuses without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));
    const result = await repostPost("tok", "x-user-1", "tweet-999");
    expect(result).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: FAIL — `repostPost` is not exported yet (import error).

- [ ] **Step 3: Implement**

In `link/src/services/x-posts-api.ts`, add this function after `createPost` (after the existing closing brace, currently the last lines of the file):

```ts
export interface RepostResult {
  ok: boolean;
  rateLimited?: boolean;
}

// https://docs.x.com/x-api/users/repost-post
export async function repostPost(accessToken: string, sourceUserId: string, tweetId: string): Promise<RepostResult> {
  const res = await fetch(`https://api.x.com/2/users/${sourceUserId}/repost`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tweet_id: tweetId }),
  });

  if (res.status === 429) {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    return { ok: false };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/x-posts-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add link/src/services/x-posts-api.ts link/tests/services/x-posts-api.test.ts
git commit -m "feat(link): add repostPost() for the real X repost-post API"
```

---

### Task 3: Real `/internal/x/repost` route (replaces the 501 stub)

**Files:**
- Modify: `link/src/routes-internal.ts`
- Test: `link/tests/services/routes-internal-content.test.ts`

**Interfaces:**
- Consumes: Task 2's `repostPost(accessToken, sourceUserId, tweetId)`.
- Produces: `POST /internal/x/repost` now accepts `{ channelId, contentId, tweetId, flowId? }` and returns `{ ok: boolean, rateLimited?: boolean, rateLimitReset?: string }` (same response shape as `/internal/content/create-post`), instead of always `501 { ok: false, notImplemented: true }`.

- [ ] **Step 1: Write the failing tests**

In `link/tests/services/routes-internal-content.test.ts`, replace the test at lines 51-63 (`"POST /internal/x/repost returns 501 not-implemented"`) with:

```ts
  it("POST /internal/x/repost looks up the channel's X user id and reposts the given tweet", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 })); // X /2/users/:id/repost
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999", flowId: "flow-1" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.x.com/2/users/x-user-src-1/repost");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
    vi.unstubAllGlobals();
  });

  it("returns rateLimited response when X repost is rate-limited", async () => {
    const channelRow = {
      config: JSON.stringify({ x_user_id: "x-user-src-1", access_token: "tok", refresh_token: null }),
      channel_type: "X",
      tenant_id: 1,
    };

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
    expect(typeof body.rateLimitReset).toBe("string");
    vi.unstubAllGlobals();
  });

  it("returns ok:false without calling X when the channel has no X user id", async () => {
    const channelRow = { config: JSON.stringify({ access_token: "tok" }), channel_type: "X", tenant_id: 1 };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "src-chan", contentId: "content-1", tweetId: "tweet-999" }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow) }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: FAIL — the route still returns `501 { ok: false, notImplemented: true }` for every request.

- [ ] **Step 3: Implement**

In `link/src/routes-internal.ts`, change the import on line 10 from:

```ts
import { createPost } from "./services/x-posts-api";
```

to:

```ts
import { createPost, repostPost } from "./services/x-posts-api";
```

Replace the stub block at lines 199-206:

```ts
  // Stub: real X repost API not implemented yet. Content-flow's `repost` action
  // calls this so the flow-engine framework (Task 5/6 in the content-flow-triggers
  // plan) can be built and tested end-to-end without waiting on the real API.
  router.post("/x/repost", async (c) => {
    const { channelId, contentId } = await c.req.json<{ channelId: string; contentId: string; flowId?: string | null }>();
    console.log(JSON.stringify({ event: "repost_stub_called", channelId, contentId }));
    return c.json({ ok: false, notImplemented: true }, 501);
  });
```

with:

```ts
  // Reposts contentId's originating tweet via the channel that ingested it. channelId is
  // always the flow's triggering channel (never a user-picked target) — the Repost Operation
  // has no account picker. tweetId comes from the flow engine's payload.source_content_id.
  router.post("/x/repost", async (c) => {
    const { channelId, contentId, tweetId, flowId } = await c.req.json<{
      channelId: string; contentId: string; tweetId: string; flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB.prepare("SELECT config, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; tenant_id: number }>();
    if (!channel) return c.json({ ok: false }, 200);

    const config = JSON.parse(channel.config);
    const sourceUserId = config.x_user_id;
    if (!sourceUserId) return c.json({ ok: false }, 200);

    const tokenService = new XTokenService(c.env.LINK_DB, c.env.X_CLIENT_ID, c.env.X_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);
    const repostResult = await repostPost(accessToken, sourceUserId, tweetId);

    console.log(JSON.stringify({ event: "x_repost", contentId, channelId, flowId: flowId || null, ok: repostResult.ok, rateLimited: !!repostResult.rateLimited }));

    if (repostResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    return c.json({ ok: repostResult.ok });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/routes-internal-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full link test suite**

Run: `cd link && npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts
git commit -m "feat(link): implement real /internal/x/repost (replaces 501 stub)"
```

---

### Task 4: `flow` executor branches on operation; standalone repost branch removed

**Files:**
- Modify: `flow/src/index.ts:285-359` (`executeContentActions`)
- Test: `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: Task 1's `ActionResult.operation` on `xContentAction` actions; Task 3's real `/internal/x/repost` contract (`{channelId, contentId, tweetId, flowId}` → `{ok, rateLimited?, rateLimitReset?}`).
- Produces: `executeContentActions` no longer has a standalone `action.type === "repost"` branch; the `xContentAction` branch calls `/internal/x/repost` when `action.operation === "repost-post"` (passing the source `channelId` and `payload?.source_content_id` as `tweetId`), otherwise calls `/internal/content/create-post` as before. Both paths converge on the existing `resumeFromNode`/rate-limit/node-log logic unchanged.

- [ ] **Step 1: Write the failing test**

In `flow/tests/unit/queue-content.test.ts`, add this test inside the `describe("queue(): xContentAction branch resolution", ...)` block (after the existing `"interpolates $content.xxx fields..."` test, before the closing `});` at line 257):

```ts

  it("routes a repost-post operation to /internal/x/repost with the source channel and the payload's source_content_id as tweetId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithRepostOp = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-repost-op', 1, 'repost op flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithRepostOp).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-repost-1", channelId: "src-chan", payload: { source_content_id: "tweet-abc-1" } }),
      env
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/internal/x/repost");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ channelId: "src-chan", contentId: "content-repost-1", tweetId: "tweet-abc-1" });

    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-repost-op'`).run();
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: FAIL — `xContentAction` unconditionally calls `/internal/content/create-post` today regardless of `operation`.

- [ ] **Step 3: Implement**

In `flow/src/index.ts`, replace the loop body of `executeContentActions` (lines 297-355, from `if (action.type === "repost")` through the closing of the `updateContentStatus` branch) with:

```ts
    if (action.type === "xContentAction") {
      const operation = (action.operation as string) || "create-post";
      let res: Response;
      let logEvent: string;
      let logExtra: Record<string, unknown>;

      if (operation === "repost-post") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_repost";
        logExtra = { channelId, tweetId };
      } else {
        const targetChannelId = action.targetChannelId as string;
        const provider = action.provider as string;
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, targetChannelId, flowId: flowId || null }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { targetChannelId, provider };
      }

      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: logEvent, contentId, status: res.status, ok: body.ok, ...logExtra }));

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = body.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      // resumed.nodeLogs[0] is always a duplicate exit for `nodeId` itself (already logged when
      // this xContentAction node was first collected as an action) — everything from index 1
      // onward is the genuinely new downstream enter/exit reached by resolving this branch.
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
    } else if (action.type === "updateContentStatus" && action.status) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        await tdb.run(`UPDATE content SET status = ? WHERE id = ?`, [action.status as string, contentId]);
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions (in particular, the existing "resolves the success/failed branch" and "schedules a content_flow_pending retry row" tests must still pass unchanged, since their graphs don't set `operation` and so default to `"create-post"`).

- [ ] **Step 6: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat(flow): route repost-post operation to /internal/x/repost; drop standalone repost branch"
```

---

### Task 5: Inspector — metadata-driven Operation fields

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:11,563-656`

**Interfaces:**
- Consumes: `metadata/x-byok.ts`'s `ContentMetadata_X` (already has `create-post` with `contentProps: [{propId:"message_text", aiType:"TEXT"}]` and `repost-post` with `contentProps: []`); `metadata/props.ts`'s `PROPS` (already has `message_text` labeled `{en:"Text", zh:"文本"}`).
- Produces: `XContentActionInspector` renders Provider (no label, above Prompt) → Prompt (label from `PROPS`) → Target Account only when the selected operation has an `aiType`-tagged `contentProps` entry; otherwise renders only the Operation dropdown. No Target Platform selector anywhere.

- [ ] **Step 1: Implement**

In `flow/frontend/components/Inspector.tsx`, change the import on line 11 from:

```ts
import { ContentActionMetadata_X } from "../../../metadata/x";
```

to:

```ts
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { PROPS } from "../../../metadata/props";
```

Replace lines 563-656 (from `const CONTENT_CHANNEL_TYPES = ...` through the closing `}` of `XContentActionInspector`) with:

```ts
const CONTENT_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");

function XContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);

  const selectedOperation = CONTENT_ACTION_OPERATIONS.find((op) => op.sourceContentType === (data.operation || "create-post"));
  const aiProp = selectedOperation?.contentProps.find((p) => p.aiType);

  useEffect(() => {
    if (!aiProp) { setChannels([]); return; }
    api.channels.list("X").then(setChannels).catch(() => setChannels([]));
  }, [aiProp]);

  useEffect(() => {
    if (!aiProp) return;
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, [aiProp]);

  const promptLabel = aiProp ? PROPS.find((p) => p.propId === aiProp.propId)?.label : undefined;

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">X Content Action</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Operation</Label>
          <Select
            value={data.operation || "create-post"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { operation: e.target.value })}
            className="w-full text-sm"
          >
            {CONTENT_ACTION_OPERATIONS.map((op) => (
              <option key={op.sourceContentType} value={op.sourceContentType}>
                {op.label ? localizeLabel(op.label, "en") : op.sourceContentType}
              </option>
            ))}
          </Select>
        </div>
        {aiProp && (
          <>
            <div>
              <Select
                value={data.provider || "default"}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { provider: e.target.value })}
                className="w-full text-sm"
              >
                <option value="default">Default (free built-in model)</option>
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
                ))}
                <option value="none">None (post prompt text as-is)</option>
              </Select>
            </div>
            <div>
              <Label className="text-xs block mb-1">{promptLabel ? localizeLabel(promptLabel, "en") : "Prompt"}</Label>
              <Textarea
                value={data.prompt || ""}
                onChange={(e: TextareaChange) => updateNodeData(nodeId, { prompt: e.target.value })}
                placeholder="Rewrite this in a punchy tone: $content.content_text"
                rows={5}
                className="w-full text-sm font-mono"
              />
              <p className="text-xs text-muted-foreground mt-1">Use $content.title, $content.content_text etc.</p>
            </div>
            <div>
              <Label className="text-xs block mb-1">Target Account</Label>
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No accounts linked for this platform</p>
              ) : (
                <Select
                  value={data.channelId || ""}
                  onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                  className="w-full text-sm"
                >
                  <option value="">Select account...</option>
                  {channels.map((ch) => <option key={ch.id} value={ch.id}>@{ch.username}</option>)}
                </Select>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd flow && npm run typecheck`
Expected: no errors (in particular, no leftover reference to the deleted `ContentActionMetadata_X` or `CONTENT_CHANNEL_TYPES`).

- [ ] **Step 3: Commit**

```bash
git add flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): make xContentAction Inspector metadata-driven; drop Target Platform"
```

---

### Task 6: Delete the standalone `repost` node type

**Files:**
- Modify: `flow/frontend/nodes/ActionNode.tsx:4,28-31`
- Modify: `flow/frontend/components/Sidebar.tsx:88`
- Modify: `flow/frontend/store/flow-editor.ts:42,128-131`

**Interfaces:**
- Produces: `repost` is no longer a creatable node type anywhere in the editor (Sidebar, `ACTION_TYPES`, `addNode`, `ActionNode` rendering). `xContentAction`'s default node data drops the now-unused `channelType` field (the Inspector hardcodes `"X"` internally per Task 5).

- [ ] **Step 1: Implement**

In `flow/frontend/nodes/ActionNode.tsx`, change line 4 from:

```ts
const EXTERNAL_API_ACTIONS = ["xAction", "repost", "xContentAction"];
```

to:

```ts
const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction"];
```

Remove the `"repost"` branch (lines 28-31) — the `else if (actionType === "repost") { ... }` block — entirely, so the surrounding `if`/`else if` chain flows directly from the preceding branch to the next one.

In `flow/frontend/components/Sidebar.tsx`, delete line 88 (the Repost `<DraggableItem>` entry).

In `flow/frontend/store/flow-editor.ts`, change line 42 from:

```ts
const ACTION_TYPES = ["addToList", "xAction", "repost", "xContentAction", "updateContentStatus"];
```

to:

```ts
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "updateContentStatus"];
```

Remove the `} else if (type === "repost") { data = { actionType: type }; }` branch (lines 128-129) from `addNode`'s action-type dispatch, and change the `xContentAction` branch (line 130-131) from:

```ts
      } else if (type === "xContentAction") {
        data = { actionType: type, channelType: "", channelId: "", prompt: "", provider: "default" };
```

to:

```ts
      } else if (type === "xContentAction") {
        data = { actionType: type, channelId: "", prompt: "", provider: "default" };
```

- [ ] **Step 2: Typecheck**

Run: `cd flow && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full flow test suite**

Run: `cd flow && npx vitest run`
Expected: PASS, no regressions (confirms nothing in `flow/src/*` still depends on the frontend's `repost` wiring — it never did, since engine/index.ts dispatch purely on `data.actionType` string values arriving over the wire, not on frontend UI state).

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/nodes/ActionNode.tsx flow/frontend/components/Sidebar.tsx flow/frontend/store/flow-editor.ts
git commit -m "feat(flow): delete standalone repost node type (superseded by xContentAction's Repost operation)"
```

---

## Manual verification (after all tasks land)

Per repo `CLAUDE.md`'s "coding agent" policy, run this after Task 6:

1. Deploy `flow` and `link` to dev via `wrangler deploy --env dev` (or `npm run dev:worker` locally against dev bindings).
2. In the flow editor (dev), confirm the Sidebar no longer offers a "Repost" drag item, and dragging an "X Content Action" node onto the canvas, then opening its Inspector, shows: Operation dropdown with "Create Post" and "Repost" options, no "Target Platform" dropdown anywhere.
3. With Operation = "Create Post" selected: confirm Provider (no label text) renders directly above the Prompt textarea (labeled "Text"), and a Target Account dropdown appears below.
4. Switch Operation to "Repost": confirm Provider, Prompt, and Target Account all disappear — only the Operation dropdown remains visible.
5. Save the flow graph and confirm it round-trips (reload the page, re-open the Inspector, operation/fields persist correctly).

**Not covered by automated or manual verification:** actually triggering a live repost against a real X account. That requires a dedicated X test account with OAuth already connected in dev and would have a real, public side effect (an actual repost on X) — out of scope to trigger as part of this task's verification. Task 2's and Task 3's mocked-`fetch` tests already cover the request/response contract with the X API in full.
