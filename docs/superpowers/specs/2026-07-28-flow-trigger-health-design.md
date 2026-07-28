# Flow Trigger Health — 设计

## 问题

一个 published flow 的 trigger 绑定的 channel 被解除认证后，flow 永远不会再被触发，但列表页仍然显示绿色的 `Published`。用户没有任何信号能发现这件事：flow 不触发就不产生日志，analytics 页一片空白，与"这段时间恰好没有事件"无法区分。`published` 在这种状态下是一句谎言。

## 事实基础（已核实）

- trigger 节点把 channel 存成 `data.channelId`：`xTrigger` / `xContentTrigger` / `youtubeContentTrigger` 三种都有；`cronTrigger` 不依赖 channel。
- `flow-editor.ts:113` 的 `addNode` 拒绝添加第二个 trigger 节点 —— **每个 flow 至多一个 trigger**。不存在"部分 trigger 失效"的中间态。
- 解绑 channel 从不删行，只把 `link` 的 `channels.is_active` 置 0（`routes-channels.ts:87/253/479`、`oauth.ts:199`）。因此失效是可判定的：flow 里的 `channelId` 不在该租户的 active channel 集合中。
- 重新授权同一个账号走 `ON CONFLICT (channel_type, source_channel_id) DO UPDATE SET is_active = 1`（`oauth.ts:602`），**复用原行的 id**。所以恢复是自动的：用户重连后，flow 里存的 `channelId` 重新有效。
- `flows.status` 只有 `draft` / `published`，`POST /api/flows/:id/publish`（`index.ts:1447`）不做任何校验。
- `StatusCell`（`shared/frontend/components/CellStatus.tsx`）已内置 `error` → 红色样式。
- `OperationCell`（`shared/frontend/components/CellOperation.tsx:41`）按 `operations[status]` 取配置，支持任意合成的 status key。
- flow → link 的内部调用用 `X-Internal-Secret` 头（`link/src/middleware.ts:60`）。

## 范围

**只检查 trigger 的 channel，不检查 action 的 channel。**

二者性质不同：trigger 的 channel 没了，整个 flow 一次都不会跑，`published` 是彻底的谎言；action 的 channel 没了，flow 照常触发，只是该节点走 failed 分支，analytics 的 `failure_reason` 里有完整记录 —— 已经有归宿。把 action 拉进来会让红色变成常见状态，钝化警报。

action channel 失效若日后要提示，合适的位置是编辑器里该节点自身标红，不是列表页的 flow 级状态。

## 判定口径

失效 = **`channelId` 为空，或不在该租户的 active channel 集合中**。

- 空 `channelId` 必须算：后果与解绑完全相同（`executeFlow` 的 `n.data.channelId === payload.channel_id` 永远不匹配），而现在的 publish 不校验，这种 flow 是能被发布出来的。
- **不包含 token 健康度**（channel 行仍 active 但 refresh token 已失效）。判断它需要真打一次外部 API，列表页每行打一次 X/YouTube API 不现实（配额、延迟）。而且 token 挂掉时 flow 仍会触发、action 走 failed 分支，analytics 有记录 —— 有归宿。channel 解绑是连触发都不发生，静默、零日志，这才是必须红的那类。
- `cronTrigger` 不依赖 channel，永不进红。
- 没有 trigger 节点的 flow 不归这里管，放行。

## 状态是派生的，不落库

DB 里 `flows.status` 始终保持 `published`，红色只是读取时算出来的展示态。

- 恢复自动发生（见上面的 `ON CONFLICT` 事实）—— 用户重新授权后红色自己消失，不需要再点一次 Publish。落库就得写一条"检测到恢复 → 改回 published"的反向逻辑，凭空多一个状态机。
- 不动 `status` 就不动引擎语义：`WHERE status = 'published'` 那十几处查询照旧，失效的 flow 只是永远匹配不上 trigger，无副作用。
- publish 是用户意图，系统不该偷偷改掉。auto-unpublish 还会连带删 `flow_pending`（`index.ts:1474`），把在途的等待节点也清掉 —— 破坏性。

## 计算时机：列表 API 实时算

不缓存、不 push。

- 成本低：一次 worker→worker fetch，link 侧是 `WHERE tenant_id = ? AND is_active = 1` 一条走索引的查询（租户的 channel 通常个位数）；flow 侧只是列表查询多 select 一个 `graph_json`（本页 10 行）。
- `trigger_count` 之所以缓存，是因为它查 R2 —— 贵且慢。channel 有效性查的是 D1 一行，性质不同。
- 缓存会开一个窗口：channel 刚解绑，列表还是绿的 —— 而这个功能的全部意义就是不让用户误以为 flow 还活着。数据准确性优先。
- link 反向 push 会让解绑路径依赖 flow，而解绑入口有 4 处（`routes-channels.ts` 3 处 + `oauth.ts` 1 处），漏一处就是静默失效。现有跨模块先例是反方向的 pull（link 的 cron 拉 flow 的 `/internal/list-watches`），本方案与之同构。

## link 不可用时的行为（两边不同，刻意的）

| 场景 | 行为 |
|---|---|
| **列表页** | fail-open：当作全部有效，正常显示 `Published`，`console.error` 记一条 |
| **publish** | fail-closed：503 中断，提示用户稍后重试，不写库 |

列表页全标红的失败模式是把一个租户所有 flow 一次性标红，用户挨个点进去查、最后发现什么事都没有 —— 这种误报会摧毁红标的可信度。反方向的漏报（link 挂着的几分钟里一个真失效的 flow 显示成绿）后果轻得多：它本来就已经静默失效了一段时间。

publish 则相反：它是一次离散的用户动作，当场就能提示"稍后重试"，用户有明确的重试抓手；带着未经验证的状态发布出去，正是这个功能要防的事。

## 组件

### `flow/src/trigger-health.ts`（新文件）

两个函数。不放进 `engine.ts` —— 那是执行引擎，这是发布前/展示期的健康检查，职责不同。

```ts
// 该租户所有 active channel 的 id 集合。link 不可用（网络错误、非 2xx、响应非 JSON）时返回 null，
// 表示"判定不出"，由调用方决定 fail-open 还是 fail-closed。
export async function fetchActiveChannelIds(
  env: Env,
  tenantId: number
): Promise<Set<string> | null>

// 这个 flow 的 trigger 是否绑 channel（cronTrigger、无 trigger、graph 解析失败都是 false）。
// publish 用它决定要不要问 link —— 一个 cron flow 不该因为 link 抖动就发布不了。
export function triggerBindsChannel(graphJson: string): boolean

// 返回失效的 trigger 节点；健康、无 trigger、或 activeIds 为 null 时返回 null。
export function findBrokenTrigger(
  graphJson: string,
  activeIds: Set<string> | null
): { nodeId: string; nodeType: string } | null

// publish 被拒时回给前端、由前端原样 toast 的人话。
export function brokenTriggerMessage(nodeType: string): string
```

`findBrokenTrigger` 的逻辑：解析 graph（解析失败返回 null），取第一个 `NODE_TYPE_REGISTRY[node.type]?.role === "trigger"` 的节点 —— `flow/nodeTypeRegistry.ts` 在模块根目录，`src/generate-prompt.ts` 已经在 import 它，后端可直接用，不要另写一份硬编码的类型列表。`cronTrigger` 放行；否则 `data.channelId` 为空或不在 `activeIds` 中即为失效。

### `link`：`GET /internal/channels/active?tenantId=`

```sql
SELECT id FROM channels WHERE tenant_id = ? AND is_active = 1
```

返回 `{ channelIds: string[] }`。走 `X-Internal-Secret`。不返回 channel 类型或名字 —— flow 只需要判断"在不在"，展示文案由 trigger 节点类型决定，那是 flow 前端本来就有的信息。

### `flow`：`GET /api/flows`

列表查询多 select `graph_json`；本页有 published 行时发一次 `fetchActiveChannelIds`。对 `status = 'published'` 的行调 `findBrokenTrigger`，把 **`broken_trigger_type: string | null`**（失效 trigger 的节点类型，如 `"xTrigger"`；`null` = 健康）加进响应。`graph_json` 本身不返回给前端。draft 行恒为 `null`。

返回节点类型而不是 boolean，是因为前端的 tooltip 文案要按 trigger 类型区分（X / YouTube），而前端拿不到 `graph_json`。

### `flow`：`POST /api/flows/:id/publish`

先取 flow 的 `graph_json`（现在的实现直接 UPDATE，没读过），再走同一套判定：

- `triggerBindsChannel` 为 false（cron flow、无 trigger）→ 不问 link，直接 UPDATE。
- `activeIds === null` → `503 { error: "Cannot verify channel status right now. Please try again." }`，不写库。
- `findBrokenTrigger` 返回非 null → `400 { error: brokenTriggerMessage(nodeType) }`，不写库。
- 否则照旧 UPDATE。

### 前端：`flow/frontend/pages/FlowsPage.tsx`

1. Status 列：`broken_trigger_type` 非 null 时渲染 `<StatusCell status="error" label="Trigger Disconnected" />`，外层包 tooltip，文案按该节点类型区分（X / YouTube）。`FlowsPage` 现在没有 `TooltipProvider` 祖先，需要补一个；`TooltipTrigger asChild` 里要再包一层 `<span>`，因为 `StatusCell` 不转发 ref（同 `frontend/nodes/XTriggerNode.tsx:29` 的写法）。
2. 行 `onClick`：失效时跳编辑器（`/flows/:id`）而非 analytics —— analytics 对一个从未触发过的 flow 就是一片空白，用户此刻需要的是修，不是看。
3. `OperationCell` 的 `status` 传合成值 `"broken"`，`operations` 加一个 `broken` 分支：primary = Edit，menu = Duplicate / Stop。（现在已发布的 flow 没有 Edit 入口，必须先 Stop。）

`FlowSummary` 接口加 `broken_trigger_type: string | null`。

### 前端：`flow/frontend/pages/EditorPage.tsx`

Publish 按钮的 `api.flows.publish(id)` 加 `try/catch`：捕获后 `toast({ variant: "destructive" })` 显示后端返回的文案，并把那个 trigger 节点塞进已有的 `setErrorNodeIds`（flow 只有一个 trigger，前端自己找得到），复用孤立节点那套红框高亮。

顺带修一个现存缺陷：现在 `api.flows.publish` 抛错完全没人接（`request` 在非 2xx 时 throw），publish 失败是静默的 —— 不跳转，也不提示。

## 测试

`flow/tests/unit/trigger-health.test.ts`：

- `findBrokenTrigger` 表驱动：空 channelId → broken；channelId 不在集合 → broken；在集合 → null；`cronTrigger` → null；`activeIds` 为 null → null；无 trigger 节点 → null；`graph_json` 非法 → null；action 节点的 channelId 失效不算数 → null。
- `triggerBindsChannel`：channel-bound trigger → true；`cronTrigger` → false；无 trigger / 非法 json → false。
- `fetchActiveChannelIds`：200 正常 → Set；200 但空数组 → 空 Set（与 null 区分开）；非 2xx → null；fetch 抛错 → null；200 但响应体形状不对 → null。
- publish 路由集成：link stub 返回不含该 channel 的集合 → 400，且库里 `status` 仍是 `draft`；link stub 抛错 → 503，`status` 仍是 `draft`；link stub 返回含该 channel 的集合 → 200，`status` 变 `published`；cron flow + link stub 抛错 → 200（根本没问 link）；别的租户的 flow → 404。
- 列表路由集成：link stub 抛错 → 所有行 `broken_trigger_type === null`（fail-open）；draft 行恒为 `null`；响应里没有 `graph_json`。
- `link` 的新内部接口：只回本租户的、只回 `is_active = 1` 的；缺 `tenantId` 或非数字 → 400（避免漏掉 WHERE 就泄露全平台 channel）。

## 不做

- 不检查 action 的 channel（见"范围"）。
- 不检查 token 健康度（见"判定口径"）。
- analytics 页顶部不加 banner，编辑器画布上不给失效 trigger 加常驻红框 —— 列表页是唯一的总览入口，点击已经把人送到编辑器。（publish 被拒时的临时高亮除外，那是复用已有机制。）
- 不 auto-unpublish。
