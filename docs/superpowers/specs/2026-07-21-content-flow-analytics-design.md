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

## Architecture

```
poller (x-posts.ts / x-list-posts.ts / youtube-content.ts / tiktok-content.ts)
    │  resolveProps() 结果 + 一次性拼接/API 自带的 content_url
    ▼
payload = { channel_type, title, content_text, content_url, source_content_id, ... }
    │  flowQueue.send({ contentId, payload, ... })
    ▼
flow/src/index.ts  queue() / executeContentActions()
    │  nodeLogs.push({ nodeId, direction: "enter"|"exit" })          ← 不变，badge 计数
    │  resumeFromNode(...) 内部 nodeLogs[0] = { nodeId, direction: "outcome", outcome: branch }
    │  （videoAction 分支：content_url 替换为刚算出的 processed_video_url）
    ▼
emitContentNodeLogs(nodeLogs, ...)  → 写入 R2 uniscrm.content_flow_log
    (tenant_id, flow_id, node_id, content_id, direction, outcome?, title?, content_text?, content_url?, created_at)
    ▼
GET /api/flows/:id/nodes/:nodeId/logs   ← 直接读 R2，不再 join D1 content 表
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

线上/dev 的 Iceberg table 用 `wrangler r2 sql` 做 schema evolution（加列，不是重建 pipeline/stream），沿用 `analytics/CLAUDE.md` 里记录的 R2 SQL 操作注意事项（warehouse 标识符、`WRANGLER_R2_SQL_AUTH_TOKEN`、非交互式 `-y`/`--force`）。dev 和 prod 都要做（`feedback_create_prod_resources_with_dev` 的教训——dev 建的同时要同步 prod）。

### 2. `flow/src/engine.ts` — `NodeLog` 接口 + outcome 附着

```typescript
export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit" | "outcome";
  outcome?: string;         // "success" | "failed"，仅 direction === "outcome" 时有值
  detail?: {                // 仅 direction === "outcome" 时有值，来自 payload
    title?: string;
    content_text?: string;
    content_url?: string;
  };
}
```

`resumeFromNode()`（engine.ts:210）把原来的

```typescript
nodeLogs.push({ nodeId, direction: "exit" });
```

改成

```typescript
const originatingNode = graph.nodes.find((n) => n.id === nodeId);
const isVideoAction = originatingNode?.type === "action" && originatingNode.data.actionType === "videoAction";
nodeLogs.push({
  nodeId,
  direction: "outcome",
  outcome: branch,
  detail: branch ? {
    title: payload?.title as string | undefined,
    content_text: payload?.content_text as string | undefined,
    // videoAction 展示的是节点产出的视频，不是原始内容——见下方 "videoAction 的 content_url 来源"
    content_url: (isVideoAction ? payload?.processed_video_url : payload?.content_url) as string | undefined,
  } : undefined,
});
```

**videoAction 的 content_url 来源：** 成功路径下，`content` worker 的 `queue-video-action.ts`（`resumeFlow(env, pendingId, "success", { processed_video_url: ... })`）已经把产出的 R2 链接放进 `props`，并在 `/internal/video-action/resume` 路由里 `payload = { ...JSON.parse(row.payload), ...(props || {}) }` 合并进 payload——不需要在 `flow/src/index.ts` 里手动补丁 payload，`resumeFromNode` 按节点类型选字段即可读到。两条同步失败路径（时长超限、无视频）本来就没有产出视频，`processed_video_url` 为空，detail 里 `content_url` 也就是空，属于预期。

### 3. `flow/src/index.ts` — 调用点改动

所有 `if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), ...)` 改为 `if (resumed.nodeLogs.length > 0) await emitContentNodeLogs(resumed.nodeLogs, ...)`（不再丢弃 index 0；它现在是安全的 `direction: "outcome"`，不会被 badge 聚合误算进 exit）。`emitNodeLogs`/`emitContentNodeLogs` 写入 R2 时，`direction === "outcome"` 的记录额外带上 `outcome`/`title`/`content_text`/`content_url` 列，其余记录这些列留空。

user-flow 侧（`emitNodeLogs`/`resumeFromNode` 调用 user 分支）同理加 `outcome` 列，但不带 `detail`（user flow 无 content 预览需求）。

### 4. `queryR2Counts`/`recomputeFlowCounts` — 无需改动

`GROUP BY tenant_id, flow_id, node_id, direction` 会自然产出一组 `direction = 'outcome'` 的计数行，写进 `flow_counts`/`content_flow_counts`；前端 `AnalyticsBadges.tsx` 只读 `.enter`/`.exit`，这组多余的行不影响现有 badge 展示。

### 5. `queryNodeLogRows` / `/api/flows/:id/nodes/:nodeId/logs`（`flow/src/index.ts`）

内容域分支改为：

```sql
SELECT content_id, created_at, outcome, title, content_text, content_url
FROM uniscrm.content_flow_log
WHERE tenant_id = ? AND flow_id = ? AND node_id = ? AND direction IN ('enter', 'outcome')
ORDER BY created_at DESC LIMIT 50
```

去掉现有的 D1 `content` 表 title 查询（`tdb.query<{ id, title }>(...)`）。返回结构从 `{ content_id, name, created_at }` 改为 `{ content_id, created_at, outcome, title, content_text, content_url }`，`name` 字段整体去掉（前端不再需要）。

user-flow 分支（`user_id` 版本）保持字段不变，只加一个可选 `outcome` 透传（不强制要求，因为 user flow 前端本次不消费它）。

### 6. Poller — `content_url` 写入

- **`link/src/services/pollers/x-posts.ts` / `x-list-posts.ts`**：`upsertPage()` 里 `resolveProps()` 之后加一行 `props.content_url = `https://x.com/i/status/${props.source_content_id}`;`（与既有 `item.article` fixup 同样的写法/同样的位置）。
- **`link/src/services/pollers/youtube-content.ts`**：同理加 `props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;`。
- **`link/src/services/tiktok-content-api.ts`**：`VIDEO_FIELDS` 加 `"share_url"`。
- **`metadata/tiktok.ts`**：video.list 的 `contentProps` 加一条 `{ propId: "content_url", dataId: "{linkPrefix}.share_url" }`。
- **`metadata/props.ts`**：新增 `content_url` propId（`dataType: "TEXT"`, `entity: ["content"]`）。

不改 `content` 表 / `CONTENT_COLUMN_MAP`——`content_url` 只经过 `payload`，不落 D1。

### 7. 前端 — `flow/frontend/pages/AnalyticsPage.tsx`

- `nodeLogs` state 类型改为 `{ content_id: string; created_at: string; outcome?: string; title?: string; content_text?: string; content_url?: string }[]`（内容域）。
- 每行渲染拆成左右两栏：
  - 左：`title || (content_text ? content_text.slice(0, 5) + "…" : "")`，下方若有 `content_url` 则渲染为可点击链接。
  - 右：`new Date(created_at).toLocaleString()`；若 `outcome === "failed"`，下方红字 "Failed"。
- 抽屉标题的 `nodeName` 计算逻辑补上内容域分支：`xContentTrigger`/`youtubeContentTrigger` 用 `NODE_TYPE_REGISTRY[nodeType].label`；`action` 节点的 `actionType` 为 `xContentAction`/`tiktokContentAction`/`videoAction` 时同样查 registry 或对应 label，而不是落到裸的 `nodeType` 字符串。

## Out of Scope

- 修复 List Posts / YouTube 订阅触发不写 `content` 表行的问题（不影响本功能，见 Feasibility Findings）。
- User flow 抽屉的左右分栏改版（本次只加 `outcome` 字段打底，UI 不变）。
- 已有 290 vs 205 计数差异的根因（另一个未完成的调试线索，跟本功能无关）。
