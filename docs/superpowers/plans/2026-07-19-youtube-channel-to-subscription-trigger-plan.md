# YouTube Trigger: Channel → Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `youtubeContentTrigger` to pick a live YouTube subscription directly from the tenant's OAuth-connected account, removing the current model where "watching" a channel creates a persistent `channels`-table row.

**Architecture:** The node's `data` gains a `subscriptionChannelId`/`subscriptionChannelName` pair (mirroring `xContentTrigger`'s `listId`/`listName`) alongside `channelId` (now the connected `YOUTUBE_ACCOUNT` row, not a per-subscription row). WebSub — the one piece that genuinely needs durable identity, since it's a push protocol — gets its own dedicated `youtube_websub_leases` table, decoupled from `channels` entirely. The renewal cron is broadened to also perform first-subscribe, sourced from the same "scan published flows" pattern `/internal/list-watches` already uses for X.

**Tech Stack:** Cloudflare Workers, Hono, D1, React (flow/link frontends), Google PubSubHubbub.

## Global Constraints

- **Depends on** the companion `content-trigger-no-d1-write` plan (`docs/superpowers/plans/2026-07-19-content-trigger-no-d1-write-plan.md`) — Task 5 of this plan calls `ContentService.recordTriggerContentSeen`/`emitContentTriggerEvent`, which that plan's Task 2 creates. Implement that plan first, or at minimum its Tasks 1–2, before this plan's Task 5.
- **Task order matters**: Task 5 (ingestion context rename) must land before Task 7 (WebSub callback rewrite), since Task 7's callback handler calls `ingestYouTubeVideo` with the `accountChannelId`/`subscriptionChannelId` shape Task 5 defines. Task 5 has no dependency on Task 7 and is independently testable on its own.
- Deleted entirely, no replacement: `findOrCreateWatchedChannel` (`link/src/services/youtube-account.ts`), `POST /api/channels/youtube/subscriptions/:id/watch`, the `YOUTUBE` `channel_type` value and every row it produced. `YOUTUBE_ACCOUNT` (one row per tenant) is untouched.
- New node `data` shape: `{ channelId: string, subscriptionChannelId: string, subscriptionChannelName: string, conditions: Condition[] }`. No `mode` field (YouTube has exactly one trigger mode).
- No data migration for existing dev rows/flows using the old model — dev `channels` rows with `channel_type = 'YOUTUBE'` and any flow referencing the old semantics are cleared manually as part of manual verification, not by this plan's code.
- WebSub subscribe/renew stays entirely cron-driven (no synchronous call added at flow-publish time) — "watching starts after publish" is satisfied by the cron's scan of published flows, bounded by its existing interval.

---

### Task 1: `youtube_websub_leases` table (`link` DB, migration `0007`)

**Files:**
- Create: `link/migrations/0007_youtube_websub_leases.sql`

**Interfaces:**
- Produces: table `youtube_websub_leases(id, tenant_id, account_channel_id, youtube_channel_id, lease_expires_at, created_at, updated_at)`, unique on `(account_channel_id, youtube_channel_id)` — consumed by Task 7 (webhook) and Task 6 (cron).

- [ ] **Step 1: Write the migration**

Create `link/migrations/0007_youtube_websub_leases.sql`:

```sql
CREATE TABLE youtube_websub_leases (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  account_channel_id TEXT NOT NULL,
  youtube_channel_id TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_youtube_leases_account_channel ON youtube_websub_leases(account_channel_id, youtube_channel_id);
CREATE INDEX idx_youtube_leases_tenant ON youtube_websub_leases(tenant_id);
```

- [ ] **Step 2: Apply it to the dev DB**

Run: `wrangler d1 migrations apply uniscrm-link-dev --remote` (adjust binding/env flags to match this repo's existing `link` deploy convention — check `link/wrangler.toml` for the exact D1 binding name if `uniscrm-link-dev` doesn't match).
Expected: migration `0007_youtube_websub_leases` applied with no errors.

- [ ] **Step 3: Commit**

```bash
git add link/migrations/0007_youtube_websub_leases.sql
git commit -m "feat(link): add youtube_websub_leases table"
```

---

### Task 2: Node data shape — registry, flow-editor defaults, engine matching, metadata

**Files:**
- Modify: `metadata/youtube.ts`
- Modify: `flow/nodeTypeRegistry.ts`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/src/engine.ts`
- Test: `flow/tests/unit/engine.test.ts`
- Test: `flow/tests/unit/node-type-registry.test.ts`

**Interfaces:**
- Produces: `youtubeContentTrigger` node `data` shape `{channelId, subscriptionChannelId, subscriptionChannelName, conditions}`; `engine.ts` matches on `payload.channel_id` + `payload.subscription_channel_id`. Consumed by Task 3 (queue consumer bridge that populates `payload.subscription_channel_id`), Task 8 (Inspector).

- [ ] **Step 1: Write the failing tests**

In `flow/tests/unit/engine.test.ts`, replace the `describe("executeFlow: youtubeContentTrigger", ...)` block (lines 72-92 — read the file first to find its exact current closing line, since Task 4/5 of the companion plan may have shifted line numbers by the time this runs) with:

```ts
describe("executeFlow: youtubeContentTrigger", () => {
  it("matches a youtubeContentTrigger node on channelId + subscriptionChannelId for content.created events", () => {
    const graph = {
      nodes: [
        { id: "t1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCabc", subscriptionChannelName: "Channel A", conditions: [] } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph as any, "content.created", { channel_id: "acct1", subscription_channel_id: "UCabc" });
    expect(result.matched).toBe(true);
  });

  it("does not match when subscriptionChannelId differs, even if channelId (the account) matches", () => {
    const graph = {
      nodes: [{ id: "t1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCabc", subscriptionChannelName: "Channel A", conditions: [] } }],
      edges: [],
    };
    const result = executeFlow(graph as any, "content.created", { channel_id: "acct1", subscription_channel_id: "UCother" });
    expect(result.matched).toBe(false);
  });

  it("does not match a youtubeContentTrigger node for a different account channelId", () => {
    const graph = {
      nodes: [{ id: "t1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCabc", subscriptionChannelName: "Channel A", conditions: [] } }],
      edges: [],
    };
    const result = executeFlow(graph as any, "content.created", { channel_id: "acct-other", subscription_channel_id: "UCabc" });
    expect(result.matched).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts -t "youtubeContentTrigger"`
Expected: FAIL — current matching only checks `channelId`, so the "does not match when subscriptionChannelId differs" test incorrectly passes as matched.

- [ ] **Step 3: Add `flowType: "trigger"` to the YouTube metadata entry**

In `metadata/youtube.ts`, change:
```ts
    sourceContentType: "watch:get-videos", // https://developers.google.com/youtube/v3/docs/videos/list
    linkPrefix: "items[]",
```
to:
```ts
    sourceContentType: "watch:get-videos", // https://developers.google.com/youtube/v3/docs/videos/list
    flowType: "trigger",
    linkPrefix: "items[]",
```

- [ ] **Step 4: Update `engine.ts`'s matching condition**

In `flow/src/engine.ts`, change:
```ts
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id)
```
to:
```ts
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && n.data.subscriptionChannelId === payload.subscription_channel_id)
```

- [ ] **Step 5: Update `flow-editor.ts`'s default node data**

In `flow/frontend/store/flow-editor.ts`, change:
```ts
    } else if (type === "youtubeContentTrigger") {
      nodeType = "youtubeContentTrigger";
      data = { channelId: "", channelName: "", conditions: [] };
```
to:
```ts
    } else if (type === "youtubeContentTrigger") {
      nodeType = "youtubeContentTrigger";
      data = { channelId: "", subscriptionChannelId: "", subscriptionChannelName: "", conditions: [] };
```

- [ ] **Step 6: Update `nodeTypeRegistry.ts`'s promptFragment**

In `flow/nodeTypeRegistry.ts`, change the `youtubeContentTrigger` entry's `description` and `promptFragment` from:
```ts
    description: "Watches a public YouTube channel",
    domain: "content",
    role: "trigger",
    generatable: true,
    promptFragment: `youtubeContentTrigger - triggers when a watched YouTube channel publishes a new video
   data: { channelId: "", channelName: "", conditions: [] }
   - channelId is left blank ("") — the user picks an already-watched channel from a dropdown in the Inspector after generation. Channels are added by connecting a YouTube account (OAuth) and selecting from discovered subscriptions on the Social page — not typed here.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
```
to:
```ts
    description: "Watches a subscribed YouTube channel",
    domain: "content",
    role: "trigger",
    generatable: true,
    promptFragment: `youtubeContentTrigger - triggers when a subscribed YouTube channel publishes a new video
   data: { channelId: "", subscriptionChannelId: "", subscriptionChannelName: "", conditions: [] }
   - channelId and subscriptionChannelId are left blank ("") — the user picks a subscription from a dropdown in the Inspector after generation, sourced from their connected YouTube account (OAuth) on the Social page.
   - conditions may filter on "duration" (seconds) and "has_face" (0 or 1, computed from the video's thumbnail).`,
```

- [ ] **Step 7: Update `node-type-registry.test.ts`'s promptFragment assertion**

In `flow/tests/unit/node-type-registry.test.ts` line 151, `expect(NODE_TYPE_REGISTRY.youtubeContentTrigger.promptFragment).toContain("youtubeContentTrigger");` still passes unchanged (the fragment still starts with the literal string `youtubeContentTrigger`) — no edit needed for this specific assertion, but re-run the full file (Step 9) to catch anything else.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts -t "youtubeContentTrigger"`
Expected: all passed

- [ ] **Step 9: Run the full flow unit suite for collateral breakage**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts tests/unit/generate-prompt.test.ts`
Expected: all passed (these reference `youtubeContentTrigger` by name/domain/promptFragment substring only, not its exact `data` shape, so no other changes expected — verify empirically)

- [ ] **Step 10: Commit**

```bash
git add metadata/youtube.ts flow/nodeTypeRegistry.ts flow/frontend/store/flow-editor.ts flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): youtubeContentTrigger data shape becomes channelId+subscriptionChannelId"
```

---

### Task 3: `/internal/youtube-watches` pair shape, queue-consumer bridge, new subscriptions proxy

**Files:**
- Modify: `flow/src/index.ts`
- Modify: `flow/src/types.ts`
- Test: `flow/tests/unit/youtube-watches.test.ts`

**Interfaces:**
- Consumes: Task 2's node data shape.
- Produces: `GET /internal/youtube-watches` returns `{ watches: { channelId: string; subscriptionChannelId: string }[] }` (consumed by Task 6's cron); `FlowQueueMessage.subscriptionChannelId?: string` (consumed by the companion plan's `ContentService.emitContentTriggerEvent` and by Task 5's ingestion path); `GET /api/channels/youtube/subscriptions` proxy (consumed by Task 8's Inspector).

- [ ] **Step 1: Write the failing tests**

Replace `flow/tests/unit/youtube-watches.test.ts` entirely with:

```ts
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/index";

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

function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://flow.test${path}`, { headers });
}

describe("GET /internal/youtube-watches", () => {
  it("rejects requests without the internal secret", async () => {
    const res = await worker.fetch(req("/internal/youtube-watches"), makeEnv([]));
    expect(res.status).toBe(401);
  });

  it("returns distinct (channelId, subscriptionChannelId) pairs from published youtubeContentTrigger nodes", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCa" } },
        { id: "n2", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCa" } }, // dup, same flow
        { id: "n3", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCb" } }, // different subscription, same account
        { id: "n4", type: "xContentTrigger", data: { channelId: "chanX", mode: "get-list-posts", listId: "l1" } }, // ignored, wrong type
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.watches).toEqual([
      { channelId: "acct1", subscriptionChannelId: "UCa" },
      { channelId: "acct1", subscriptionChannelId: "UCb" },
    ]);
  });

  it("skips nodes missing either channelId or subscriptionChannelId", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "", subscriptionChannelId: "UCa" } },
        { id: "n2", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "" } },
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/youtube-watches.test.ts`
Expected: FAIL — current handler returns `{channelId}` only, no `subscriptionChannelId` field, so the pair-shape assertions fail.

- [ ] **Step 3: Add `subscriptionChannelId` to `FlowQueueMessage`**

In `flow/src/types.ts`, change:
```ts
  listId?: string;    // present only for list-sourced content.created events (xContentTrigger List Posts mode)
}
```
to:
```ts
  listId?: string;    // present only for list-sourced content.created events (xContentTrigger List Posts mode)
  subscriptionChannelId?: string; // present only for youtubeContentTrigger's content.created events
}
```

- [ ] **Step 4: Bridge `subscriptionChannelId` through the queue consumer**

In `flow/src/index.ts` line 978, change:
```ts
        const { tenantId, eventType, userId, contentId, channelId, listId, payload } = message.body as FlowQueueMessage;
```
to:
```ts
        const { tenantId, eventType, userId, contentId, channelId, listId, subscriptionChannelId, payload } = message.body as FlowQueueMessage;
```

Line 987, change:
```ts
          const matchPayload = { ...payload, channel_id: channelId, ...(listId ? { list_id: listId } : {}) };
```
to:
```ts
          const matchPayload = {
            ...payload,
            channel_id: channelId,
            ...(listId ? { list_id: listId } : {}),
            ...(subscriptionChannelId ? { subscription_channel_id: subscriptionChannelId } : {}),
          };
```

- [ ] **Step 5: Rewrite `/internal/youtube-watches`**

In `flow/src/index.ts`, replace the existing handler (currently around lines 544-577):
```ts
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
with:
```ts
app.get("/internal/youtube-watches", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) return c.json({ error: "Unauthorized" }, 401);

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE status = 'published' AND graph_json LIKE '%youtubeContentTrigger%'`
  ).all<{ graph_json: string }>();

  const seen = new Set<string>();
  const watches: { channelId: string; subscriptionChannelId: string }[] = [];
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

- [ ] **Step 6: Add the subscriptions proxy route**

In `flow/src/index.ts`, immediately after the existing `x-lists` proxy (currently lines 619-623ish — find `app.get("/api/channels/:channelId/x-lists", ...)` and its closing `});`), add:
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
This route falls under the existing `app.use("/api/channels/*", authMiddleware);` (line 476) — no separate auth wiring needed.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/youtube-watches.test.ts`
Expected: all passed

- [ ] **Step 8: Run the full flow test suite for collateral breakage**

Run: `cd flow && npx vitest run`
Expected: all passed

- [ ] **Step 9: Commit**

```bash
git add flow/src/index.ts flow/src/types.ts flow/tests/unit/youtube-watches.test.ts
git commit -m "feat(flow): youtube-watches pair shape, subscriptionChannelId queue bridge, subscriptions proxy"
```

---

### Task 4: `link` — simplify `GET /youtube/subscriptions`, delete the watch endpoint and `findOrCreateWatchedChannel`

**Files:**
- Modify: `link/src/routes-channels.ts`
- Modify: `link/src/services/youtube-account.ts`
- Test: `link/tests/routes-channels-youtube-account.test.ts`
- Test: `link/tests/services/youtube-account.test.ts`

**Interfaces:**
- Produces: `GET /api/channels/youtube/subscriptions` returns `{ connected: boolean, accountChannelId: string | null, subscriptions: {channelId, channelName, thumbnailUrl}[] }` — consumed by Task 8's Inspector and Task 9's Social-page card.

- [ ] **Step 1: Update the failing/changed tests first**

Replace `link/tests/routes-channels-youtube-account.test.ts` entirely with:

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
  it("returns connected:false and an empty list when no account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);

    expect(await res.json()).toEqual({ connected: false, accountChannelId: null, subscriptions: [] });
  });

  it("returns the account's id and its cached subscriptions, with no already_watching field", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "" }, { channelId: "UC2", channelName: "Two", thumbnailUrl: "" }] }),
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body).toEqual({
      connected: true,
      accountChannelId: "acct1",
      subscriptions: [
        { channelId: "UC1", channelName: "One", thumbnailUrl: "" },
        { channelId: "UC2", channelName: "Two", thumbnailUrl: "" },
      ],
    });
  });
});

describe("DELETE /api/channels/youtube_account (disconnect isolation)", () => {
  it("only deactivates the YOUTUBE_ACCOUNT row — never touches WebSub leases", async () => {
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
    const allUpdateCalls = linkDb.prepare.mock.calls.filter((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"));
    expect(allUpdateCalls).toHaveLength(1);
  });
});
```

In `link/tests/services/youtube-account.test.ts`, delete the entire `describe("findOrCreateWatchedChannel", ...)` block (lines 61-98) and its now-unused import — change line 2 from:
```ts
import { syncYouTubeSubscriptions, findOrCreateWatchedChannel } from "../../src/services/youtube-account";
```
to:
```ts
import { syncYouTubeSubscriptions } from "../../src/services/youtube-account";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts tests/services/youtube-account.test.ts`
Expected: FAIL — current routes still return `already_watching`/no `accountChannelId`, `findOrCreateWatchedChannel` still exists.

- [ ] **Step 3: Simplify the routes**

In `link/src/routes-channels.ts`, remove the now-unused import (line 16):
```ts
import { findOrCreateWatchedChannel } from "./services/youtube-account";
```

Replace the `GET /youtube/subscriptions` and `POST /youtube/subscriptions/:youtubeChannelId/watch` handlers (currently lines 246-293) with just:
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

- [ ] **Step 4: Delete `findOrCreateWatchedChannel`**

In `link/src/services/youtube-account.ts`, delete the `WatchChannelResult` interface and the entire `findOrCreateWatchedChannel` function (lines 25-77), and remove the now-unused `subscribeWebSub` import if `syncYouTubeSubscriptions` doesn't also use it — check: `syncYouTubeSubscriptions` (lines 4-23) does not call `subscribeWebSub`, so change line 2 from:
```ts
import { fetchAllSubscriptions, subscribeWebSub } from "./youtube-api";
```
to:
```ts
import { fetchAllSubscriptions } from "./youtube-api";
```
The file now contains only `syncYouTubeSubscriptions`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts tests/services/youtube-account.test.ts`
Expected: all passed

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-channels.ts link/src/services/youtube-account.ts link/tests/routes-channels-youtube-account.test.ts link/tests/services/youtube-account.test.ts
git commit -m "feat(link): simplify youtube/subscriptions, remove per-subscription watch endpoint and findOrCreateWatchedChannel"
```

---

### Task 5: YouTube ingestion switches to `recordTriggerContentSeen`/`emitContentTriggerEvent`

**Files:**
- Modify: `link/src/services/pollers/youtube-content.ts`
- Test: `link/tests/services/pollers/youtube-content.test.ts`

**Interfaces:**
- Consumes: `ContentService.recordTriggerContentSeen`/`emitContentTriggerEvent` from the companion `content-trigger-no-d1-write` plan's Task 2.
- Produces: `YouTubeIngestContext` gains `accountChannelId`/`subscriptionChannelId` (replacing `channelId`) — consumed by Task 7's webhook call site.

- [ ] **Step 0: Re-read the current file first — it has moved since this plan was written**

A concurrent session already removed `has_face`/`detectFace` computation from this file entirely (`link/src/services/youtube-vision.ts` is deleted; `props.has_face` and the `detectFace` import are gone) as part of an unrelated change moving face-detection to the `content` module, on demand. Read the CURRENT `link/src/services/pollers/youtube-content.ts` before touching anything — the code block in Step 3 below reflects that current state (no `detectFace`, no `has_face`); do not reintroduce them.

- [ ] **Step 1: Write the failing tests**

Read `link/tests/services/pollers/youtube-content.test.ts` first to see its exact current mocking structure (it mirrors `content.test.ts`'s `upsertContentFromMetadata`-based assertions — also already updated by the same concurrent session to drop `has_face`/`detectFace` assertions, so don't reintroduce those either), then replace every assertion that checks a `ContentService.upsertContentFromMetadata` call with an equivalent check against `recordTriggerContentSeen`/`emitContentTriggerEvent`, and every `ctx.channelId` reference in the test's context object with `ctx.accountChannelId`/`ctx.subscriptionChannelId`. Follow the exact same before/after pattern Task 3 of the companion plan used for `x-list-posts.test.ts` (mock `tenantDb.run` returning `{ changes: 1 }` for "new", assert the dedup SQL contains `content_trigger_dedup`, assert `flowQueue.send` receives `subscriptionChannelId` instead of `listId`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: FAIL — current implementation still uses `ctx.channelId`/`upsertContentFromMetadata`.

- [ ] **Step 3: Rewrite `youtube-content.ts`**

Replace `link/src/services/pollers/youtube-content.ts` in full:

```ts
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { ContentService } from "../content";
import { fetchVideoDetails, parseISO8601Duration } from "../youtube-api";
import { resolveProps } from "./resolve-props";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

const YOUTUBE_METADATA = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

export interface YouTubeIngestContext {
  accountChannelId: string;
  subscriptionChannelId: string;
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
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);

  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  props.duration = durationIso ? parseISO8601Duration(durationIso) : 0;

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue);
  const sourceContentId = String(props.source_content_id ?? "");
  const isNew = await contentService.recordTriggerContentSeen(ctx.accountChannelId, ctx.subscriptionChannelId, sourceContentId);
  if (isNew) {
    await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, props);
  }
  console.log(JSON.stringify({ event: "youtube_video_ingested", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, isNew }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add link/src/services/pollers/youtube-content.ts link/tests/services/pollers/youtube-content.test.ts
git commit -m "feat(link): YouTube ingestion uses recordTriggerContentSeen/emitContentTriggerEvent, accountChannelId/subscriptionChannelId context"
```

---

### Task 6: Renewal cron becomes subscribe-new-or-renew, sourced from `youtube_websub_leases`

**Files:**
- Modify: `link/src/cron.ts`
- Test: `link/tests/cron-youtube-renewal.test.ts`

**Interfaces:**
- Consumes: `/internal/youtube-watches`'s new pair shape (Task 3), `youtube_websub_leases` (Task 1).

- [ ] **Step 1: Write the failing tests**

Replace `link/tests/cron-youtube-renewal.test.ts` entirely with:

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
      LINK_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) }) }) },
      WEB_DB: { prepare: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) }) },
      FLOW_URL: "https://flow.example",
      LINK_URL: "https://link.example",
      INTERNAL_SECRET: "secret",
      X_BEARER_TOKEN: "", TIKTOK_CLIENT_KEY: "", TIKTOK_CLIENT_SECRET: "",
      TREND_RETENTION_DAYS: "30",
      ...overrides,
    } as any;
  }

  it("subscribes a pair referenced by a published flow with no existing lease", async () => {
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/acct1/UCabc"), "UCabc");
  });

  it("renews a pair whose lease is nearing expiry", async () => {
    const nearExpiry = new Date(Date.now() + 60_000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ lease_expires_at: nearExpiry }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/acct1/UCabc"), "UCabc");
  });

  it("does not renew a pair whose lease is not close to expiry", async () => {
    const farExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM youtube_websub_leases WHERE")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ lease_expires_at: farExpiry }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), run: vi.fn().mockResolvedValue({ success: true }) }) };
      }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [{ channelId: "acct1", subscriptionChannelId: "UCabc" }] });
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("skips a pair not referenced by any published flow, without unsubscribing or touching its lease row", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) }) }),
    };
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const unsubscribeSpy = vi.spyOn(youtubeApi, "unsubscribeWebSub").mockResolvedValue(undefined);

    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/internal/youtube-watches")) return jsonResponse({ watches: [] }); // nothing referenced
      if (url.includes("/internal/list-watches")) return jsonResponse({ watches: [] });
      return jsonResponse({});
    });

    await handleCron(baseEnv({ LINK_DB: linkDb }));

    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
  });

  it("does not touch subscriptions when the watches fetch fails", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }), first: vi.fn().mockResolvedValue(null) }) }) };
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
Expected: FAIL — current `handleYouTubeRenewal` queries `channels WHERE channel_type = 'YOUTUBE'`, not the new pair-driven `youtube_websub_leases` lookup.

- [ ] **Step 3: Rewrite `handleYouTubeRenewal`**

In `link/src/cron.ts`, replace the function (currently lines 197-240):

```ts
async function handleYouTubeRenewal(env: Env): Promise<void> {
  let watches: { channelId: string; subscriptionChannelId: string }[];
  try {
    const res = await fetch(`${env.FLOW_URL}/internal/youtube-watches`, {
      headers: { "X-Internal-Secret": env.INTERNAL_SECRET },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    ({ watches } = (await res.json()) as { watches: { channelId: string; subscriptionChannelId: string }[] });
  } catch (e) {
    // Don't touch any subscription if we can't confirm what's still referenced —
    // an unsubscribe based on stale/missing data would silently kill a live trigger.
    console.error(JSON.stringify({ event: "youtube_watches_fetch_error", error: String(e) }));
    return;
  }

  for (const { channelId: accountChannelId, subscriptionChannelId: youtubeChannelId } of watches) {
    const leaseRow = await env.LINK_DB
      .prepare("SELECT lease_expires_at FROM youtube_websub_leases WHERE account_channel_id = ? AND youtube_channel_id = ?")
      .bind(accountChannelId, youtubeChannelId)
      .first<{ lease_expires_at: string | null }>();

    const expiresAt = leaseRow?.lease_expires_at ? new Date(leaseRow.lease_expires_at).getTime() : 0;
    // No lease row at all (never subscribed) or nearing expiry — (re)subscribe either way.
    if (leaseRow && expiresAt - Date.now() > YOUTUBE_RENEWAL_WINDOW_MS) continue;

    try {
      await subscribeWebSub(`${env.LINK_URL}/youtube/websub/${accountChannelId}/${youtubeChannelId}`, youtubeChannelId);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_resubscribe_error", account_channel_id: accountChannelId, subscription_channel_id: youtubeChannelId, error: String(e) }));
    }
  }
}
```

`YOUTUBE_RENEWAL_WINDOW_MS` (line 195) is unchanged. Pairs no longer referenced by any published flow are simply absent from `watches` and never looked up — matching the prior behavior's "let the lease lapse on its own" comment, now implicit rather than an explicit early-`continue`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/cron-youtube-renewal.test.ts`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add link/src/cron.ts link/tests/cron-youtube-renewal.test.ts
git commit -m "feat(link): renewal cron subscribes new (channelId, subscriptionChannelId) pairs, not just renews"
```

---

### Task 7: WebSub callback becomes two-part, backed by `youtube_websub_leases`

**Files:**
- Modify: `link/src/webhook-youtube.ts`
- Test: `link/tests/webhook-youtube.test.ts`

**Interfaces:**
- Consumes: `youtube_websub_leases` table from Task 1; `YouTubeIngestContext`'s `accountChannelId`/`subscriptionChannelId` shape from Task 5.
- Produces: `GET|POST /youtube/websub/:accountChannelId/:youtubeChannelId` — the URL shape Task 6's cron constructs subscribe calls against.

- [ ] **Step 1: Write the failing tests**

Replace `link/tests/webhook-youtube.test.ts` entirely with:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
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

  it("GET /websub/:accountChannelId/:youtubeChannelId echoes hub.challenge and upserts the lease", async () => {
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindSpy = vi.fn().mockReturnValue({ run: runMock, first: vi.fn().mockResolvedValue({ tenant_id: 1 }) });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindSpy }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request(
      "/youtube/websub/acct1/UCabc?hub.challenge=abc123&hub.lease_seconds=432000&hub.topic=t&hub.mode=subscribe",
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    const upsertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO youtube_websub_leases"));
    expect(upsertCall).toBeTruthy();
    expect(upsertCall![0]).toContain("ON CONFLICT(account_channel_id, youtube_channel_id)");
    const bindArgs = bindSpy.mock.calls.find((c: unknown[]) => c.includes("acct1") && c.includes("UCabc"));
    expect(bindArgs).toBeTruthy();
  });

  it("GET /websub/:accountChannelId/:youtubeChannelId returns 400 when hub.challenge is missing", async () => {
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() } });
    const res = await app.request("/youtube/websub/acct1/UCabc", {}, env);
    expect(res.status).toBe(400);
  });

  it("POST /websub/:accountChannelId/:youtubeChannelId extracts videoIds and ingests each one", async () => {
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
    const res = await app.request("/youtube/websub/acct1/UCabc", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy.mock.calls[0][1]).toBe("vid1");
    expect(ingestSpy.mock.calls[0][0]).toMatchObject({ accountChannelId: "acct1", subscriptionChannelId: "UCabc", tenantId: 1 });
  });

  it("POST /websub/:accountChannelId/:youtubeChannelId is a no-op when there's no matching lease", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const atomBody = `<entry><yt:videoId>vid1</yt:videoId></entry>`;
    const res = await app.request("/youtube/websub/unknown-acct/UCabc", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/webhook-youtube.test.ts`
Expected: FAIL — current routes take a single `:channelId` param and query `channels`, not `youtube_websub_leases`.

- [ ] **Step 3: Rewrite `webhook-youtube.ts`**

Replace `link/src/webhook-youtube.ts` in full:

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

  // WebSub verification handshake: echo hub.challenge back, and upsert the granted lease
  // into youtube_websub_leases (keyed on the account + subscribed-channel pair, not a
  // channels-table row) so the renewal cron knows when to re-subscribe.
  router.get("/websub/:accountChannelId/:youtubeChannelId", async (c) => {
    const challenge = c.req.query("hub.challenge");
    if (!challenge) return c.text("Missing hub.challenge", 400);

    const accountChannelId = c.req.param("accountChannelId");
    const youtubeChannelId = c.req.param("youtubeChannelId");
    const leaseSeconds = c.req.query("hub.lease_seconds");
    if (leaseSeconds) {
      const accountRow = await c.env.LINK_DB
        .prepare("SELECT tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT' AND is_active = 1")
        .bind(accountChannelId)
        .first<{ tenant_id: number }>();
      if (accountRow) {
        const leaseExpiresAt = new Date(Date.now() + parseInt(leaseSeconds, 10) * 1000).toISOString();
        await c.env.LINK_DB
          .prepare(
            `INSERT INTO youtube_websub_leases (id, tenant_id, account_channel_id, youtube_channel_id, lease_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(account_channel_id, youtube_channel_id) DO UPDATE SET
               lease_expires_at = excluded.lease_expires_at, updated_at = datetime('now')`
          )
          .bind(crypto.randomUUID(), accountRow.tenant_id, accountChannelId, youtubeChannelId, leaseExpiresAt)
          .run();
      }
    }

    return c.text(challenge);
  });

  router.post("/websub/:accountChannelId/:youtubeChannelId", async (c) => {
    const accountChannelId = c.req.param("accountChannelId");
    const youtubeChannelId = c.req.param("youtubeChannelId");
    const body = await c.req.text();
    const videoIds = extractVideoIds(body);
    if (videoIds.length === 0) return c.text("ok");

    const row = await c.env.LINK_DB
      .prepare(
        `SELECT c.tenant_id as tenant_id
         FROM youtube_websub_leases l
         JOIN channels c ON c.id = l.account_channel_id
         WHERE l.account_channel_id = ? AND l.youtube_channel_id = ? AND c.is_active = 1`
      )
      .bind(accountChannelId, youtubeChannelId)
      .first<{ tenant_id: number | null }>();
    if (!row?.tenant_id) {
      console.log(JSON.stringify({ event: "youtube_websub_unknown_lease", account_channel_id: accountChannelId, youtube_channel_id: youtubeChannelId }));
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
            accountChannelId,
            subscriptionChannelId: youtubeChannelId,
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
        console.error(JSON.stringify({ event: "youtube_websub_ingest_error", account_channel_id: accountChannelId, subscription_channel_id: youtubeChannelId, video_id: videoId, error: String(e) }));
      }
    }

    return c.text("ok");
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/webhook-youtube.test.ts`
Expected: all passed

- [ ] **Step 5: Run the full link test suite for collateral breakage**

Run: `cd link && npx vitest run`
Expected: all passed

- [ ] **Step 6: Commit**

```bash
git add link/src/webhook-youtube.ts link/tests/webhook-youtube.test.ts
git commit -m "feat(link): WebSub callback becomes accountChannelId/youtubeChannelId, backed by youtube_websub_leases"
```

---

### Task 8: Flow Inspector — pick a subscription directly

**Files:**
- Modify: `flow/frontend/lib/api.ts`
- Modify: `flow/frontend/components/Inspector.tsx`

**Interfaces:**
- Consumes: `GET /api/channels/youtube/subscriptions` proxy from Task 3.

- [ ] **Step 1: Add the API client function**

In `flow/frontend/lib/api.ts`, add to the `channels` object (after the existing `xLists` entry):
```ts
    youtubeSubscriptions: () =>
      request<{ connected: boolean; accountChannelId: string | null; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>(
        `/api/channels/youtube/subscriptions`
      ),
```

- [ ] **Step 2: Rewrite `YouTubeContentTriggerInspector`**

In `flow/frontend/components/Inspector.tsx`, replace the function (currently lines 315-362):

```tsx
function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const subscriptionChannelId = data.subscriptionChannelId as string;
  const [state, setState] = useState<{ connected: boolean; accountChannelId: string | null; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>({
    connected: false, accountChannelId: null, subscriptions: [],
  });

  useEffect(() => {
    api.channels.youtubeSubscriptions()
      .then(setState)
      .catch(() => setState({ connected: false, accountChannelId: null, subscriptions: [] }));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Subscription</Label>
          {!state.connected ? (
            <p className="text-xs text-muted-foreground italic">
              Connect your YouTube account from the Social page to pick a subscription.
            </p>
          ) : state.subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No subscriptions found — check your YouTube account has subscriptions.
            </p>
          ) : (
            <Select
              value={subscriptionChannelId || ""}
              onChange={(e: SelectChange) => {
                const sub = state.subscriptions.find((s) => s.channelId === e.target.value);
                updateNodeData(nodeId, {
                  channelId: state.accountChannelId || "",
                  subscriptionChannelId: e.target.value,
                  subscriptionChannelName: sub?.channelName || "",
                });
              }}
              className="w-full text-sm"
            >
              <option value="">Select subscription...</option>
              {state.subscriptions.map((sub) => (
                <option key={sub.channelId} value={sub.channelId}>{sub.channelName}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when this subscription publishes a new video.</p>

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

The `ChannelOption` interface (lines 24-27) is still used by other Inspector functions (e.g. `XActionInspector`'s `channels` state) — do not remove it.

- [ ] **Step 3: Manual verification (no automated frontend test suite for Inspector components in this codebase — confirmed by absence of any `Inspector.test.tsx`)**

Run `cd flow && wrangler dev` (or the repo's standard local dev command for the `flow` frontend), open a content-domain flow, add a `youtubeContentTrigger` node, and confirm: (a) with no connected YouTube account, the Inspector shows the "connect your account" message; (b) with a connected account and subscriptions, the dropdown lists them by name and selecting one sets `channelId`/`subscriptionChannelId`/`subscriptionChannelName` correctly (inspect via the browser's React DevTools or a temporary `console.log` in `updateNodeData`); (c) saving and reloading the flow preserves the selection.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/lib/api.ts flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): youtubeContentTrigger Inspector picks a subscription directly from the connected account"
```

---

### Task 9: Social page — strip `YouTubeAccountCard` down to connect/disconnect + count

**Files:**
- Modify: `link/frontend/hooks/useYouTubeAccount.ts`
- Modify: `link/frontend/components/SocialChannels.tsx`
- Modify: `link/frontend/lib/api.ts`

**Interfaces:**
- Consumes: `GET /api/channels/youtube/subscriptions`'s new response shape from Task 4 (no more `already_watching`); `POST /youtube/subscriptions/:id/watch` no longer exists.

- [ ] **Step 1: Remove the watch-endpoint API client function and update the subscriptions response type**

In `link/frontend/lib/api.ts`, delete:
```ts
    youtubeWatchSubscription: (youtubeChannelId: string) =>
      request<{ channelId: string; channelName: string; thumbnailUrl: string }>(
        `/channels/youtube/subscriptions/${youtubeChannelId}/watch`,
        { method: "POST" }
      ),
```
and change:
```ts
    youtubeSubscriptions: () =>
      request<{ subscriptions: { channelId: string; channelName: string; thumbnailUrl: string; already_watching: boolean }[] }>(
        "/channels/youtube/subscriptions"
      ),
```
to:
```ts
    youtubeSubscriptions: () =>
      request<{ connected: boolean; accountChannelId: string | null; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>(
        "/channels/youtube/subscriptions"
      ),
```

- [ ] **Step 2: Simplify `useYouTubeAccount`**

Replace `link/frontend/hooks/useYouTubeAccount.ts` in full — this hook no longer needs to load or expose the subscription list at all, since the Social page only shows a count (already present in `status`'s `subscription_count`):

```ts
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

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

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll status while sync is in flight (the initial subscriptions.list pagination
  // happens in a background waitUntil task on the server).
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
  };

  return { ...state, connect, disconnect };
}
```

- [ ] **Step 3: Simplify `YouTubeAccountCard`**

In `link/frontend/components/SocialChannels.tsx`, replace the function (currently lines 393-455):

```tsx
function YouTubeAccountCard({ locale }: { locale: Locale }) {
  const { connected, email, syncStatus, subscriptionCount, createdAt, connect, disconnect } = useYouTubeAccount();

  const status = !connected ? "disconnected" : syncStatus === "pending" ? "pending" : "connected";

  return (
    <ChannelCard
      logo={<span className="text-2xl leading-none">▶️</span>}
      name="YouTube"
      tagline={{
        en: "Connect your YouTube account — pick which subscriptions to watch from a flow's trigger.",
        zh: "连接你的YouTube账号——在flow的trigger里选择要监控的订阅频道。",
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
          <p className="text-xs text-muted-foreground">{subscriptionCount} subscription{subscriptionCount === 1 ? "" : "s"} available</p>
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

- [ ] **Step 4: Manual verification**

Run the `link` frontend locally, open the Social page, and confirm: (a) disconnected state shows "Connect YouTube"; (b) after connecting (or against a dev tenant already connected), the card shows email, sync status, and a subscription count with no per-subscription list or "Watch" buttons; (c) disconnect still works.

- [ ] **Step 5: Commit**

```bash
git add link/frontend/hooks/useYouTubeAccount.ts link/frontend/components/SocialChannels.tsx link/frontend/lib/api.ts
git commit -m "feat(link): simplify Social page YouTube card to connect/disconnect + subscription count"
```

---

## Manual dev verification (after all tasks)

1. Clear dev's stale data: `SELECT id FROM channels WHERE channel_type = 'YOUTUBE'` on the dev tenant DB(s) that were used to verify the old model, delete those rows, and delete/republish any dev flow whose `youtubeContentTrigger` node still has the old `{channelId, channelName}` shape.
2. Deploy `link` and `flow` to dev.
3. Confirm `link/migrations/0007_youtube_websub_leases.sql` applied: `wrangler d1 execute <link-dev-db> --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_websub_leases'"`.
4. In the flow editor, add a `youtubeContentTrigger` node, confirm the Inspector shows the connect-account empty state (if disconnected) or the live subscription picker (if connected), select a subscription, save, and publish the flow.
5. Wait one cron cycle (or manually trigger `link`'s scheduled handler in dev) and confirm a `youtube_websub_leases` row appears for the published (accountChannelId, subscriptionChannelId) pair.
6. Trigger a real WebSub notification (e.g. wait for the watched channel to publish, or manually POST a synthetic Atom payload to the dev callback URL) and confirm the flow fires exactly once.
7. On the Social page, confirm the YouTube card shows only connect/disconnect + subscription count, with no per-subscription picker.
