# YouTube Trigger Multi-Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** content flow 的 YouTube Trigger 从单订阅改为多订阅，双读兼容存量数据，发布时校验至少选 1 个。

**Architecture:** 新数组字段 `data.subscriptions: [{channelId, channelName}]`，一个共享 resolver（`flow/nodeTypeRegistry.ts`，前后端共用）统一双读取值；四个消费点（引擎匹配、watches 端点、发布校验、UI）全部经它。link 模块零改动。

**Tech Stack:** Cloudflare Workers (Hono) + React (ReactFlow, shadcn/ui, Radix Popover/Checkbox) + vitest (`@cloudflare/vitest-pool-workers`, 无 DOM 环境)。

**Spec:** `docs/superpowers/specs/2026-08-01-youtube-trigger-multi-subscription-design.md`

## Global Constraints

- 前端**禁止 import `flow/src/engine.ts`**（会把引擎拖进浏览器 bundle）；前后端共享的代码只放 `flow/nodeTypeRegistry.ts`。
- resolver 对任何畸形输入**不得抛异常**（它在队列 handler 执行路径上，抛出→整条消息重试→已执行 action 重复执行）。
- 取值优先级：`data.subscriptions` 是数组就用它（**空数组不回退**旧字段）；否则旧标量 `subscriptionChannelId` 非空视作单元素数组；再否则 `[]`。
- 发布校验与运行时**必须用同一个 resolver**（parity：否则"发布拦不住但运行时不触发"）。
- 不迁移 D1 存量 graph_json；不改 link 模块；不做「空 = 全部订阅」。
- 前端不写 inline CSS，用 shared/frontend/ui 组件；控件带 tooltip。
- 测试环境无 DOM（workerd），**不新装任何依赖**（不装 @testing-library 等）；UI 决策逻辑提成纯函数测试。
- `tsc --noEmit` 有存量 baseline 错误，不能做绿灯门禁；门禁 = 聚焦 vitest + `npx vite build --mode development`（flow 目录）+ 全量 `npm test`。
- git：只 add 本任务明确列出的文件（**禁止 `git add -A` / `git add .`**，可能有并发 session 的未提交文件）；不 push。
- 部署只用 `npm run deploy:dev`（flow 目录）；裸 deploy 会打到 PROD。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `flow/nodeTypeRegistry.ts` | Modify | 追加 `resolveYouTubeSubscriptions` resolver + 类型；改 youtubeContentTrigger 的 promptFragment |
| `flow/tests/unit/youtube-subscriptions-resolver.test.ts` | Create | resolver 单测 |
| `flow/src/engine.ts` | Modify | trigger 匹配改 membership |
| `flow/src/index.ts` | Modify | `/internal/youtube-watches` 逐 pair 展开 |
| `flow/tests/unit/engine.test.ts` | Modify | 新增 youtubeContentTrigger 匹配 describe |
| `flow/tests/unit/youtube-watches.test.ts` | Modify | 多订阅展开/去重/回退用例 |
| `flow/frontend/lib/validate-flow-graph.ts` | Modify | 新增 `findYouTubeTriggerNoSubscriptionIds`，并入 `validateFlowGraph` |
| `flow/tests/unit/validate-flow-graph.test.ts` | Modify | 新 finder 用例 + 既有 strict fixture 补键 |
| `flow/frontend/pages/EditorPage.tsx` | Modify | 第 5 类 publish toast + 红框 |
| `shared/frontend/lib/multi-select-summary.ts` | Create | 多选按钮摘要纯函数 |
| `shared/frontend/ui/multi-select.tsx` | Create | 通用 Popover+Checkbox 多选组件 |
| `flow/frontend/lib/subscription-summary.ts` | Create | 卡片摘要 + 勾选 toggle 纯函数 |
| `flow/tests/unit/subscription-summary.test.ts` | Create | 上两个 lib 的单测（一个文件测两个 lib） |
| `flow/frontend/components/Inspector.tsx` | Modify | YouTube inspector 换 MultiSelect |
| `flow/frontend/nodes/YouTubeContentTriggerNode.tsx` | Modify | 卡片摘要 |
| `flow/frontend/store/flow-editor.ts` | Modify | addNode 默认 data |

---

### Task 1: 共享 resolver `resolveYouTubeSubscriptions`

**Files:**
- Modify: `flow/nodeTypeRegistry.ts`（文件末尾，`CONDITION_LOGIC_AND` 之后追加）
- Test: `flow/tests/unit/youtube-subscriptions-resolver.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯函数，无依赖）
- Produces: `export interface YouTubeSubscriptionRef { channelId: string; channelName: string }`；`export function resolveYouTubeSubscriptions(data: Record<string, unknown> | null | undefined): YouTubeSubscriptionRef[]` —— Task 2/3/4/5/6 全部依赖此签名。

- [ ] **Step 1: 写失败测试**

新建 `flow/tests/unit/youtube-subscriptions-resolver.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveYouTubeSubscriptions } from "../../nodeTypeRegistry";

describe("resolveYouTubeSubscriptions", () => {
  it("returns [] for undefined / null / non-object data", () => {
    expect(resolveYouTubeSubscriptions(undefined)).toEqual([]);
    expect(resolveYouTubeSubscriptions(null)).toEqual([]);
  });

  it("uses the subscriptions array when present", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }] })
    ).toEqual([{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }]);
  });

  it("empty array means explicitly cleared — no fallback to legacy scalars", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [], subscriptionChannelId: "UCa", subscriptionChannelName: "A" })
    ).toEqual([]);
  });

  it("array takes precedence over legacy scalars when both present", () => {
    expect(
      resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCnew", channelName: "New" }], subscriptionChannelId: "UCold", subscriptionChannelName: "Old" })
    ).toEqual([{ channelId: "UCnew", channelName: "New" }]);
  });

  it("filters malformed array elements without throwing", () => {
    expect(
      resolveYouTubeSubscriptions({
        subscriptions: [null, "str", 42, { channelName: "no id" }, { channelId: "" }, { channelId: 123 }, { channelId: "UCok" }],
      })
    ).toEqual([{ channelId: "UCok", channelName: "" }]);
  });

  it("defaults missing / non-string channelName to empty string", () => {
    expect(resolveYouTubeSubscriptions({ subscriptions: [{ channelId: "UCa", channelName: { x: 1 } }] }))
      .toEqual([{ channelId: "UCa", channelName: "" }]);
  });

  it("falls back to legacy scalar pair as a single-element array", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "UCa", subscriptionChannelName: "A" }))
      .toEqual([{ channelId: "UCa", channelName: "A" }]);
  });

  it("legacy scalar with missing name yields empty channelName", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "UCa" }))
      .toEqual([{ channelId: "UCa", channelName: "" }]);
  });

  it("legacy empty or non-string subscriptionChannelId yields []", () => {
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: "" })).toEqual([]);
    expect(resolveYouTubeSubscriptions({ subscriptionChannelId: { evil: true } })).toEqual([]);
    expect(resolveYouTubeSubscriptions({})).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（`flow/` 目录）: `npx vitest run tests/unit/youtube-subscriptions-resolver.test.ts`
Expected: FAIL — `resolveYouTubeSubscriptions` is not exported。

- [ ] **Step 3: 实现**

`flow/nodeTypeRegistry.ts` 文件末尾（`CONDITION_LOGIC_AND` 导出之后）追加：

```ts
export interface YouTubeSubscriptionRef {
  channelId: string;
  channelName: string;
}

// youtubeContentTrigger 的订阅取值，前后端共用的唯一入口：引擎匹配（engine.ts）、
// watches 端点（index.ts）、发布校验（validate-flow-graph.ts）、Inspector 与节点卡片
// 必须判同一份值，否则会出现"发布拦不住但运行时不触发"或反之。
// 优先级：subscriptions 是数组就用它（空数组=用户明确清空，不回退）；否则回退旧标量
// subscriptionChannelId/subscriptionChannelName（存量已发布 flow 的形状，零迁移）。
// 对任何畸形输入（AI 生成/手改坏的 graph_json）只降级、不抛异常——本函数在队列 handler
// 执行路径上，抛出会导致整条消息重试、已执行的 action 重复执行。
export function resolveYouTubeSubscriptions(
  data: Record<string, unknown> | null | undefined
): YouTubeSubscriptionRef[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { subscriptions?: unknown }).subscriptions;
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        channelId: typeof s.channelId === "string" ? s.channelId : "",
        channelName: typeof s.channelName === "string" ? s.channelName : "",
      }))
      .filter((s) => s.channelId !== "");
  }
  const legacyId = (data as { subscriptionChannelId?: unknown }).subscriptionChannelId;
  if (typeof legacyId !== "string" || legacyId === "") return [];
  const legacyName = (data as { subscriptionChannelName?: unknown }).subscriptionChannelName;
  return [{ channelId: legacyId, channelName: typeof legacyName === "string" ? legacyName : "" }];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/youtube-subscriptions-resolver.test.ts`
Expected: PASS 10/10。

- [ ] **Step 5: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/tests/unit/youtube-subscriptions-resolver.test.ts
git commit -m "feat(flow): shared resolver for YouTube trigger subscriptions (array + legacy dual-read)"
```

---

### Task 2: 后端消费点 — 引擎 membership 匹配 + watches 逐 pair 展开

**Files:**
- Modify: `flow/src/engine.ts:257-259`（executeFlow 的 youtubeContentTrigger 分支）
- Modify: `flow/src/index.ts:1242-1252`（`/internal/youtube-watches` 节点循环）
- Test: `flow/tests/unit/engine.test.ts`（追加 describe）、`flow/tests/unit/youtube-watches.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveYouTubeSubscriptions(data)`（from `../nodeTypeRegistry`；engine.ts 已有该模块的 import，扩充即可）
- Produces: 无新接口（行为变更：membership 匹配；watches 多 pair）

- [ ] **Step 1: 写失败测试（引擎）**

`flow/tests/unit/engine.test.ts` 追加（文件顶层，与既有 describe 并列；`FlowGraph` 已 import）：

```ts
describe("executeFlow: youtubeContentTrigger subscriptions", () => {
  function graphWithYouTubeTrigger(data: Record<string, unknown>): FlowGraph {
    return {
      nodes: [
        { id: "t1", type: "youtubeContentTrigger", data: { channelId: "acct1", conditions: [], ...data }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }
  const payload = (sub: string) => ({ channel_id: "acct1", subscription_channel_id: sub, channel_type: "YOUTUBE" });

  it("matches when the payload subscription is one of the selected subscriptions", () => {
    const graph = graphWithYouTubeTrigger({ subscriptions: [{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }] });
    expect(executeFlow(graph, "content.created", payload("UCb")).matched).toBe(true);
  });

  it("does not match a subscription outside the selected list", () => {
    const graph = graphWithYouTubeTrigger({ subscriptions: [{ channelId: "UCa", channelName: "A" }] });
    expect(executeFlow(graph, "content.created", payload("UCz")).matched).toBe(false);
  });

  it("legacy single-scalar graphs still match (regression)", () => {
    const graph = graphWithYouTubeTrigger({ subscriptionChannelId: "UCa", subscriptionChannelName: "A" });
    expect(executeFlow(graph, "content.created", payload("UCa")).matched).toBe(true);
    expect(executeFlow(graph, "content.created", payload("UCb")).matched).toBe(false);
  });

  it("empty subscriptions never matches", () => {
    const graph = graphWithYouTubeTrigger({ subscriptions: [] });
    expect(executeFlow(graph, "content.created", payload("UCa")).matched).toBe(false);
  });

  it("still requires the account channelId to match", () => {
    const graph = graphWithYouTubeTrigger({ subscriptions: [{ channelId: "UCa", channelName: "A" }] });
    expect(executeFlow(graph, "content.created", { channel_id: "other-acct", subscription_channel_id: "UCa", channel_type: "YOUTUBE" }).matched).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/engine.test.ts`
Expected: 新 describe 中数组用例 FAIL（`subscriptions` 数组下 `n.data.subscriptionChannelId === payload...` 恒 false）；legacy 回归用例 PASS。

- [ ] **Step 3: 改引擎**

`flow/src/engine.ts`：
1. 顶部 `nodeTypeRegistry` 的 import 里追加 `resolveYouTubeSubscriptions`（该文件已 import `CONDITION_LOGIC_OR` 等，扩充同一行）。
2. `executeFlow` 的分支：

```ts
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && resolveYouTubeSubscriptions(n.data)
               .some((s) => s.channelId === payload.subscription_channel_id))
```

- [ ] **Step 4: 跑引擎测试确认通过**

Run: `npx vitest run tests/unit/engine.test.ts`
Expected: PASS（全部，含既有用例）。

- [ ] **Step 5: 写失败测试（watches）**

`flow/tests/unit/youtube-watches.test.ts` describe 内追加：

```ts
  it("expands a multi-subscription node into one watch per subscription", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptions: [{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }] } },
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([
      { channelId: "acct1", subscriptionChannelId: "UCa" },
      { channelId: "acct1", subscriptionChannelId: "UCb" },
    ]);
  });

  it("dedupes the same pair across legacy-scalar and array-shaped nodes", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCa" } },
        { id: "n2", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptions: [{ channelId: "UCa", channelName: "A" }, { channelId: "UCb", channelName: "B" }] } },
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([
      { channelId: "acct1", subscriptionChannelId: "UCa" },
      { channelId: "acct1", subscriptionChannelId: "UCb" },
    ]);
  });

  it("skips array-shaped nodes with no account channelId", async () => {
    const graph = {
      nodes: [
        { id: "n1", type: "youtubeContentTrigger", data: { channelId: "", subscriptions: [{ channelId: "UCa", channelName: "A" }] } },
      ],
    };
    const env = makeEnv([{ graph_json: JSON.stringify(graph) }]);
    const res = await worker.fetch(req("/internal/youtube-watches", { "X-Internal-Secret": "secret" }), env);
    const body = await res.json() as any;
    expect(body.watches).toEqual([]);
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run tests/unit/youtube-watches.test.ts`
Expected: 新 3 例 FAIL（数组形状被旧代码当 `subscriptionChannelId` 缺失跳过）；既有用例 PASS。

- [ ] **Step 7: 改 watches 端点**

`flow/src/index.ts` 的 `/internal/youtube-watches`（约 1242-1252 行）节点循环替换为：

```ts
    for (const node of graph.nodes) {
      if (!node.data) continue;
      if (node.type !== "youtubeContentTrigger") continue;
      const channelId = node.data.channelId as string;
      if (!channelId) continue;
      // 多订阅逐 pair 展开；旧标量经 resolver 回退后与改动前逐字节一致。
      for (const sub of resolveYouTubeSubscriptions(node.data)) {
        const key = `${channelId}:${sub.channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        watches.push({ channelId, subscriptionChannelId: sub.channelId });
      }
    }
```

顶部 import：index.ts 已有来自 `../nodeTypeRegistry` 的 import 则扩充，否则新增
`import { resolveYouTubeSubscriptions } from "../nodeTypeRegistry";`

- [ ] **Step 8: 跑两个测试文件确认全过**

Run: `npx vitest run tests/unit/youtube-watches.test.ts tests/unit/engine.test.ts`
Expected: PASS 全部。

- [ ] **Step 9: Commit**

```bash
git add flow/src/engine.ts flow/src/index.ts flow/tests/unit/engine.test.ts flow/tests/unit/youtube-watches.test.ts
git commit -m "feat(flow): engine membership match + youtube-watches pair expansion for multi-subscription"
```

---

### Task 3: 发布校验 — 至少选 1 个订阅

**Files:**
- Modify: `flow/frontend/lib/validate-flow-graph.ts`
- Modify: `flow/frontend/pages/EditorPage.tsx:107-131`
- Test: `flow/tests/unit/validate-flow-graph.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveYouTubeSubscriptions`（validate-flow-graph.ts 已 import `CONDITION_LOGIC_OR` from `../../nodeTypeRegistry`，扩充同一行）
- Produces: `export function findYouTubeTriggerNoSubscriptionIds(nodes: { id: string; type?: string; data?: Record<string, unknown> }[]): string[]`；`validateFlowGraph` 返回值新增键 `youtubeNoSubscriptionNodeIds: string[]` 并计入 `valid`。

- [ ] **Step 1: 写失败测试**

`flow/tests/unit/validate-flow-graph.test.ts` 追加 describe（import 行加上 `findYouTubeTriggerNoSubscriptionIds`）：

```ts
describe("findYouTubeTriggerNoSubscriptionIds", () => {
  it("flags youtubeContentTrigger with no usable subscription (missing / empty array / empty legacy scalar)", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger", data: {} },
      { id: "t2", type: "youtubeContentTrigger", data: { subscriptions: [] } },
      { id: "t3", type: "youtubeContentTrigger", data: { subscriptionChannelId: "" } },
    ];
    expect(findYouTubeTriggerNoSubscriptionIds(nodes)).toEqual(["t1", "t2", "t3"]);
  });

  it("passes with a non-empty subscriptions array", () => {
    const nodes = [{ id: "t1", type: "youtubeContentTrigger", data: { subscriptions: [{ channelId: "UCa", channelName: "A" }] } }];
    expect(findYouTubeTriggerNoSubscriptionIds(nodes)).toEqual([]);
  });

  it("passes with a legacy scalar selection (published old graphs)", () => {
    const nodes = [{ id: "t1", type: "youtubeContentTrigger", data: { subscriptionChannelId: "UCa", subscriptionChannelName: "A" } }];
    expect(findYouTubeTriggerNoSubscriptionIds(nodes)).toEqual([]);
  });

  it("ignores other node types", () => {
    const nodes = [{ id: "x1", type: "xContentTrigger", data: {} }];
    expect(findYouTubeTriggerNoSubscriptionIds(nodes)).toEqual([]);
  });
});

describe("validateFlowGraph: youtube trigger without subscription", () => {
  it("is invalid and lists the trigger id", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger", data: { subscriptions: [] } },
      { id: "a1", type: "action", data: {} },
    ];
    const result = validateFlowGraph(nodes, [{ source: "t1", target: "a1" }]);
    expect(result.valid).toBe(false);
    expect(result.youtubeNoSubscriptionNodeIds).toEqual(["t1"]);
  });
});
```

同时修既有两处 strict `toEqual` fixture（`validate-flow-graph.test.ts:94` 与 `:271` 附近）：期望对象补键 `youtubeNoSubscriptionNodeIds: []`。**注意**：若 fixture 图里含 youtubeContentTrigger 节点且断言 `valid: true`，给该节点 data 补 `subscriptions: [{ channelId: "UCa", channelName: "A" }]`，不要放宽匹配器。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: 新用例 FAIL（函数不存在）；两处 strict fixture 因缺新键 FAIL。

- [ ] **Step 3: 实现 finder**

`flow/frontend/lib/validate-flow-graph.ts`：import 行扩充 `resolveYouTubeSubscriptions`；在 `findOrLogicEmptyNodeIds` 之后追加：

```ts
// 多选订阅上线的同时把「一个都没选」从"静默不触发"改为发布前拦截（用户决策，见
// 2026-08-01 spec D4）。必须用与运行时同一个 resolver：旧图的单标量经回退长度为 1
// 照常通过，发布校验和 engine.ts 的 membership 判定永远一致。
export function findYouTubeTriggerNoSubscriptionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "youtubeContentTrigger")
    .filter((n) => resolveYouTubeSubscriptions(n.data).length === 0)
    .map((n) => n.id);
}
```

`validateFlowGraph`：返回类型与返回对象加 `youtubeNoSubscriptionNodeIds: string[]`，`valid` 的合取里加 `youtubeNoSubscriptionNodeIds.length === 0`（写法照抄既有四个字段的模式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: PASS 全部。

- [ ] **Step 5: EditorPage 接线**

`flow/frontend/pages/EditorPage.tsx`（107-131 行）：
1. 解构加 `youtubeNoSubscriptionNodeIds`；
2. `setErrorNodeIds` 的去重数组并入 `...youtubeNoSubscriptionNodeIds`；
3. toast 标题三元链在 `orLogicEmptyNodeIds` 之后、misplaced 兜底之前插入：

```tsx
                    : youtubeNoSubscriptionNodeIds.length > 0
                      ? `${youtubeNoSubscriptionNodeIds.length} 个 YouTube Trigger 没有选择 subscription，无法发布`
```

- [ ] **Step 6: 构建门禁**

Run（`flow/` 目录）: `npx vite build --mode development`
Expected: 构建成功，无新增错误。

- [ ] **Step 7: Commit**

```bash
git add flow/frontend/lib/validate-flow-graph.ts flow/frontend/pages/EditorPage.tsx flow/tests/unit/validate-flow-graph.test.ts
git commit -m "feat(flow): publish gate — YouTube Trigger must select at least one subscription"
```

---

### Task 4: 前端纯函数 lib + 通用 MultiSelect 组件

**Files:**
- Create: `shared/frontend/lib/multi-select-summary.ts`
- Create: `shared/frontend/ui/multi-select.tsx`
- Create: `flow/frontend/lib/subscription-summary.ts`
- Test: `flow/tests/unit/subscription-summary.test.ts`（新建，同时测两个 lib）

**Interfaces:**
- Consumes: Task 1 的 `YouTubeSubscriptionRef` 类型（`flow/nodeTypeRegistry.ts`）
- Produces:
  - `multiSelectSummary(selectedLabels: string[], placeholder: string): string`
  - `MultiSelect` 组件，props：`{ options: { value: string; label: string }[]; selectedValues: string[]; onToggle: (value: string) => void; placeholder: string; tooltip: string }`
  - `subscriptionSummary(subs: YouTubeSubscriptionRef[]): string`
  - `toggleSubscription(current: YouTubeSubscriptionRef[], sub: YouTubeSubscriptionRef): YouTubeSubscriptionRef[]`

- [ ] **Step 1: 写失败测试**

新建 `flow/tests/unit/subscription-summary.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { subscriptionSummary, toggleSubscription } from "../../frontend/lib/subscription-summary";
import { multiSelectSummary } from "../../../shared/frontend/lib/multi-select-summary";

describe("subscriptionSummary", () => {
  it("0 subscriptions", () => {
    expect(subscriptionSummary([])).toBe("(no subscription selected)");
  });
  it("1 subscription shows its name", () => {
    expect(subscriptionSummary([{ channelId: "UCa", channelName: "MKBHD" }])).toBe("MKBHD");
  });
  it("falls back to channelId when name is empty", () => {
    expect(subscriptionSummary([{ channelId: "UCa", channelName: "" }])).toBe("UCa");
  });
  it("N subscriptions shows first +N-1", () => {
    expect(subscriptionSummary([
      { channelId: "UCa", channelName: "MKBHD" },
      { channelId: "UCb", channelName: "Veritasium" },
      { channelId: "UCc", channelName: "Kurzgesagt" },
    ])).toBe("MKBHD +2");
  });
});

describe("toggleSubscription", () => {
  const a = { channelId: "UCa", channelName: "A" };
  const b = { channelId: "UCb", channelName: "B" };
  it("adds an unselected subscription at the end", () => {
    expect(toggleSubscription([a], b)).toEqual([a, b]);
  });
  it("removes an already-selected subscription (matched by channelId)", () => {
    expect(toggleSubscription([a, b], { channelId: "UCa", channelName: "stale name" })).toEqual([b]);
  });
  it("does not mutate the input array", () => {
    const current = [a];
    toggleSubscription(current, b);
    expect(current).toEqual([a]);
  });
});

describe("multiSelectSummary", () => {
  it("empty selection shows placeholder", () => {
    expect(multiSelectSummary([], "Select subscriptions...")).toBe("Select subscriptions...");
  });
  it("single selection shows the label", () => {
    expect(multiSelectSummary(["MKBHD"], "x")).toBe("MKBHD");
  });
  it("multiple selections show first +N more", () => {
    expect(multiSelectSummary(["MKBHD", "Veritasium", "Kurzgesagt"], "x")).toBe("MKBHD +2 more");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/subscription-summary.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现两个 lib**

新建 `shared/frontend/lib/multi-select-summary.ts`：

```ts
// MultiSelect 触发按钮上的已选摘要。独立成纯函数文件：测试环境是 workerd（无 DOM），
// 组件本体没法单测，把可测的决策逻辑放在这里。
export function multiSelectSummary(selectedLabels: string[], placeholder: string): string {
  if (selectedLabels.length === 0) return placeholder;
  if (selectedLabels.length === 1) return selectedLabels[0];
  return `${selectedLabels[0]} +${selectedLabels.length - 1} more`;
}
```

新建 `flow/frontend/lib/subscription-summary.ts`：

```ts
import type { YouTubeSubscriptionRef } from "../../nodeTypeRegistry";

// 节点卡片上的订阅摘要。名称缺失（旧数据或畸形值降级）时退回 channelId——
// 卡片上显示空串会让节点看起来"没选"，而它其实选了。
export function subscriptionSummary(subs: YouTubeSubscriptionRef[]): string {
  if (subs.length === 0) return "(no subscription selected)";
  const first = subs[0].channelName || subs[0].channelId;
  return subs.length === 1 ? first : `${first} +${subs.length - 1}`;
}

// Inspector 勾选/取消后应写入的下一个数组。按 channelId 判存在性：已选条目的
// channelName 可能是旧快照，不参与比较。
export function toggleSubscription(
  current: YouTubeSubscriptionRef[],
  sub: YouTubeSubscriptionRef
): YouTubeSubscriptionRef[] {
  return current.some((s) => s.channelId === sub.channelId)
    ? current.filter((s) => s.channelId !== sub.channelId)
    : [...current, sub];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/subscription-summary.test.ts`
Expected: PASS 10/10。

- [ ] **Step 5: 实现 MultiSelect 组件**

新建 `shared/frontend/ui/multi-select.tsx`：

```tsx
import { Popover, PopoverTrigger, PopoverContent } from "./popover";
import { Checkbox } from "./checkbox";
import { Button } from "./button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { multiSelectSummary } from "../lib/multi-select-summary";

export interface MultiSelectOption {
  value: string;
  label: string;
}

// 通用多选下拉：按钮显示已选摘要，Popover 内是可滚动 checkbox 列表。
// 受控组件：选中态完全来自 selectedValues，每次勾选/取消回调 onToggle(value)，
// 由调用方决定写入什么（flow 里是 updateNodeData）。
export function MultiSelect({
  options,
  selectedValues,
  onToggle,
  placeholder,
  tooltip,
  className,
}: {
  options: MultiSelectOption[];
  selectedValues: string[];
  onToggle: (value: string) => void;
  placeholder: string;
  tooltip: string;
  className?: string;
}) {
  const selectedLabels = options.filter((o) => selectedValues.includes(o.value)).map((o) => o.label);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="outline" className={cn("w-full justify-between text-sm font-normal", className)}>
              <span className="truncate">{multiSelectSummary(selectedLabels, placeholder)}</span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 max-h-64 overflow-y-auto p-2">
        {options.length === 0 ? (
          <p className="px-2 py-1 text-xs italic text-muted-foreground">No options</p>
        ) : (
          options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={selectedValues.includes(o.value)}
                onCheckedChange={() => onToggle(o.value)}
              />
              <span className="truncate">{o.label}</span>
            </label>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
```

**已知陷阱**：`TooltipTrigger asChild` 会把自己的 `data-state`（closed/delayed-open）克隆到子元素上，覆盖同名属性——本组件按钮不依赖 `data-state` 样式，无碍；但不要给这个 Button 加任何 `data-[state=...]:` 类。

- [ ] **Step 6: 构建门禁**

Run（`flow/` 目录）: `npx vite build --mode development`
Expected: 构建成功（组件此时尚无人引用，仅验证不破坏既有构建）。

- [ ] **Step 7: Commit**

```bash
git add shared/frontend/lib/multi-select-summary.ts shared/frontend/ui/multi-select.tsx flow/frontend/lib/subscription-summary.ts flow/tests/unit/subscription-summary.test.ts
git commit -m "feat(shared,flow): generic MultiSelect component + subscription summary/toggle helpers"
```

---

### Task 5: 前端集成 — Inspector、节点卡片、默认 data、AI promptFragment

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:447-525`（`YouTubeContentTriggerInspector`）
- Modify: `flow/frontend/nodes/YouTubeContentTriggerNode.tsx`
- Modify: `flow/frontend/store/flow-editor.ts:194`
- Modify: `flow/nodeTypeRegistry.ts:186-189`（youtubeContentTrigger 的 promptFragment）

**Interfaces:**
- Consumes: Task 1 `resolveYouTubeSubscriptions`；Task 4 `MultiSelect`、`subscriptionSummary`、`toggleSubscription`

- [ ] **Step 1: Inspector 换 MultiSelect**

`flow/frontend/components/Inspector.tsx`：
1. import 追加：`resolveYouTubeSubscriptions`（并入既有 nodeTypeRegistry import 行）、`import { MultiSelect } from "../../../shared/frontend/ui/multi-select";`、`import { toggleSubscription } from "../lib/subscription-summary";`
2. `YouTubeContentTriggerInspector` 内，删除 `const subscriptionChannelId = data.subscriptionChannelId as string;`，改为：

```tsx
  const selectedSubs = resolveYouTubeSubscriptions(data);
```

3. `Subscription` 区块的 `<Select>...</Select>`（约 492-508 行）整体替换为：

```tsx
            <MultiSelect
              options={(() => {
                // 已选但已退订（不在接口返回里）的条目也要出现在列表中，
                // 否则旧 flow 打开后无法取消勾选它。
                const fetched = state.subscriptions.map((s) => ({ value: s.channelId, label: s.channelName }));
                const fetchedIds = new Set(state.subscriptions.map((s) => s.channelId));
                const stale = selectedSubs
                  .filter((s) => !fetchedIds.has(s.channelId))
                  .map((s) => ({ value: s.channelId, label: s.channelName || s.channelId }));
                return [...fetched, ...stale];
              })()}
              selectedValues={selectedSubs.map((s) => s.channelId)}
              onToggle={(channelId) => {
                const sub = state.subscriptions.find((s) => s.channelId === channelId);
                const existing = selectedSubs.find((s) => s.channelId === channelId);
                updateNodeData(nodeId, {
                  channelId: state.accountChannelId || "",
                  subscriptions: toggleSubscription(selectedSubs, {
                    channelId,
                    channelName: sub?.channelName || existing?.channelName || "",
                  }),
                  // 旧标量一并清空：从此该节点只认数组，避免两套字段并存歧义。
                  subscriptionChannelId: "",
                  subscriptionChannelName: "",
                });
              }}
              placeholder="Select subscriptions..."
              tooltip="Select one or more subscriptions"
            />
```

4. 外层 `Label` 文案 `Subscription` 改为 `Subscriptions`；`state.subscriptions.length === 0` 的空态判断改为 `state.subscriptions.length === 0 && selectedSubs.length === 0`（有 stale 已选项时仍要渲染 MultiSelect 让用户能取消）。
5. 说明文案改为 `Fires when any selected subscription publishes a new video.`

- [ ] **Step 2: 节点卡片**

`flow/frontend/nodes/YouTubeContentTriggerNode.tsx`：

```tsx
import { subscriptionSummary } from "../lib/subscription-summary";
import { resolveYouTubeSubscriptions } from "../../nodeTypeRegistry";
```

`const channelName = ...` 行替换为：

```tsx
  const channelName = subscriptionSummary(resolveYouTubeSubscriptions(data as Record<string, unknown>));
```

- [ ] **Step 3: addNode 默认 data**

`flow/frontend/store/flow-editor.ts:194`：

```ts
      data = { channelId: "", subscriptions: [], conditions: [] };
```

- [ ] **Step 4: promptFragment**

`flow/nodeTypeRegistry.ts` youtubeContentTrigger 条目的 `promptFragment` 改为：

```ts
    promptFragment: `youtubeContentTrigger - triggers when any of the selected subscribed YouTube channels publishes a new video
   data: { channelId: "", subscriptions: [], conditions: [] }
   - channelId and subscriptions are left blank — the user picks one or more subscriptions from a multi-select in the Inspector after generation, sourced from their connected YouTube account (OAuth) on the Social page.
   - conditions may filter on "duration" (seconds).`,
```

- [ ] **Step 5: 回归相关测试 + 构建**

Run: `npx vitest run tests/unit/generate-prompt.test.ts tests/unit/node-type-registry.test.ts tests/unit/single-trigger-constraint.test.ts && npx vite build --mode development`
Expected: 若有断言钉住旧 promptFragment 文本或旧默认 data 形状，同步更新断言为新文本/新形状（不放宽匹配器）；构建成功。

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/components/Inspector.tsx flow/frontend/nodes/YouTubeContentTriggerNode.tsx flow/frontend/store/flow-editor.ts flow/nodeTypeRegistry.ts
git commit -m "feat(flow): YouTube Trigger multi-subscription UI — Inspector MultiSelect, card summary, defaults"
```

（若 Step 5 改了测试文件，把对应 `flow/tests/unit/*.test.ts` 一并列进 `git add`。）

---

### Task 6: 全量回归 + dev 部署 + 浏览器验证

**Files:** 无新改动（发现问题则回到对应任务修）

- [ ] **Step 1: flow 全量测试**

Run（`flow/` 目录）: `npm test`
Expected: 全部通过（本功能前基线 458 例，现在应为基线 + 新增用例数）。

- [ ] **Step 2: 类型回归抽查**

Run（`flow/` 目录）: `npx tsc --noEmit 2>&1 | grep -E "(nodeTypeRegistry|engine|index|validate-flow-graph|EditorPage|Inspector|YouTubeContentTriggerNode|flow-editor|subscription-summary|multi-select)" | grep -v "shared/frontend"`
Expected: 无本次触碰文件的新错误（repo 有存量 baseline 错误，只看触碰文件）。

- [ ] **Step 3: 部署 dev**

Run（`flow/` 目录）: `npm run deploy:dev`
Expected: 部署成功，记录 Version ID。

- [ ] **Step 4: 浏览器验证（真实登录态，flow-dev.uni-scrm.com）**

逐项确认：
1. 新建 content flow，拖 YouTube Trigger：Inspector 显示 `Subscriptions` 多选按钮，placeholder `Select subscriptions...`，按钮 tooltip 正确。
2. 勾 1 个：按钮与卡片均显示名称；勾第 2、3 个：按钮 `首名 +2 more`，卡片 `首名 +2`。
3. 取消全部勾选后 Publish：toast `1 个 YouTube Trigger 没有选择 subscription，无法发布`，节点红框，不跳转。
4. 勾回 ≥1 个后 Publish 成功。
5. 打开一条**存量**（旧标量字段）的 YouTube Trigger flow：卡片与 Inspector 正确显示旧的单选项为已勾选；不做任何修改时不出现 Unsaved。
6. 对已发布多订阅 flow，`GET /internal/youtube-watches`（带 secret，用 curl 或 wrangler tail 侧证）返回逐 pair 展开。
7. 测试用的临时 flow 删除干净。

- [ ] **Step 5: 汇报**

汇报测试数、Version ID、浏览器验证结果；不 push。
