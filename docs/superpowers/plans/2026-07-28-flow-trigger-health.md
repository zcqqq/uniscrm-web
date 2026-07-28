# Flow Trigger Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当一个 published flow 的 trigger 所绑定的 channel 已被解除认证（或压根没选 channel）时，列表页用红色 `Trigger Disconnected` 取代绿色 `Published`，并在 publish 时拦住这种 flow。

**Architecture:** flow worker 在读列表和发布时，向 link 要一次"该租户所有 active channel id"的集合，再拿 flow 的 `graph_json` 里那个唯一 trigger 节点的 `channelId` 去比对。判定结果是**派生态**，不写回 `flows.status`——用户重新授权后 channel 行的 id 不变（`link/src/oauth.ts:602` 的 `ON CONFLICT ... DO UPDATE SET is_active = 1` 复用原行），红色会自己消失。

**Tech Stack:** Cloudflare Workers + Hono + D1；前端 React + Vite + shadcn/ui；测试 vitest + `@cloudflare/vitest-pool-workers`。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-07-28-flow-trigger-health-design.md`。有冲突以 spec 为准。
- **只检查 trigger 的 channel**，绝不检查 action 的 channel。
- 失效口径：`channelId` 为空字符串/缺失，**或**不在该租户的 active channel 集合中。不检查 token 健康度。
- `cronTrigger` 永不判定为失效（它不绑 channel）。没有 trigger 节点的 flow 也不判定为失效。
- **不写 `flows.status`**，不 auto-unpublish，不加数据库列，不加 migration。
- link 不可用时：`GET /api/flows` **fail-open**（当作全部健康）；`POST /api/flows/:id/publish` **fail-closed**（503 中断，不写库）。
- flow 的 trigger 节点类型判定一律用 `NODE_TYPE_REGISTRY[node.type]?.role === "trigger"`（`flow/nodeTypeRegistry.ts`，`src/generate-prompt.ts` 已在 import），**不要在后端另写一份硬编码的 trigger 类型列表**。
- 前端不用 inline CSS，用 `shared/frontend/ui` 里的组件。
- 每个 task 结束时 `git add <明确列出的文件>` 后提交；**绝不 `git add -A`**（这个仓库同时有别的 session 在改别的模块，`git add -A` 会把别人未完成的改动一起提交，已经翻车过两次）。**不要 push**。
- 全局 `wrangler`，不要 `npx wrangler`（npx 会拿到过期的本地 4.86）。

---

### Task 1: link 的 active-channel 内部接口

**Files:**
- Modify: `uniscrm-web/link/src/routes-internal.ts`（在 `router.post("/lists/:id/users", ...)` 之前插入新的 `router.get`）
- Test: `uniscrm-web/link/tests/routes-internal-channels-active.test.ts`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `GET /internal/channels/active?tenantId=<number>` → `200 { channelIds: string[] }`；缺 `tenantId` 或非数字 → `400 { error: "tenantId required" }`。已由 `link/src/index.ts:33` 的 `internalAuthMiddleware` 统一校验 `X-Internal-Secret`，本路由自己不再校验。

- [ ] **Step 1: 写失败的测试**

新建 `uniscrm-web/link/tests/routes-internal-channels-active.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { internalRoutes } from "../src/routes-internal";
import type { Env } from "../src/types";

interface FakeRow { id: string; tenant_id: number; is_active: number }

// Row-store fake that honours the WHERE clause the route actually sends, so a query that
// forgets `tenant_id = ?` or `is_active = 1` really does see the wrong rows instead of
// silently passing.
function createMockLinkDb(rows: FakeRow[]) {
  const stmt = (sql: string, args: unknown[]) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    all: async () => {
      let match = rows;
      if (sql.includes("tenant_id = ?")) match = match.filter((r) => r.tenant_id === Number(args[0]));
      if (sql.includes("is_active = 1")) match = match.filter((r) => r.is_active === 1);
      return { results: match.map((r) => ({ id: r.id })) };
    },
  });
  return { prepare: (sql: string) => stmt(sql, []) } as unknown as D1Database;
}

function app(db: D1Database) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/internal", internalRoutes());
  return (path: string) => a.fetch(new Request(`https://link.test${path}`), { LINK_DB: db } as unknown as Env);
}

describe("GET /internal/channels/active", () => {
  it("returns only this tenant's active channel ids", async () => {
    const fetchApp = app(createMockLinkDb([
      { id: "c-mine-live", tenant_id: 1, is_active: 1 },
      { id: "c-mine-dead", tenant_id: 1, is_active: 0 },
      { id: "c-other-live", tenant_id: 2, is_active: 1 },
    ]));
    const res = await fetchApp("/internal/channels/active?tenantId=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channelIds: ["c-mine-live"] });
  });

  it("returns an empty list for a tenant with no active channels", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-dead", tenant_id: 1, is_active: 0 }]));
    const res = await fetchApp("/internal/channels/active?tenantId=1");
    expect(await res.json()).toEqual({ channelIds: [] });
  });

  it("rejects a missing tenantId rather than leaking every tenant's channels", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-live", tenant_id: 1, is_active: 1 }]));
    const res = await fetchApp("/internal/channels/active");
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric tenantId", async () => {
    const fetchApp = app(createMockLinkDb([{ id: "c-live", tenant_id: 1, is_active: 1 }]));
    const res = await fetchApp("/internal/channels/active?tenantId=abc");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd uniscrm-web/link && npx vitest run tests/routes-internal-channels-active.test.ts`
Expected: FAIL —— 4 个用例里前两个拿到 404（路由不存在），后两个可能因为 404 恰好不是 400 而失败。

- [ ] **Step 3: 实现路由**

在 `uniscrm-web/link/src/routes-internal.ts` 里，`router.post("/lists/:id/users", ...)` 那一行**之前**插入：

```ts
  // flow 用来判断一个 published flow 的 trigger 绑的 channel 是否还活着。只回 id 集合，
  // 不回类型或名字 —— flow 只需要判断"在不在"，展示文案由它自己的 trigger 节点类型决定。
  router.get("/channels/active", async (c) => {
    const tenantId = Number(c.req.query("tenantId"));
    if (!Number.isFinite(tenantId)) return c.json({ error: "tenantId required" }, 400);
    const rows = await c.env.LINK_DB
      .prepare("SELECT id FROM channels WHERE tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .all<{ id: string }>();
    return c.json({ channelIds: rows.results.map((r) => r.id) });
  });
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd uniscrm-web/link && npx vitest run tests/routes-internal-channels-active.test.ts`
Expected: PASS，4 passed。

- [ ] **Step 5: 跑 link 全量测试，确认没打破别的**

Run: `cd uniscrm-web/link && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
cd uniscrm-web
git add link/src/routes-internal.ts link/tests/routes-internal-channels-active.test.ts
git commit -m "feat(link): GET /internal/channels/active for flow trigger health checks"
```

---

### Task 2: flow 的判定模块

**Files:**
- Create: `uniscrm-web/flow/src/trigger-health.ts`
- Test: `uniscrm-web/flow/tests/unit/trigger-health.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `GET /internal/channels/active?tenantId=`
- Produces:
  - `fetchActiveChannelIds(env: Pick<Env, "LINK_URL" | "INTERNAL_SECRET">, tenantId: number | string): Promise<Set<string> | null>` —— `null` 表示"判定不出"（link 不可达 / 非 2xx / 响应体不合法），与"集合为空"是两回事。
  - `triggerBindsChannel(graphJson: string): boolean` —— 这个 flow 的 trigger 是否绑 channel。`cronTrigger`、没有 trigger、`graph_json` 解析不了都是 `false`。publish 用它决定要不要去问 link（cron flow 不该因为 link 抖动就发布不了）。
  - `findBrokenTrigger(graphJson: string, activeIds: Set<string> | null): { nodeId: string; nodeType: string } | null`
  - `brokenTriggerMessage(nodeType: string): string` —— publish 被拒时返回给前端的人话。

- [ ] **Step 1: 写失败的测试**

新建 `uniscrm-web/flow/tests/unit/trigger-health.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchActiveChannelIds, triggerBindsChannel, findBrokenTrigger, brokenTriggerMessage } from "../../src/trigger-health";

function graph(nodes: { id: string; type: string; data?: Record<string, unknown> }[]) {
  return JSON.stringify({
    nodes: nodes.map((n) => ({ ...n, data: n.data || {}, position: { x: 0, y: 0 } })),
    edges: [],
  });
}

describe("findBrokenTrigger", () => {
  const live = new Set(["chan-live"]);

  it("flags a trigger whose channel is no longer in the active set", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" } }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xTrigger" });
  });

  it("flags a trigger that was published without ever picking a channel", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "" } }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xTrigger" });
  });

  it("flags a trigger whose data has no channelId key at all", () => {
    const g = graph([{ id: "t1", type: "xContentTrigger" }]);
    expect(findBrokenTrigger(g, live)).toEqual({ nodeId: "t1", nodeType: "xContentTrigger" });
  });

  it("passes a trigger whose channel is still active", () => {
    const g = graph([{ id: "t1", type: "youtubeContentTrigger", data: { channelId: "chan-live" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("never flags cronTrigger — it binds no channel", () => {
    const g = graph([{ id: "t1", type: "cronTrigger", data: { scheduleType: "daily" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("ignores an action node's channelId — only the trigger is in scope", () => {
    const g = graph([
      { id: "t1", type: "xTrigger", data: { channelId: "chan-live" } },
      { id: "a1", type: "action", data: { actionType: "xAction", channelId: "chan-gone" } },
    ]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("passes a graph with no trigger node", () => {
    const g = graph([{ id: "a1", type: "action", data: { actionType: "xAction" } }]);
    expect(findBrokenTrigger(g, live)).toBeNull();
  });

  it("returns null when the active set is unknown (link unreachable)", () => {
    const g = graph([{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" } }]);
    expect(findBrokenTrigger(g, null)).toBeNull();
  });

  it("returns null on unparseable graph_json rather than throwing", () => {
    expect(findBrokenTrigger("{not json", live)).toBeNull();
    expect(findBrokenTrigger("", live)).toBeNull();
  });
});

describe("triggerBindsChannel", () => {
  it("is true for a channel-bound trigger", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "xTrigger", data: { channelId: "c" } }]))).toBe(true);
  });

  it("is true even when the channel was never picked — an empty channelId still needs checking", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "xTrigger" }]))).toBe(true);
  });

  it("is false for cronTrigger, so publishing one never depends on link being up", () => {
    expect(triggerBindsChannel(graph([{ id: "t1", type: "cronTrigger" }]))).toBe(false);
  });

  it("is false for a graph with no trigger, and for unparseable json", () => {
    expect(triggerBindsChannel(graph([{ id: "a1", type: "action" }]))).toBe(false);
    expect(triggerBindsChannel("{not json")).toBe(false);
  });
});

describe("fetchActiveChannelIds", () => {
  const env = { LINK_URL: "https://link.test", INTERNAL_SECRET: "s3cret" };

  afterEach(() => vi.unstubAllGlobals());

  it("returns the id set and sends the internal secret", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ channelIds: ["a", "b"] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const ids = await fetchActiveChannelIds(env, 7);
    expect(ids).toEqual(new Set(["a", "b"]));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://link.test/internal/channels/active?tenantId=7");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3cret");
  });

  it("distinguishes an empty tenant from an unreachable link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ channelIds: [] }), { status: 200 })));
    expect(await fetchActiveChannelIds(env, 7)).toEqual(new Set());
  });

  it("returns null on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });

  it("returns null when link throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });

  it("returns null when the body is 200 but malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ oops: true }), { status: 200 })));
    expect(await fetchActiveChannelIds(env, 7)).toBeNull();
  });
});

describe("brokenTriggerMessage", () => {
  it("names X for both X trigger types", () => {
    expect(brokenTriggerMessage("xTrigger")).toContain("X account");
    expect(brokenTriggerMessage("xContentTrigger")).toContain("X account");
  });

  it("names YouTube for the YouTube trigger", () => {
    expect(brokenTriggerMessage("youtubeContentTrigger")).toContain("YouTube account");
  });

  it("falls back to a neutral noun for an unknown trigger type", () => {
    expect(brokenTriggerMessage("somethingNew")).toContain("channel");
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/trigger-health.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/trigger-health"`。

- [ ] **Step 3: 实现模块**

新建 `uniscrm-web/flow/src/trigger-health.ts`：

```ts
import { NODE_TYPE_REGISTRY } from "../nodeTypeRegistry";
import type { Env } from "./types";

export interface BrokenTrigger {
  nodeId: string;
  nodeType: string;
}

// link 里该租户所有 active channel 的 id 集合。link 不可达、非 2xx、或响应体不是
// { channelIds: [] } 形状时返回 null —— "判定不出"，与"集合为空"是两回事，调用方
// 据此决定 fail-open 还是 fail-closed。
export async function fetchActiveChannelIds(
  env: Pick<Env, "LINK_URL" | "INTERNAL_SECRET">,
  tenantId: number | string
): Promise<Set<string> | null> {
  try {
    const res = await fetch(
      `${env.LINK_URL}/internal/channels/active?tenantId=${encodeURIComponent(String(tenantId))}`,
      { headers: { "X-Internal-Secret": env.INTERNAL_SECRET } }
    );
    if (!res.ok) {
      console.error(JSON.stringify({ event: "active_channels_fetch_failed", tenantId, status: res.status }));
      return null;
    }
    const body = (await res.json()) as { channelIds?: unknown };
    if (!Array.isArray(body.channelIds)) {
      console.error(JSON.stringify({ event: "active_channels_bad_body", tenantId }));
      return null;
    }
    return new Set(body.channelIds.map(String));
  } catch (e) {
    console.error(JSON.stringify({ event: "active_channels_fetch_error", tenantId, error: String(e) }));
    return null;
  }
}

interface GraphNode {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

// 一个 flow 至多一个 trigger 节点（frontend/store/flow-editor.ts:113 的 addNode 拒绝第二个），
// 所以"哪个 trigger"始终是个单数问题。
function findTriggerNode(graphJson: string): GraphNode | null {
  try {
    const parsed = JSON.parse(graphJson || "{}") as { nodes?: unknown };
    if (!Array.isArray(parsed.nodes)) return null;
    const nodes = parsed.nodes as GraphNode[];
    return nodes.find((n) => n.type && NODE_TYPE_REGISTRY[n.type]?.role === "trigger") || null;
  } catch {
    return null;
  }
}

// 这个 flow 的 trigger 是否绑 channel。publish 用它决定要不要去问 link —— 一个 cronTrigger
// 的 flow 不该因为 link 抖动就发布不了。
export function triggerBindsChannel(graphJson: string): boolean {
  const trigger = findTriggerNode(graphJson);
  return !!trigger && trigger.type !== "cronTrigger";
}

// activeIds 为 null（判定不出）时一律返回 null —— 这就是列表页的 fail-open。
// publish 那条路径在调用本函数之前就先处理掉 null，不依赖这里的宽松行为。
export function findBrokenTrigger(
  graphJson: string,
  activeIds: Set<string> | null
): BrokenTrigger | null {
  if (!activeIds) return null;
  const trigger = findTriggerNode(graphJson);
  if (!trigger || !trigger.type || trigger.type === "cronTrigger") return null;
  const channelId = (trigger.data?.channelId as string) || "";
  if (channelId && activeIds.has(channelId)) return null;
  return { nodeId: trigger.id, nodeType: trigger.type };
}

const TRIGGER_ACCOUNT_NOUN: Record<string, string> = {
  xTrigger: "X account",
  xContentTrigger: "X account",
  youtubeContentTrigger: "YouTube account",
};

// publish 被拒时回给前端、由前端原样 toast 出来的人话。
export function brokenTriggerMessage(nodeType: string): string {
  const noun = TRIGGER_ACCOUNT_NOUN[nodeType] || "channel";
  return `Cannot publish: the ${noun} this flow triggers on is not connected. Connect it under Channels, or pick another one in the trigger node.`;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/trigger-health.test.ts`
Expected: PASS，21 passed。

- [ ] **Step 5: 提交**

```bash
cd uniscrm-web
git add flow/src/trigger-health.ts flow/tests/unit/trigger-health.test.ts
git commit -m "feat(flow): trigger-health module (active-channel lookup + broken-trigger judgment)"
```

---

### Task 3: 列表 API 返回 `broken_trigger_type`（fail-open）

**Files:**
- Modify: `uniscrm-web/flow/src/index.ts:1311-1333`（`GET /api/flows` 的查询与响应组装）
- Test: `uniscrm-web/flow/tests/unit/flows-list-trigger-health.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `fetchActiveChannelIds`、`findBrokenTrigger`
- Produces: `GET /api/flows` 响应里每个 flow 多一个字段 `broken_trigger_type: string | null`。值是失效 trigger 的**节点类型**（如 `"xTrigger"`），`null` 表示健康。只对 `status === "published"` 的行计算，draft 恒为 `null`。响应里**不**包含 `graph_json`。

- [ ] **Step 1: 写失败的测试**

新建 `uniscrm-web/flow/tests/unit/flows-list-trigger-health.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 998;

const boundToLive = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-live" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const boundToGone = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" }, position: { x: 0, y: 0 } }],
  edges: [],
});

function req(path: string) {
  return new Request(`https://flow.test${path}`, { headers: { Cookie: "session=test" } });
}

// authMiddleware fetches WEB_URL's /api/auth/me, and the route under test fetches LINK_URL's
// /internal/channels/active. One global stub serves both, routed by URL — a single catch-all
// response would feed the auth body to the channel lookup and vice versa.
function stubFetch(channels: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/internal/channels/active")) {
      if (channels === "throw") throw new Error("link down");
      return new Response(JSON.stringify(channels.body ?? {}), { status: channels.status });
    }
    return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
  }));
}

describe("GET /api/flows broken_trigger_type", () => {
  beforeEach(async () => {
    // vitest-pool-workers does not auto-apply this module's migrations/ directory — create the
    // post-migration `flows` table by hand (0001_init as amended by 0011/0014/0015).
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-ok', ?, 'ok', ?, 'user', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToLive),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-broken', ?, 'broken', ?, 'user', 'published', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('f-draft', ?, 'draft', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  async function list() {
    const res = await worker.fetch(req("/api/flows"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { flows: { id: string; broken_trigger_type: string | null; graph_json?: string }[] };
    return Object.fromEntries(body.flows.map((f) => [f.id, f]));
  }

  it("flags the published flow whose trigger channel is gone, and only that one", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBe("xTrigger");
    expect(byId["f-ok"].broken_trigger_type).toBeNull();
  });

  it("never flags a draft — publishing state is what makes the lie a lie", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-draft"].broken_trigger_type).toBeNull();
  });

  it("fails open when link is unreachable: nothing is flagged", async () => {
    stubFetch("throw");
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBeNull();
    expect(byId["f-ok"].broken_trigger_type).toBeNull();
  });

  it("fails open when link answers non-2xx", async () => {
    stubFetch({ status: 503 });
    const byId = await list();
    expect(byId["f-broken"].broken_trigger_type).toBeNull();
  });

  it("does not ship graph_json to the browser", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const byId = await list();
    expect(byId["f-ok"].graph_json).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/flows-list-trigger-health.test.ts`
Expected: FAIL —— `broken_trigger_type` 是 `undefined` 而不是 `"xTrigger"` / `null`。

- [ ] **Step 3: 改列表路由**

在 `uniscrm-web/flow/src/index.ts` 顶部的 import 区加上：

```ts
import { fetchActiveChannelIds, findBrokenTrigger } from "./trigger-health";
```

（只 import 本 task 真正用到的两个 —— Task 4 会把这一行补全。）

把 `GET /api/flows` 里的行查询（现在的 `index.ts:1311-1316`）改成多取 `f.graph_json`：

```ts
  const rows = await c.env.FLOW_DB.prepare(
    `SELECT f.id, f.name, f.description, f.status, f.member_id, f.created_at, f.updated_at, f.trigger_count, f.graph_json
     FROM flows f WHERE f.tenant_id = ? AND f.domain = ? ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, domain, limit, offset)
    .all<{ id: string; name: string; description: string; status: string; member_id: string; created_at: string; updated_at: string; trigger_count: number | null; graph_json: string }>();
```

在 members 查询之后、`const flows = ...` 之前插入：

```ts
  // 只有 published 的行才需要判定 —— draft 还没声称自己在跑。整页一行都不需要时就不打扰 link。
  const needsCheck = rows.results.some((r) => r.status === "published");
  const activeIds = needsCheck ? await fetchActiveChannelIds(c.env, tenantId) : null;
```

把响应组装（现在的 `index.ts:1328-1331`）改成：

```ts
  const flows = rows.results.map(({ graph_json, ...f }) => ({
    ...f,
    member_email: memberMap[f.member_id] || "",
    // activeIds 为 null（link 不可达）时 findBrokenTrigger 一律返回 null —— fail-open。
    // 把一个租户的 flow 全标红是比几分钟的陈旧绿色更严重的误报。
    broken_trigger_type: f.status === "published" ? (findBrokenTrigger(graph_json, activeIds)?.nodeType ?? null) : null,
  }));
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/flows-list-trigger-health.test.ts tests/unit/flows-list.test.ts`
Expected: 两个文件都 PASS。`flows-list.test.ts` 必须一起跑 —— 它用的是一个 catch-all 的 fetch stub，改动后列表路由多发了一次 fetch，要确认没被它的 stub 打破。

- [ ] **Step 5: 提交**

```bash
cd uniscrm-web
git add flow/src/index.ts flow/tests/unit/flows-list-trigger-health.test.ts
git commit -m "feat(flow): flag published flows whose trigger channel is disconnected"
```

---

### Task 4: publish 校验（fail-closed）

**Files:**
- Modify: `uniscrm-web/flow/src/index.ts:1446-1457`（`POST /api/flows/:id/publish`）
- Test: `uniscrm-web/flow/tests/unit/publish-trigger-health.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `fetchActiveChannelIds`、`findBrokenTrigger`、`brokenTriggerMessage`；Task 3 已经加好的 import 行
- Produces: `POST /api/flows/:id/publish` 新增两种失败：`503 { error: "Cannot verify channel status right now. Please try again." }`（link 判定不出）与 `400 { error: <brokenTriggerMessage(nodeType)> }`（trigger 失效）。两种都不写库。

- [ ] **Step 1: 写失败的测试**

新建 `uniscrm-web/flow/tests/unit/publish-trigger-health.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TENANT_ID = 997;

const boundToLive = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-live" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const boundToGone = JSON.stringify({
  nodes: [{ id: "t1", type: "xTrigger", data: { channelId: "chan-gone" }, position: { x: 0, y: 0 } }],
  edges: [],
});
const cronOnly = JSON.stringify({
  nodes: [{ id: "t1", type: "cronTrigger", data: { scheduleType: "daily", dailyTime: "09:00" }, position: { x: 0, y: 0 } }],
  edges: [],
});

function publishReq(id: string) {
  return new Request(`https://flow.test/api/flows/${id}/publish`, {
    method: "POST",
    headers: { Cookie: "session=test" },
  });
}

function stubFetch(channels: { status: number; body?: unknown } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/internal/channels/active")) {
      if (channels === "throw") throw new Error("link down");
      return new Response(JSON.stringify(channels.body ?? {}), { status: channels.status });
    }
    return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: String(TENANT_ID) } }), { status: 200 });
  }));
}

async function statusOf(id: string) {
  const row = await env.FLOW_DB.prepare(`SELECT status FROM flows WHERE id = ?`).bind(id).first<{ status: string }>();
  return row?.status;
}

describe("POST /api/flows/:id/publish trigger gate", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `CREATE TABLE IF NOT EXISTS flows (
         id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
         name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
         graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', domain TEXT NOT NULL DEFAULT 'user',
         status TEXT NOT NULL DEFAULT 'draft', trigger_count INTEGER,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL
       )`
    ).run();
    await env.FLOW_DB.batch([
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-ok', ?, 'ok', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToLive),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-broken', ?, 'broken', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, boundToGone),
      env.FLOW_DB.prepare(
        `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
         VALUES ('p-cron', ?, 'cron', ?, 'user', 'draft', datetime('now'), datetime('now'))`
      ).bind(TENANT_ID, cronOnly),
    ]);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE tenant_id = ?`).bind(TENANT_ID).run();
    vi.unstubAllGlobals();
  });

  it("publishes a flow whose trigger channel is active", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(200);
    expect(await statusOf("p-ok")).toBe("published");
  });

  it("refuses to publish a flow whose trigger channel is gone, and leaves it a draft", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    const res = await worker.fetch(publishReq("p-broken"), env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("X account");
    expect(await statusOf("p-broken")).toBe("draft");
  });

  it("aborts with 503 when link cannot be reached — never publishes unverified", async () => {
    stubFetch("throw");
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(503);
    expect(await statusOf("p-ok")).toBe("draft");
  });

  it("aborts with 503 when link answers non-2xx", async () => {
    stubFetch({ status: 500 });
    const res = await worker.fetch(publishReq("p-ok"), env);
    expect(res.status).toBe(503);
    expect(await statusOf("p-ok")).toBe("draft");
  });

  it("publishes a cronTrigger flow without consulting link at all", async () => {
    stubFetch("throw");
    const res = await worker.fetch(publishReq("p-cron"), env);
    expect(res.status).toBe(200);
    expect(await statusOf("p-cron")).toBe("published");
  });

  it("still 404s on another tenant's flow", async () => {
    stubFetch({ status: 200, body: { channelIds: ["chan-live"] } });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, domain, status, created_at, updated_at)
       VALUES ('p-other', 12345, 'other', ?, 'user', 'draft', datetime('now'), datetime('now'))`
    ).bind(boundToLive).run();
    const res = await worker.fetch(publishReq("p-other"), env);
    expect(res.status).toBe(404);
    expect(await statusOf("p-other")).toBe("draft");
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'p-other'`).run();
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/publish-trigger-health.test.ts`
Expected: FAIL —— 失效的 flow 和 link 挂掉的场景都拿到 200 并被写成 `published`。

- [ ] **Step 3: 改 publish 路由**

先把 Task 3 加的那行 import 补全（`uniscrm-web/flow/src/index.ts` 顶部）：

```ts
import { fetchActiveChannelIds, triggerBindsChannel, findBrokenTrigger, brokenTriggerMessage } from "./trigger-health";
```

再把整个 publish handler 替换成：

```ts
// Publish flow
app.post("/api/flows/:id/publish", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const flow = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE id = ? AND tenant_id = ?`
  ).bind(flowId, tenantId).first<{ graph_json: string }>();
  if (!flow) return c.json({ error: "Not found" }, 404);

  // cronTrigger 之类不绑 channel 的 flow 不问 link —— 它的可发布性与 link 无关，
  // 不该因为 link 抖动就发布不了。
  if (triggerBindsChannel(flow.graph_json)) {
    const activeIds = await fetchActiveChannelIds(c.env, tenantId);
    // 列表页在这里 fail-open，publish 不行：publish 是一次离散的用户动作，当场能提示重试，
    // 而带着未经验证的状态发布出去正是这个 gate 要防的事。
    if (!activeIds) {
      return c.json({ error: "Cannot verify channel status right now. Please try again." }, 503);
    }
    const broken = findBrokenTrigger(flow.graph_json, activeIds);
    if (broken) return c.json({ error: brokenTriggerMessage(broken.nodeType) }, 400);
  }

  const result = await c.env.FLOW_DB.prepare(
    `UPDATE flows SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(new Date().toISOString(), flowId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/publish-trigger-health.test.ts`
Expected: PASS，6 passed。

- [ ] **Step 5: 跑 flow 全量后端测试**

Run: `cd uniscrm-web/flow && npx vitest run`
Expected: 全部 PASS。特别留意 `tests/unit/unpublish-tenant-isolation.test.ts` 和 `tests/unit/graph-node-id-validation.test.ts` —— 它们也打 publish/flows 路由。

- [ ] **Step 6: 提交**

```bash
cd uniscrm-web
git add flow/src/index.ts flow/tests/unit/publish-trigger-health.test.ts
git commit -m "feat(flow): block publishing a flow whose trigger channel is disconnected"
```

---

### Task 5: 列表页红色状态

**Files:**
- Modify: `uniscrm-web/flow/frontend/lib/api.ts:18-28`（`FlowSummary` 加字段）
- Modify: `uniscrm-web/flow/frontend/pages/FlowsPage.tsx`
- Test: `uniscrm-web/flow/tests/unit/flows-page-broken-trigger.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 3 的 `broken_trigger_type: string | null`
- Produces: `brokenTriggerTooltip(nodeType: string): string`，从 `FlowsPage.tsx` 具名导出（和已有的 `getNodeIcon` 一样，纯函数便于单测）。

- [ ] **Step 1: 写失败的测试**

新建 `uniscrm-web/flow/tests/unit/flows-page-broken-trigger.test.tsx`：

```tsx
import { describe, it, expect } from "vitest";
import { brokenTriggerTooltip } from "../../frontend/pages/FlowsPage";

describe("brokenTriggerTooltip", () => {
  it("names X for both X trigger types", () => {
    expect(brokenTriggerTooltip("xTrigger")).toContain("X account");
    expect(brokenTriggerTooltip("xContentTrigger")).toContain("X account");
  });

  it("names YouTube for the YouTube trigger", () => {
    expect(brokenTriggerTooltip("youtubeContentTrigger")).toContain("YouTube account");
  });

  it("falls back to a neutral noun for an unknown trigger type", () => {
    expect(brokenTriggerTooltip("somethingNew")).toContain("channel");
  });

  it("tells the user what to actually do about it", () => {
    expect(brokenTriggerTooltip("xTrigger")).toContain("Channels");
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/flows-page-broken-trigger.test.tsx`
Expected: FAIL —— `brokenTriggerTooltip is not a function` / 导入失败。

- [ ] **Step 3: `FlowSummary` 加字段**

在 `uniscrm-web/flow/frontend/lib/api.ts` 的 `FlowSummary` 接口里，`trigger_count` 那一行下面加：

```ts
  // 失效 trigger 的节点类型；null 表示健康。只对 published 的 flow 计算。
  broken_trigger_type: string | null;
```

- [ ] **Step 4: 实现 `FlowsPage.tsx` 的三处改动**

在 `uniscrm-web/flow/frontend/pages/FlowsPage.tsx` 的 import 区加：

```tsx
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
```

在 `getNodeIcons` 函数下面加导出的纯函数：

```tsx
const TRIGGER_ACCOUNT_NOUN: Record<string, string> = {
  xTrigger: "X account",
  xContentTrigger: "X account",
  youtubeContentTrigger: "YouTube account",
};

export function brokenTriggerTooltip(nodeType: string) {
  const noun = TRIGGER_ACCOUNT_NOUN[nodeType] || "channel";
  return `The ${noun} this flow triggers on is not connected, so this flow never runs. Connect it under Channels, or pick another one in the trigger node.`;
}
```

把 `sorted.map((flow) => {...})` 里的 `const isPublished = ...` 那一段改成：

```tsx
                    const isPublished = flow.status === "published";
                    const broken = isPublished ? flow.broken_trigger_type : null;
                    // 失效的 flow 点进 analytics 是一片空白 —— 它从未触发过。用户此刻要的是修，不是看。
                    const rowHref = broken || !isPublished ? `/flows/${flow.id}` : `/flows/${flow.id}/analytics`;
                    return (
                      <TableRow key={flow.id} className="cursor-pointer" onClick={() => navigate(rowHref)}>
                        <TableCell className="font-medium text-foreground">{flow.name}</TableCell>
                        <TableCell>
                          {broken ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span><StatusCell status="error" label="Trigger Disconnected" /></span>
                              </TooltipTrigger>
                              <TooltipContent>{brokenTriggerTooltip(broken)}</TooltipContent>
                            </Tooltip>
                          ) : (
                            <StatusCell status={isPublished ? "published" : "draft"} label={isPublished ? "Published" : "Draft"} />
                          )}
                        </TableCell>
```

（`TooltipTrigger asChild` 外面那层 `<span>` 是必需的：`StatusCell` 是普通函数组件，不转发 ref，Radix 会把 ref 塞给它。`frontend/nodes/XTriggerNode.tsx:29` 用的是同一个写法。）

`OperationCell` 那一段的 `status` 改成合成值，并加 `broken` 分支：

```tsx
                          <OperationCell
                            status={broken ? "broken" : flow.status}
                            operations={{
                              broken: {
                                primary: { icon: <EditIcon className="w-5 h-5" />, title: "Edit", onClick: () => navigate(`/flows/${flow.id}`) },
                                menu: [
                                  { label: "Duplicate", onClick: () => handleDuplicate(flow.id) },
                                  { label: "Stop", onClick: () => api.flows.unpublish(flow.id).then(() => refresh()), destructive: true },
                                ],
                              },
                              published: {
```

（`published` 和 `draft` 两个分支原样保留，只是在它们前面多了一个 `broken`。）

最后，`Tooltip` 需要一个 `TooltipProvider` 祖先，而 `FlowsPage` 现在没有。把 `<DataTable ...>...</DataTable>` 整块包起来：

```tsx
              <TooltipProvider>
                <DataTable total={total} page={page} totalPages={totalPages} onPageChange={setPage}>
                  ...
                </DataTable>
              </TooltipProvider>
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `cd uniscrm-web/flow && npx vitest run tests/unit/flows-page-broken-trigger.test.tsx tests/unit/flows-page-node-icon.test.tsx`
Expected: 两个都 PASS。

- [ ] **Step 6: 类型检查**

Run: `cd uniscrm-web/flow && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "node_modules" | head -20`
Expected: 没有指向 `frontend/pages/FlowsPage.tsx`、`frontend/lib/api.ts`、`src/trigger-health.ts` 或 `src/index.ts` 的报错。（该项目 frontend 的 react 类型本来就有既存噪音，只看这几个文件。）

- [ ] **Step 7: 提交**

```bash
cd uniscrm-web
git add flow/frontend/pages/FlowsPage.tsx flow/frontend/lib/api.ts flow/tests/unit/flows-page-broken-trigger.test.tsx
git commit -m "feat(flow): red Trigger Disconnected status on the flow list"
```

---

### Task 6: 编辑器 publish 失败时的提示与高亮

**Files:**
- Modify: `uniscrm-web/flow/frontend/pages/EditorPage.tsx:103-124`（Publish 按钮的 onClick）

**Interfaces:**
- Consumes: Task 4 的 400/503 响应（`request()` 在非 2xx 时 `throw new Error(err.error)`，见 `frontend/lib/api.ts:11-14`，所以 `e.message` 就是后端那句人话）
- Produces: 无

- [ ] **Step 1: 改 Publish 的 onClick**

在 `uniscrm-web/flow/frontend/pages/EditorPage.tsx` 顶部的 import 区加：

```tsx
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
```

把 Publish 按钮 onClick 里 `await handleSave();` 之后的部分替换成：

```tsx
          await handleSave();
          const id = useFlowEditor.getState().flowId;
          if (!id) return;
          try {
            await api.flows.publish(id);
            navigate(`/flows/${id}/analytics`);
          } catch (e) {
            // 在这之前 api.flows.publish 抛错完全没人接：不跳转、也不提示，publish 失败是静默的。
            // 后端把人话放在响应体的 error 里，request() 已经把它变成 Error.message。
            toast({ title: (e as Error).message || "Publish failed", variant: "destructive" });
            // 一个 flow 至多一个 trigger（store 的 addNode 拒绝第二个），所以直接找到它标红，
            // 复用孤立节点那套高亮，不需要后端回传 nodeId。
            const trigger = useFlowEditor.getState().nodes.find(
              (n) => n.type && NODE_TYPE_REGISTRY[n.type]?.role === "trigger"
            );
            useFlowEditor.getState().setErrorNodeIds(trigger ? [trigger.id] : []);
          }
```

- [ ] **Step 2: 类型检查**

Run: `cd uniscrm-web/flow && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "EditorPage" | head -10`
Expected: 无输出。

- [ ] **Step 3: 跑 flow 全量测试**

Run: `cd uniscrm-web/flow && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
cd uniscrm-web
git add flow/frontend/pages/EditorPage.tsx
git commit -m "fix(flow): surface publish failures instead of failing silently"
```

---

### Task 7: 部署 dev 并在浏览器里自测

**Files:** 无（只跑命令与浏览器验证）

**Interfaces:**
- Consumes: Task 1–6 的全部改动

- [ ] **Step 1: 部署 link 到 dev**

Run: `cd uniscrm-web/link && npm run deploy:dev`
Expected: 部署成功，输出一个 Version ID。（**必须走 `npm run deploy:dev`** —— 裸 `wrangler deploy` 会打到 PROD 并抹掉 bindings；手敲 `wrangler deploy --env dev` 会跳过 vite build、发出过期的前端。）

- [ ] **Step 2: 部署 flow 到 dev**

Run: `cd uniscrm-web/flow && npm run deploy:dev`
Expected: 部署成功，输出一个 Version ID。

- [ ] **Step 3: 验证内部接口活着**

Run:
```bash
curl -s "https://link-dev.uni-scrm.com/internal/channels/active?tenantId=1" \
  -H "X-Internal-Secret: dev-internal-secret"
```
Expected: `{"channelIds":[...]}`，是一个 JSON 数组。记下里面**没有**出现的一个假 id（下一步要用）。

Run: `curl -s -o /dev/null -w "%{http_code}" "https://link-dev.uni-scrm.com/internal/channels/active" -H "X-Internal-Secret: dev-internal-secret"`
Expected: `400`。

- [ ] **Step 4: 造一个 trigger 已失效的 published flow**

Run（tenant 1 下建一条，trigger 绑一个不存在的 channel）：
```bash
cd uniscrm-web/flow && wrangler d1 execute uniscrm-flow-dev --env dev --remote --command \
"INSERT INTO flows (id, tenant_id, member_id, name, description, graph_json, domain, status, created_at, updated_at) VALUES ('zz-broken-trigger', 1, '', 'zz broken trigger', '', '{\"nodes\":[{\"id\":\"t1\",\"type\":\"xTrigger\",\"data\":{\"channelId\":\"zz-fake-chan\",\"eventType\":\"follow.follow\"},\"position\":{\"x\":0,\"y\":0}}],\"edges\":[]}', 'user', 'published', datetime('now'), datetime('now'))"
```
Expected: `success: true`，1 change。

- [ ] **Step 5: 浏览器验证列表页**

用已登录的 Chrome session（`tabs_context_mcp` 拿现有标签页；session 过期就点 "Continue with Google"）打开 `https://flow-dev.uni-scrm.com/`。

Expected:
1. `zz broken trigger` 那一行的 Status 是**红色**的 `Trigger Disconnected`，其它 published flow 仍是绿色 `Published`。
2. hover 红色徽章，出现 tooltip：`The X account this flow triggers on is not connected, so this flow never runs. Connect it under Channels, or pick another one in the trigger node.`
3. 该行的 Operations 主图标是**铅笔（Edit）**，不是复制图标；hover 显示 "Edit"。
4. 点击该行进入 `/flows/zz-broken-trigger`（编辑器），**不是** `/flows/zz-broken-trigger/analytics`。

- [ ] **Step 6: 浏览器验证 publish 拦截**

在刚打开的编辑器页面里点 Publish。

Expected: 右下角出现红色 toast `Cannot publish: the X account this flow triggers on is not connected. Connect it under Channels, or pick another one in the trigger node.`，trigger 节点被标红框，页面**没有**跳到 analytics。

- [ ] **Step 7: 反向验证一个健康的 flow 没被误伤**

在列表页找一个 trigger 绑着真实已连接 channel 的 published flow。

Expected: 仍是绿色 `Published`，点击进 analytics，Operations 主图标仍是复制。

- [ ] **Step 8: 清理测试数据**

Run:
```bash
cd uniscrm-web/flow && wrangler d1 execute uniscrm-flow-dev --env dev --remote --command \
"DELETE FROM flows WHERE id = 'zz-broken-trigger'"
```
Expected: `success: true`，1 change。

- [ ] **Step 9: 确认工作区干净、没有夹带别的 session 的改动**

Run: `cd uniscrm-web && git status --short`
Expected: 输出里没有 `flow/` 或 `link/` 下本计划涉及的文件。若有别的模块（如 `metadata/`、`admin/`）的未提交改动，**原样留着别碰** —— 那是别的 session 的在途工作。

Run: `cd uniscrm-web && git log --oneline -6`
Expected: 看到本计划的 6 个提交，且都还没 push。
