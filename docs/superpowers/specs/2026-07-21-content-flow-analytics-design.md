# Content Flow Analytics — Node Detail Drawer Design Spec

**Date:** 2026-07-21
**Status:** Design approved (pending user spec review)
**Module(s):** `flow`, `link`, `metadata`, `analytics`（pipeline schema）

## Goal

Content flow 的 analytics 页面点开一个 node 时，右侧抽屉需要展示每个进入该 node 的 content 的详情，而不是像现在这样（跟 user flow 共用一套渲染，且字段名对不上导致内容域完全显示不出东西）：

- **左侧**：content 预览。有 title 就显示 title；没有则显示 `content_text` 前 5 个字 + "…"；下方附 content_url（若是 `videoAction` 节点，则改为显示该节点产出视频的 R2 链接）。
- **右侧**：跟 user flow 一样显示时间；如果该 content 在这个 node 的执行 outcome 是 failed，时间下方红字显示 "Failed"。

## Feasibility Findings（决定设计边界，勿在实现中推翻）

- **当前 node 日志完全不记录成功/失败**：`flow_log`/`content_flow_log` 只有 `enter`/`exit` 两种 direction，没有任何 outcome 信号。`engine.ts` 里 `resumeFromNode(graph, nodeId, payload, branch)` 在知道 branch（"success"/"failed"）时，会对同一个 action node 再 push 一次 `exit`（engine.ts:210）——但这一条目前在**所有调用点**都被 `.slice(1)` 丢弃，只是为了避免把 badge 的 exit 计数算重复。这条被丢弃的 exit 恰好是唯一带着 outcome 信息的时机点。
- **X List Posts / YouTube 订阅触发不写 `content` 表行**：`ContentService.emitContentTriggerEvent()` 直接用一个新的 `crypto.randomUUID()` 当 `contentId` 分发到 flow 队列，从不落库；只有 `own:get-posts`（`upsertContentFromMetadata`）才写真实 content 行且 id 对得上。**但本设计不依赖 D1 `content` 表**（见下一条），所以这个既有缺口不阻塞本次功能，暂不修复。
- **content 预览字段直接来自 `payload`，不查 D1**：`emitContentTriggerEvent`/`upsertContentFromMetadata` 分发到 flow 队列时，`payload` 里已经带了 `title`/`content_text`（来自 `resolveProps`）。把这些字段连同新增的 `content_url` 一起写进 `content_flow_log` 的每一条 node 访问记录里，就不需要任何 D1 join——无论该 content 是否有 D1 行都能正常显示。
- **X/YouTube 没有 API 返回的永久链接字段**：`tweet.fields`、`videos.list` 都不含 permalink。这两个平台的 URL 规则是官方公开、不依赖 username 的固定格式（`x.com/i/status/{id}`、`youtube.com/watch?v={id}`），因此在 poller 里一次性拼接、存成 `content_url` 是可接受的（不是运行时猜测/爬取）。
- **TikTok 有官方返回的 `share_url` 字段**，但目前 `VIDEO_FIELDS`（`tiktok-content-api.ts`）没有请求它。
- **videoAction 节点展示的是节点产出，不是原始内容**：`processed_video_url` 是 `videoAction` 执行时算出来的（`flow/src/index.ts` 里的 `videoUrl` 变量），每个 content 每次执行可能不同，粒度天然是 `(flow_id, node_id, content_id)`——跟 `content_flow_log` 本身的粒度一致，因此复用同一张表加列，而不是另建一张按同样粒度关联的表。

## Design Decisions（已与用户确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | Failed 状态来源 | 给 `content_flow_log`（以及 `flow_log`，为对称）加 `outcome` 字段，schema evolution，旧数据 NULL 兼容 |
| 2 | Outcome 加列范围 | `flow_log` 和 `content_flow_log` 一起加，即使 user flow 暂时不用 |
| 3 | Content 详情存储位置 | 直接加在 `content_flow_log` 上（`title`/`content_text`/`content_url`），不另建表、不 join |
| 4 | content_url 来源 | X/YouTube 在 poller 里一次性拼接固定格式 URL；TikTok 用 API 自带的 `share_url` |
| 5 | List Posts/YouTube 订阅无 content 行的问题 | 本次不修，因为不再需要 D1 join |
| 6 | Schema 变更机制 | `wrangler pipelines streams`只有 create/list/get/delete，没有 update；R2 SQL 明确拒绝 `ALTER`/`CREATE`/`DROP`（"only read-only queries are allowed"）。所以给 `content_flow_log`/`flow_log` 加列，必须删除并重建 stream + pipeline（sink 指向的 Iceberg 表本身独立于 stream/pipeline 生命周期，不会被删，存量数据不丢）。曾考虑改用一张全新的、纯增量的独立详情表来规避这个重建动作，但用户明确要求仍按方案 3 走（直接加列），并确认**当前无真实客户数据，dev/prod 的 stream+pipeline 重建可接受**——这与 CLAUDE.md「prod 环境尽量不删除或重建资源」的一般准则相悖，但属于本次经用户明确豁免的例外，不代表以后可以照搬 |

## Architecture

```
poller (x-posts.ts / x-list-posts.ts / youtube-content.ts / tiktok-content.ts)
    │  resolveProps() 结果 + 一次性拼接/API 自带的 content_url
    ▼
payload = { channel_type, title, content_text, content_url, source_content_id, ... }
    │  flowQueue.send({ contentId, payload, ... })  （videoAction 成功后 payload 多一个 processed_video_url）
    ▼
flow/src/index.ts  queue() / executeContentActions()
    │  collectActions()：nodeLogs.push({ nodeId, direction: "enter"|"exit" })     ← 不变，badge 计数
    │  resumeFromNode()：wait/waitForEvent/timeCondition → 唯一的 exit，原样保留
    │                     其余可 resume 类型 → index-0 重标记为 { direction: "outcome", outcome: branch }
    ▼
emitContentNodeLogs(nodeLogs, ..., payload)：整批统一从 payload 取 title/content_text/
    (payload.processed_video_url || payload.content_url)，写到这一批每条记录上
    → 写入 R2 uniscrm.content_flow_log
    (tenant_id, flow_id, node_id, content_id, direction, outcome?, title?, content_text?, content_url?, created_at)
    ▼
GET /api/flows/:id/nodes/:nodeId/logs   ← 直接读 R2，按 content_id 去重取最新一条，不再 join D1 content 表
    ▼
AnalyticsPage.tsx 右侧抽屉：每行 [左: title||content_text前5字+…  content_url]  [右: 时间 / 红字Failed]
```

## Components

### 1. Pipeline schema — `analytics/pipelines/content-flow-log-stream-schema.json`

新增 4 个 nullable 字段：

```json
{ "name": "outcome", "type": "string", "required": false },
{ "name": "title", "type": "string", "required": false },
{ "name": "content_text", "type": "string", "required": false },
{ "name": "content_url", "type": "string", "required": false }
```

`analytics/pipelines/flow-log-stream-schema.json` 只加 `outcome` 一个字段（user flow 暂无 title/content_text/content_url 的场景）。

**变更机制（已验证）：** `wrangler pipelines streams`只有 create/list/get/delete，没有 update 子命令；R2 SQL 明确拒绝 `ALTER`/`CREATE`/`DROP`（"only read-only queries are allowed"，见 R2 SQL reference 的 Unsupported SQL features）。所以加字段必须删除并重建 stream + pipeline（4 个：`uniscrm_flow_log_dev`/`uniscrm_content_flow_log_dev`/`uniscrm_flow_log`/`uniscrm_content_flow_log` 及对应的 4 个 pipeline）。sink（`flow_log_sink_dev`/`content_flow_log_sink_dev`/`flow_log_sink`/`content_flow_log_sink`）指向的 Iceberg 表按 `--table` 名字持久存在、不随 sink/stream/pipeline 生命周期改变，重建不影响存量数据。

**顺带修复：** dev 环境的 `uniscrm_content_flow_log_pipeline_dev` 当前是 `failed` 状态（`R2 bucket [uniscrm-dev]: invalid credentials (signature mismatch)`，`content_flow_log_sink_dev` 的 `--catalog-token` 已失效）——与本功能无关的既有问题，但既然要重建同一批资源，顺带一起修（重新生成/获取一个有效的 R2 catalog token）。

**执行顺序（dev → prod，先验证再对 prod 操作）：**

```bash
# --- dev：flow_log（只加 outcome）---
wrangler pipelines streams delete uniscrm_flow_log_dev -y
wrangler pipelines streams create uniscrm_flow_log_dev --schema-file analytics/pipelines/flow-log-stream-schema.json
wrangler pipelines create uniscrm_flow_log_pipeline_dev --sql "INSERT INTO flow_log_sink_dev SELECT * FROM uniscrm_flow_log_dev"

# --- dev：content_flow_log（加 outcome/title/content_text/content_url + 顺带修 sink 凭证）---
wrangler pipelines streams delete uniscrm_content_flow_log_dev -y
wrangler pipelines streams create uniscrm_content_flow_log_dev --schema-file analytics/pipelines/content-flow-log-stream-schema.json
wrangler pipelines sinks delete content_flow_log_sink_dev -y
wrangler pipelines sinks create content_flow_log_sink_dev \
  --type r2-data-catalog --bucket uniscrm-dev --namespace uniscrm --table content_flow_log \
  --catalog-token "$R2_TOKEN"   # 需要一个当前有效的 R2 catalog token，旧的已失效
wrangler pipelines create uniscrm_content_flow_log_pipeline_dev --sql "INSERT INTO content_flow_log_sink_dev SELECT * FROM uniscrm_content_flow_log_dev"
```

验证（读，安全）：跑一次真实的 content flow 触发，然后 `wrangler r2 sql query <warehouse> "DESCRIBE uniscrm.content_flow_log"` 确认新列存在，`SELECT * FROM uniscrm.content_flow_log ORDER BY created_at DESC LIMIT 5` 确认新写入的行带着 `outcome`/`title`/`content_text`/`content_url`。dev 验证通过后，对 `uniscrm_flow_log`/`uniscrm_content_flow_log`（生产，无 `_dev` 后缀，bucket 为 `uniscrm`）重复同样的 delete/create 步骤——生产的 `content_flow_log_sink` 凭证未失效，不需要顺带修复那一步。

### 2. `flow/src/engine.ts` — `NodeLog` 接口 + outcome 附着（按节点类型区分，不能无条件重标记）

```typescript
export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit" | "outcome";
  outcome?: string;   // "success" | "failed" 等，仅 direction === "outcome" 时有值
}
```

**关键纠正：** 不能无条件把 `resumeFromNode` 的 index-0 重标记为 `"outcome"`。`wait`/`waitForEvent`/`timeCondition` 三种节点被 resume 时，index-0 是它们**唯一**的合法 exit（`collectActions` 从不为这三种类型提前记 exit，是等 resume 时才记——见 engine.ts 里各自的 "exit will be logged when..." 注释）；其余可 resume 的类型（所有 `action` 节点，含 `xAction`/`xContentAction`/`tiktokContentAction`/`youtubeContentAction`/`videoAction`/`addToList`；以及 `webhook`/`abSplit`/`userPropsCondition`/`videoCondition`）在 `collectActions` 里已经提前记过一次 exit，index-0 才是那条要丢弃/重标记的重复项。用户流（user flow）里已有的 `wait`/`waitForEvent` resume 调用（index.ts 现有的 1542/1824 两处）如果被无条件重标记，会把它们唯一合法的 exit 从 badge 计数里踢出去——这是必须避免的回归。

`resumeFromNode()`（engine.ts:210）把原来的

```typescript
nodeLogs.push({ nodeId, direction: "exit" });
```

改成

```typescript
const originatingNode = graph.nodes.find((n) => n.id === nodeId);
const DEFERRED_EXIT_TYPES = ["wait", "waitForEvent", "timeCondition"];
if (originatingNode && DEFERRED_EXIT_TYPES.includes(originatingNode.type)) {
  nodeLogs.push({ nodeId, direction: "exit" });
} else {
  nodeLogs.push({ nodeId, direction: "outcome", outcome: branch });
}
```

### 3. Content 预览字段——写在每一条记录上，不只是 outcome 行

**关键纠正：** 若 title/content_text/content_url 只挂在 outcome 行上，trigger 节点（`xContentTrigger`/`youtubeContentTrigger`，从不产生 outcome）永远没有预览可显示，这正好违反了原始需求的第一个例子。这三个字段在整个 content 执行过程中来自同一个 `payload`（只在 `videoAction` 产出新视频后变化），所以改为**由 `emitContentNodeLogs` 按整批统一从 `payload` 取值，写到这一批的每一条记录上**（不区分 enter/exit/outcome），彻底不需要动 `engine.ts`/`NodeLog` 来传这三个字段。

`content_url` 取值：`payload?.processed_video_url || payload?.content_url`——`processed_video_url` 优先且无需按节点类型判断：一旦某个 `videoAction` 产出了新视频，下游任何节点（包括链式的第二个 `videoAction`，见 `cdbf8c5`"chain videoAction nodes via processed_video_url"）拿到的 `payload.processed_video_url` 天然是"当前最新产出"，直接展示这个就是正确语义，不需要在 `resumeFromNode`/`engine.ts` 里查 `graph.nodes` 判断节点类型。

`flow/src/index.ts`：

```typescript
async function emitContentNodeLogs(
  nodeLogs: NodeLog[],
  flowId: string,
  contentId: string,
  tenantId: string,
  env: Env,
  payload: Record<string, unknown>
): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  const contentUrl = (payload?.processed_video_url as string) || (payload?.content_url as string) || undefined;
  const records = nodeLogs.map((log) => ({
    tenant_id: Number(tenantId),
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    content_id: contentId,
    direction: log.direction,
    outcome: log.direction === "outcome" ? log.outcome : undefined,
    title: payload?.title as string | undefined,
    content_text: payload?.content_text as string | undefined,
    content_url: contentUrl,
    created_at: timestamp,
  }));
  await env.PIPELINE_CONTENT_FLOW_LOG?.send(records).catch(() => {});
}
```

`payload` 改为必填参数（不给默认值）——所有 15 个 `emitContentNodeLogs` 调用点都已经有 `payload`（或该作用域里等价的变量，如 queue() 里的 `matchPayload`）在作用域内，加这个参数是纯机械改动，逐一在 Task 里列出。

`emitNodeLogs`（user flow）**不需要加参数**——`outcome` 已经在 `NodeLog` 对象自身的 `.outcome` 字段上（resumeFromNode 已经设置好），只需要在记录里加一行 `outcome: log.direction === "outcome" ? log.outcome : undefined`，3 个调用点原样不动。

### 4. `flow/src/index.ts` — 调用点改动

13 处 `if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), ...)`（或 `resolved`/`failedResult` 变量名）改为 `if (X.nodeLogs.length > 0) await emitContentNodeLogs(X.nodeLogs, ..., payload)`（不再丢弃 index 0——按第 2 点的规则，非 wait 类节点的 index-0 现在是安全的 `direction: "outcome"`，不会被 badge 聚合误算进 exit；wait 类节点的 index-0 仍然是 `direction: "exit"`，行为不变）。另外 2 处已经在传完整数组的调用点（trigger 分发、通用 sweep）只需要加 `payload` 参数。

**user-flow 侧不需要改任何调用点**：搜索确认 `flow/src/index.ts` 里所有走 `emitContentNodeLogs` 的重复-exit 处理都是内容域；`emitNodeLogs`（user flow）目前完全没有走 `resumeFromNode` 解析分支型 action（`xAction` 在 `executeActions` 里只做限流记账，没有走 `resumeFromNode`）——user flow 现有的两处 `resumeFromNode` 调用（`waitForEvent`/`timeCondition` 类型的 resume，index.ts 现有 1542/1824 两行）在第 2 点的类型判断下保持 `direction: "exit"` 不变，行为不受影响。

### 5. `queryR2Counts`/`recomputeFlowCounts` — 无需改动

`GROUP BY tenant_id, flow_id, node_id, direction` 会自然产出一组 `direction = 'outcome'` 的计数行，写进 `flow_counts`/`content_flow_counts`；前端 `AnalyticsBadges.tsx` 只读 `.enter`/`.exit`，这组多余的行不影响现有 badge 展示。

### 6. `queryNodeLogRows` / `/api/flows/:id/nodes/:nodeId/logs`（`flow/src/index.ts`）

内容域分支改为：

```sql
SELECT content_id, created_at, direction, outcome, title, content_text, content_url
FROM uniscrm.content_flow_log
WHERE tenant_id = ? AND flow_id = ? AND node_id = ? AND direction IN ('enter', 'outcome')
ORDER BY created_at DESC LIMIT 50
```

同一个 content_id 可能同时有一条 `enter` 记录（刚进入，outcome 还未知）和一条 `outcome` 记录（分支已解析）——两条的 title/content_text/content_url 相同（同一批 payload 写入），只有 `outcome`/`created_at` 不同。按 `content_id` 去重，`ORDER BY created_at DESC` 后保留每个 content_id 第一次出现的行（即最新一条——如果 outcome 已解析，它必然比 enter 晚写入，自然排在前面）。

去掉现有的 D1 `content` 表 title 查询（`tdb.query<{ id, title }>(...)`）。返回结构从 `{ content_id, name, created_at }` 改为 `{ content_id, created_at, outcome, title, content_text, content_url }`，`name` 字段整体去掉（前端不再需要）。

user-flow 分支（`user_id` 版本）保持字段不变，只加一个可选 `outcome` 透传（不强制要求，因为 user flow 前端本次不消费它）。

### 7. Poller — `content_url` 写入

- **`link/src/services/pollers/x-posts.ts` / `x-list-posts.ts`**：`upsertPage()` 里 `resolveProps()` 之后加一行 `props.content_url = `https://x.com/i/status/${props.source_content_id}`;`（与既有 `item.article` fixup 同样的写法/同样的位置）。
- **`link/src/services/pollers/youtube-content.ts`**：同理加 `props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;`。
- **`link/src/services/tiktok-content-api.ts`**：`VIDEO_FIELDS` 加 `"share_url"`。
- **`metadata/tiktok.ts`**：video.list 的 `contentProps` 加一条 `{ propId: "content_url", dataId: "{linkPrefix}.share_url" }`。
- **`metadata/props.ts`**：新增 `content_url` propId（`dataType: "TEXT"`, `entity: ["content"]`）。

不改 `content` 表 / `CONTENT_COLUMN_MAP`——`content_url` 只经过 `payload`，不落 D1。

### 8. 前端 — `flow/frontend/pages/AnalyticsPage.tsx`

- `nodeLogs` state 类型改为 `{ content_id: string; created_at: string; outcome?: string; title?: string; content_text?: string; content_url?: string }[]`（内容域）。
- 每行渲染拆成左右两栏：
  - 左：`title || (content_text ? content_text.slice(0, 5) + "…" : "")`，下方若有 `content_url` 则渲染为可点击链接。
  - 右：`new Date(created_at).toLocaleString()`；若 `outcome === "failed"`，下方红字 "Failed"。
- 抽屉标题的 `nodeName` 计算逻辑补上内容域分支：`xContentTrigger`/`youtubeContentTrigger` 用 `NODE_TYPE_REGISTRY[nodeType].label`；`action` 节点的 `actionType` 为 `xContentAction`/`tiktokContentAction`/`youtubeContentAction`/`videoAction` 时同样查 registry 或对应 label，而不是落到裸的 `nodeType` 字符串。

## Out of Scope

- 修复 List Posts / YouTube 订阅触发不写 `content` 表行的问题（不影响本功能，见 Feasibility Findings）。
- User flow 抽屉的左右分栏改版（本次只加 `outcome` 字段打底，UI 不变）。
- 已有 290 vs 205 计数差异的根因（另一个未完成的调试线索，跟本功能无关）。
