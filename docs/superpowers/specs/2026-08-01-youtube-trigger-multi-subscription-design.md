# YouTube Trigger 多订阅（multi-subscription）设计

日期：2026-08-01
状态：已批准（用户确认「必须至少选 1 个」「Popover 多选下拉」两个决策后批准整体设计）

## 背景

content flow 的 YouTube Trigger（`youtubeContentTrigger`）目前只能选一个 subscription：
节点 data 存两个标量 `subscriptionChannelId` / `subscriptionChannelName`
（`Inspector.tsx` 单选下拉写入）。本设计将其改为多选。

现状的四个消费点：

1. **引擎匹配** `flow/src/engine.ts:259` —
   `n.data.subscriptionChannelId === payload.subscription_channel_id`
2. **watches 端点** `flow/src/index.ts:1224` `/internal/youtube-watches` —
   枚举已发布 flow 的 youtubeContentTrigger，产出去重后的
   `{channelId, subscriptionChannelId}` 对，link 的 poller/WebSub 按 pair 消费
3. **Inspector** `flow/frontend/components/Inspector.tsx:492` — 单选 `<Select>`
4. **节点卡片** `flow/frontend/nodes/YouTubeContentTriggerNode.tsx:11` — 显示单个名称

link 模块本来就按 (account, subscription) pair 轮询与 WebSub 订阅，多选只是
watches 列表变长，**link 零改动**。

## 决策

### D1. 数据模型：新数组字段 + 双读兼容，不迁移存量数据

节点 data 新增：

```ts
subscriptions: { channelId: string; channelName: string }[]
```

旧标量字段 `subscriptionChannelId` / `subscriptionChannelName` 不再写入新值，
但**所有读取方**按统一优先级取值，收敛为一个共享 resolver（放
`flow/nodeTypeRegistry.ts`，前后端都已 import 该文件，禁止前端 import
`flow/src/engine.ts` 的既有约束不变）：

```ts
export function resolveYouTubeSubscriptions(
  data: Record<string, unknown> | undefined | null
): { channelId: string; channelName: string }[]
```

取值规则：

- `data.subscriptions` **是数组** → 用它（含空数组——空数组表示"用户明确清空"，
  不回退旧字段）。逐元素过滤畸形值：非 object、或 `channelId` 为空串的条目丢弃；
  `channelName` 缺失降级为 `""`。
- 否则回退旧标量：`subscriptionChannelId` 非空 → 视作单元素数组
  `[{ channelId, channelName: subscriptionChannelName ?? "" }]`；为空 → `[]`。
- **任何畸形输入都不抛异常**（与 `conditionsPass` 同一原则：resolver 在队列
  handler 的执行路径上，抛出会导致整条消息重试、已执行的 action 重复执行）。

被否决的替代方案：

- 一次性脚本迁移 D1 存量 graph_json —— 触碰 prod 数据，违背「稳定、少改动」。
- 逗号分隔字符串复用旧字段 —— 丢失 channelName，且解析脆弱。

### D2. 引擎匹配：membership

`engine.ts` 的 youtubeContentTrigger 分支改为：

```ts
|| (n.type === "youtubeContentTrigger" && eventType === "content.created"
    && n.data.channelId === payload.channel_id
    && resolveYouTubeSubscriptions(n.data)
         .some((s) => s.channelId === payload.subscription_channel_id))
```

`channelId`（账号）匹配条件不变。

### D3. watches 端点：逐 pair 展开

`/internal/youtube-watches` 对每个 youtubeContentTrigger 节点调用 resolver，
每个返回元素产出一条 `{channelId, subscriptionChannelId}`，去重逻辑
（`Set` on `${channelId}:${subscriptionChannelId}`）不变。旧数据经 resolver
回退后行为与现状逐字节一致。

### D4. 发布校验：至少选 1 个（用户决策）

现状：单选空值 = 永不触发且发布不拦截。改为拦截。

`validate-flow-graph.ts` 新增：

```ts
export function findYouTubeTriggerNoSubscriptionIds(nodes): string[]
```

判定：`type === "youtubeContentTrigger"` 且 `resolveYouTubeSubscriptions(n.data)`
长度为 0。**必须用同一个 resolver**（前后端 parity 原则——否则出现「发布拦不住
但运行时不触发」或反之）。

`validateFlowGraph` 返回值与 `valid` 判定加入该列表；`EditorPage.tsx` 的
publish 前校验加第 5 类 toast，优先级排在 orLogicEmpty 之后、misplaced 兜底之前：

```
`${n} 个 YouTube Trigger 没有选择 subscription，无法发布`
```

红框高亮沿用 `setErrorNodeIds` 现有机制（并入去重数组）。

存量已发布 flow 不受影响：校验只在 publish 动作时运行，已发布的不重跑。
旧图里 subscription 已选的经 resolver 回退长度为 1，照常通过。

### D5. Inspector：Popover 多选下拉（用户决策）

- 新增通用组件 `shared/frontend/ui/multi-select.tsx`（popover + checkbox 组合，
  遵循「全部组件化、不写 inline CSS」）：
  - 触发按钮显示摘要：0 个 → placeholder（`Select subscriptions...`）；
    1 个 → 名称；N 个 → `首个名称 +N-1 more`。右侧 chevron。
  - Popover 内为固定最大高度、可滚动的 checkbox 列表，逐项可勾选/取消。
  - 按钮带 tooltip（「Select one or more subscriptions」），符合
    「所有 icons/控件加 tooltip」约定。
- `YouTubeContentTriggerInspector` 用它替换单选 `<Select>`；勾选变化时一次
  `updateNodeData` 同时写入：

```ts
updateNodeData(nodeId, {
  channelId: state.accountChannelId || "",
  subscriptions: next,            // 新数组
  subscriptionChannelId: "",      // 清空旧标量，避免两套字段并存歧义
  subscriptionChannelName: "",
});
```

- 初始勾选态来自 `resolveYouTubeSubscriptions(data)`（旧图打开即正确显示已选项）。
- 说明文案 `Fires when this subscription publishes a new video.` 改为
  `Fires when any selected subscription publishes a new video.`
- 订阅列表接口 `api.channels.youtubeSubscriptions()` 不变。

### D6. 节点卡片摘要

`flow/frontend/lib/subscription-summary.ts` 新增纯函数（模式同
`condition-logic.ts`，便于无 DOM 环境下测试）：

```ts
export function subscriptionSummary(
  subs: { channelId: string; channelName: string }[]
): string
// 0 → "(no subscription selected)"
// 1 → channelName（缺失名称降级为 channelId）
// N → `${first} +${N-1}`
```

`YouTubeContentTriggerNode.tsx` 改为
`subscriptionSummary(resolveYouTubeSubscriptions(data))`。

### D7. 默认 data 与 AI 生成

- `flow-editor.ts` addNode 默认：
  `{ channelId: "", subscriptions: [], conditions: [] }`（不再写旧标量）。
- `nodeTypeRegistry.ts` 的 `promptFragment` 同步改为
  `data: { channelId: "", subscriptions: [], conditions: [] }`，说明文字改为
  用户生成后在 Inspector 里多选。AI 若仍生成旧字段，resolver 兜住。

## 明确不做

- 「空 = 全部订阅」选项（用户已否决）。
- D1 存量 graph_json 迁移（双读覆盖，prod 数据零接触）。
- link 模块任何改动（poller/WebSub 按 pair 工作，天然支持）。
- 其他 trigger（xContentTrigger 的 List 等）的多选——本设计只动 YouTube Trigger。

## 测试

- resolver 单测：新数组 / 旧标量 / 两者并存（数组优先，含空数组不回退）/
  畸形值（非数组、元素为 null、channelId 空串、channelName 缺失）/ data 为
  undefined。
- 引擎：多订阅 membership 命中与不命中；旧标量图照常命中（回归）。
- watches 端点：多订阅展开为多条 pair、跨 flow 去重、旧数据回退（现有
  `youtube-watches.test.ts` 扩展）。
- 发布校验：0 订阅拦截、旧图单订阅通过、`validateFlowGraph` 返回结构既有
  strict `toEqual` fixture 补新键。
- `subscriptionSummary` 纯函数各分支。
- Inspector 交互逻辑中可提为纯函数的部分（勾选 toggle 的 next 数组计算）单测；
  UI 本体走浏览器自测（无 DOM 测试环境，不新装依赖）。

## 部署与验证

- 本地 vitest 全绿后 `npm run deploy:dev`，在 flow-dev.uni-scrm.com 真实登录态
  浏览器验证：多选交互、卡片摘要、publish 拦截 toast、旧 flow 打开显示正确。
- 无 D1 migration。
