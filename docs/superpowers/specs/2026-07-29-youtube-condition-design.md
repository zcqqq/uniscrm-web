# YouTube Condition Node — 设计

## 问题

Content flow 现在只能在内容**刚到达时**判定一次。业务上真正想表达的是"发布一天后再看看这条视频跑得怎么样，再决定做什么" —— 涨了多少播放、点赞够不够、标题被改没改。

现有节点都做不到这件事：`youtubeContentTrigger` 的条件在触发瞬间求值；`wait` 只负责推迟，不重新取数；`videoCondition` 判的是视频画面（人脸占比、朝向），不是平台侧的统计数据。因此新增一个 content-domain 的条件节点 `youtubeCondition`：**重新调一次 YouTube Data API，用最新数据求值并分支**。

## 事实基础（已核实）

- `youtubeContentTrigger` 的条件编辑器是 `ConditionsEditor` + `getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")`（`Inspector.tsx:441-447`），字段来自 metadata 的 `contentProps`。
- 后端条件求值是 `engine.ts` 的 `evaluateCondition(field, operator, value, payload)`，已被 xTrigger / xContentTrigger / youtubeContentTrigger / waitForEvent 共用。
- link 已有 `fetchVideoDetails(apiKey, videoId)`（`link/src/services/youtube-api.ts:19`），`part=snippet,contentDetails,statistics`，走 API key 而非用户 OAuth。
- `youtube-content.ts:33-51` 已经实现了完整的"取视频 → `resolveProps` → 解析 ISO8601 duration → props"映射，但它内联在 `ingestYouTubeVideo` 里，无法复用。
- `YOUTUBE_API_KEY` 只绑在 link（`link/src/types.ts:46`），flow 没有这个 secret。flow → link 的既有路径是 `/internal/youtube/*` + `X-Internal-Secret`（`index.ts:530-549` 的 `youtubeActionRequest`）。
- content flow 的 payload 里，视频 id 就是 `payload.source_content_id`（同上）。
- `flow-editor.ts:113` 的 `addNode` 拒绝第二个 `role: "trigger"` 节点 —— **每个 flow 至多一个 trigger**。
- `videoCondition` 已确立三分支范式（`true` / `false` / `failed`），`engine.ts` 的 `processTargetNode` / `resumeFromNode`、analytics 分支统计、generate-prompt 的 sourceHandle 说明都已按这个形状实现。
- node log 每行都带 `title` / `content_text` / `content_url` 并打时间戳（`index.ts:84-86`），trigger 那一行已经保存了原始快照。
- `validateFlowGraph` 在 `EditorPage.tsx:107` 保存时被调用，把返回的 id 塞进 `setErrorNodeIds` 标红。

## 判定的数据来源：重新取，不读快照

节点求值时**重新调一次 `videos.list`**，而不是读 trigger 时存下的 payload。

读快照的话，一天后的判定结果与 trigger 当场判定逐字相同，这个节点就没有存在意义 —— "涨到多少赞才做后续动作"正是这类流程的全部价值。

代价是判定字段被限制在 `videos.list` 能返回的范围内 —— 正好覆盖 trigger 现有的全部 `contentProps`，没有实际损失。视频被删或转为私密时 API 返回空 `items`，这种情况走 `failed` 分支，绝不猜 `true`/`false`。

配额上这是每次 1 unit 的读操作（写操作是 50 units），且不消耗用户的 OAuth 授权。

## 延迟不属于这个节点

节点本身没有 duration/unit 字段。"一天后"由用户拼 `Wait (1 day)` → `YouTube Condition` 表达。

`wait` 是 `domain: "both"`，在 content flow 里已经能用，落 `content_flow_pending`、由 cron 唤醒的整套机制是现成且在跑的。把延迟内建进来等于在 content 域再造一遍同样的机制，还把两件正交的事（等多久 / 判什么）焊死在一个节点里。

用户忘了拼 Wait 的后果是"触发后立刻复查一次"，浪费一次 API 调用但不产生错误结果。用 Inspector 里的一句提示解决，不做强制校验。

## 分支形状：true / false / failed

与 `videoCondition` 完全一致。`failed` 必须独立存在：视频被删、转私密、API 报错时把结果算成 `false` 是在撒谎 —— "没涨到 1000 赞"和"视频没了"是两件事，后者用户多半想走另一条处理路径。

## 调用与判定的分工

**link 只负责取数，flow 负责判定。**

link 新增 `POST /internal/youtube/video-stats`，输入 `{ videoId }`，输出 `{ ok: true, props }` 或 `{ ok: false, reason }`。它不认识 flow 的条件语义。

条件求值留在 flow，直接调 `engine.ts` 的 `evaluateCondition` —— trigger 的判定和这个节点的判定是**字面上同一个函数**，操作符语义不会分叉。若把 conditions 发给 link 判，link 就得复制一份求值器，正是要避免的重复。

执行是**同步**的：在 `executeContentActions` 里直接 fetch，拿到结果当场 `resumeFromNode`。不走 `videoCondition` 那套队列 —— `videos.list` 是一次几百毫秒的 HTTP 调用，不像人脸检测需要拉视频跑容器。

## 条件字段集：原样复用 trigger 的

同一句 `getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")`，`metadata/youtube.ts` 一行不改。

那批字段里绝大多数本就是可变的：view_count / like_count 自不必说，title、description、缩略图作者随时能改 —— "标题被改了吗"本身就是合法的状态检查。真正不变的只有 `content_type` / `source_content_id` / `source_created_at` 三个，留着无害，且与 trigger 字段列表逐字一致意味着用户不必记"哪些字段在这个节点里没有"。

**例外**：trigger 上那条锁着的系统限制 `duration <= 600`（`contentPropsFilter`）**不在这个节点显示** —— 那是 link 入队前的摄取门槛，与一天后的复查无关。

## 新鲜值写回 payload

取回的 props **合并覆盖** payload 中的同名 key，该节点之后的所有节点看到的都是最新值。

已有先例：`videoAction` 产出的 `processed_video_url` 就是"此节点之后，这条内容指的是新视频"（`index.ts:70-73` 的注释明确写了这个语义）。同理，用户显式放了一个"重新检查"节点，之后下游引用 `$content.view_count` 却拿到一天前的旧数字才是反直觉的 —— 若下游要发"这个视频已经 N 次播放"，用旧值就是发了个假数字。

不丢数据：trigger 那行 node log 已带时间戳记下原始 title / content_text / content_url，per-tenant D1 的 content 行也是原始值。

不另起名（如 `latest_view_count`）：同一个量两个名字会让用户在条件编辑器里选 `view_count`、在下游插值里写 `latest_view_count`，必然踩坑。

## 组件

### `flow/nodeTypeRegistry.ts`

```ts
youtubeCondition: {
  reactFlowType: "youtubeCondition",
  label: "YouTube Condition",
  description: "Re-check the trigger video's current stats",
  domain: "content",
  role: "condition",
  generatable: true,
  promptFragment: `youtubeCondition - re-fetches the trigger video's current stats from YouTube and branches on them, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }] }
   - Requires a youtubeContentTrigger in the same flow; put a wait node before it to check the video some time after publication.
   - Fields are the same content props the youtubeContentTrigger filters on (view_count, like_count, title, duration, ...), re-read live.
   - All conditions must pass (AND) for "true"; "failed" means the video is gone/private or the API errored — never guessed.`,
}
```

`CONTENT_FLOW_SIDEBAR_ORDER` 中插在 `videoCondition` 之后。

`data` 只有 `conditions` 一个字段 —— 不像 `videoCondition` 还有 `operation`/`operator`/`threshold`，因为条件数组本身承载全部语义。

### `link/src/services/pollers/youtube-content.ts`

把 `ingestYouTubeVideo` 内联的取数+映射抽成导出函数，行为逐字不变：

```ts
export async function fetchYouTubeVideoProps(
  apiKey: string,
  videoId: string
): Promise<Record<string, unknown> | null>
```

返回 `null` 表示 `items` 为空（视频不存在/私密）。内部依次做：`fetchVideoDetails` → `resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix)` → 补 `content_url` → 解析 `contentDetails.duration`（`parseISO8601Duration` 返回 null 时不写入 `props.duration`，绝不填假的 0）。

`ingestYouTubeVideo` 改为调它。这样"YouTube 字段怎么映射成 contentProps"全系统只有一份实现，metadata 改一次两处同时生效。

### `link/src/routes-internal.ts`

```
POST /internal/youtube/video-stats   body: { videoId }
```

- 缺 `videoId` → 400
- `fetchYouTubeVideoProps` 返回 null → `{ ok: false, reason: "video_unavailable: video not found or private" }`
- 抛异常 → `{ ok: false, reason: "youtube_api_error: <message>" }`
- 否则 → `{ ok: true, props }`

走 `X-Internal-Secret`（该 router 已挂中间件，无 secret 自动 403）。

### `flow/src/engine.ts`

`processTargetNode` 加一支，与 `videoCondition` 同形：产出 `{ type: "youtubeCondition", nodeId: targetNode.id, hasBranches: true }` 并 eager 记一条 `exit`（`enter` 由 `processTargetNode` 开头统一记，`engine.ts:372`）。

`resumeFromNode` 无需改动 —— `youtubeCondition` 不在 `DEFERRED_EXIT_TYPES` 里，走既有的 `outcome` 分支路径。

### `flow/src/youtube-condition.ts`（新）

把"发什么请求"和"拿到响应后走哪个分支"抽成两个**纯函数**，与 I/O 分离 —— `index.ts` 已经三千行，且现有测试（`dispatch-youtube-action.test.ts`）的做法就是测导出的纯 helper 而非整个 `executeContentActions`（后者要 env/D1）。

```ts
export interface VideoStatsResponse {
  ok: boolean;
  props?: Record<string, unknown>;
  reason?: string;
}

export function youtubeConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
}): { url: string; body: string };

export function resolveYouTubeCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: VideoStatsResponse
): { branch: "true" | "false" | "failed"; payload: Record<string, unknown>; failureReason?: string };
```

`resolveYouTubeCondition` 内部调 `engine.ts` 的 `evaluateCondition`（已 export，`engine.ts:124`），`field` 为空的条目跳过 —— 与 `executeFlow` 里 trigger 的 `allPass` 写法逐字一致。`resp.ok` 为 false 时返回原 payload 不合并。

### `flow/src/index.ts`

`executeContentActions` 加一支：

1. `const { url, body } = youtubeConditionRequest({ env, contentId, flowId, payload })`
2. `fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET }, body })`
3. fetch 抛错或响应体解析失败 → 合成 `{ ok: false, reason: "youtube_api_error: <status or message>" }`
4. `const { branch, payload: next, failureReason } = resolveYouTubeCondition(conditions, payload, resp)`
5. `resumeFromNode(graph, nodeId, next, branch, failureReason)`，随后的 node log、嵌套 action、`content_flow_pending` 落库一律用 `next`

节点的 `conditions` 从 graph 里取（`graph.nodes.find((n) => n.id === nodeId)?.data.conditions`），不放进 `ActionResult` —— 与 `videoCondition` 把 `operator`/`threshold` 留在 graph 里、只在 resume 时读的做法一致。

`scheduled` 里那段处理 `content_flow_pending` 超时的分支判定（`index.ts:2016-2024`）**不需要改** —— `youtubeCondition` 是同步的，从不为自己写 pending 行。

与 `youtubeContentAction` 一样打一行结构化日志（`event: "content_condition_youtube"`，含 contentId / videoId / branch / ok）。

不做重试、不处理限流 —— 取不到就 `failed`。

### 前端

- **`flow/frontend/nodes/YouTubeConditionNode.tsx`**（新）：照 `VideoConditionNode` 的骨架，YouTube 图标 + tooltip（图标必须带 tooltip 文字），副标题显示条件条数，三个 source handle：`true` / `false` / `failed`。
- **`frontend/nodes/index.ts`**：注册 `youtubeCondition`。
- **`frontend/components/Inspector.tsx`**：新面板 —— 标题取 `NODE_TYPE_REGISTRY.youtubeCondition.label`，`ConditionsEditor` 传 `fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")}`、`label="Content Props"`、**不传 `systemFilters`**；下方一行灰字提示 "Checks the video's current stats — put a Wait node before this to check it later."；并在 `node.type === "youtubeCondition"` 时挂载该面板。
- **`frontend/components/Sidebar.tsx`**：加一项，沿用 content 区的配色，emoji 图标 `📊`。
- **`frontend/store/flow-editor.ts`**：`addNode` 默认数据 `{ conditions: [] }`；`isValidConnection` 的 `validTargets` 与 `validSources` 各加 `"youtubeCondition"`。

### 校验：保存时，不在 Sidebar 拦

由于单 trigger 不变式，"前置必须有 YouTube Trigger"等价于"这个 flow 的唯一 trigger 是 `youtubeContentTrigger`" —— 不需要图遍历判断上游可达性。

`validate-flow-graph.ts` 的 `validateFlowGraph` 增加一条独立检查，返回值扩为：

```ts
{ valid: boolean; orphanNodeIds: string[]; misplacedNodeIds: string[] }
```

图中存在 `youtubeCondition` 但唯一 trigger 不是 `youtubeContentTrigger` 时，把这些 `youtubeCondition` 的 id 放进 `misplacedNodeIds`。`EditorPage.tsx:107` 把两个数组合并塞进 `setErrorNodeIds` 标红，并按类型给出不同的 toast 文案（现在只有孤儿节点一种）。

Sidebar 不做禁用/灰掉。

## 测试

- **`flow/tests/unit/engine.test.ts`**：`youtubeCondition` 被 collect 成 `{ type: "youtubeCondition", hasBranches: true }` 且 eager 记了 enter/exit；`resumeFromNode` 的 `true` / `false` / `failed` 三个分支各自走对边、走到对的下游节点。
- **`flow/tests/unit/youtube-condition.test.ts`**（新，测两个纯函数）：`youtubeConditionRequest` 的 url 与 body（videoId 取自 `payload.source_content_id`）；`resolveYouTubeCondition` 在 `ok: true` + 条件满足时 → `branch: "true"` 且返回的 payload 含新鲜值（旧 `view_count` 被覆盖）；条件不满足 → `"false"`；`conditions` 为空数组 → `"true"`；含空 `field` 的条目被跳过；`ok: false` → `"failed"`、`failureReason` 是 link 给的 reason、返回的 payload 与传入的**同一份内容**（未被污染）。
- **link `tests/routes-internal-youtube-video-stats.test.ts`**（新）：`items` 为空 → `ok: false, reason` 以 `video_unavailable` 开头；缺 `videoId` → 400；正常 → props 里 `view_count` / `duration` 已按 metadata 映射好（验证 duration 走了 ISO8601 解析）。（不重复测 403 —— `X-Internal-Secret` 中间件挂在 `link/src/index.ts:33`，路由测试直接挂载 `internalRoutes()`，鉴权由 `middleware.test.ts` 覆盖。）
- **link 现有 `youtube-content` / `webhook-youtube` 测试保持绿** —— 证明 `fetchYouTubeVideoProps` 的抽取没有行为变化。
- **`flow/tests/unit/validate-flow-graph.test.ts`**：X Trigger + youtubeCondition → `misplacedNodeIds` 含该节点；YouTube Trigger + youtubeCondition → 空；无 youtubeCondition 的图 → 空（不回归现有孤儿检查）。
- **`flow/tests/unit/node-type-registry.test.ts` / `generate-prompt.test.ts`**：按现有断言风格补 `youtubeCondition` 的 registry 条目与 prompt 片段。

## 不做

- 节点不自带延迟字段（用 `wait` 节点拼）。
- Sidebar 不做禁用/灰掉，只在保存时校验。
- 不新增 metadata 条目，不改 `metadata/youtube.ts`。
- 不显示 `duration <= 600` 系统限制。
- 不做重试、不处理限流 —— 取不到就 `failed`，绝不猜结果。
- 不给这个节点标价（YouTube Data API 是免费配额制，没有按调用计费；与 `metadata/youtube.ts` 现有两个 action 的注释一致）。
