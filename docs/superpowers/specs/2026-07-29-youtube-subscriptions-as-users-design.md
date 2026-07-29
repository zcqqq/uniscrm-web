# YouTube 订阅频道写入 user 实体 — 设计

**日期**：2026-07-29
**模块**：`link`（+ `metadata`、`flow` 前端零改动）

## 目标

把 YouTube 账号订阅的频道，写成 `user` 实体的行，语义对齐 X 的 follow user：

- 我订阅了某频道 → 该频道成为一条 `user` 行，`is_follow = 1`
- `subscribers`（订阅数）→ `followers_count`
- `videos`（视频数）→ `post_count`

这样 YouTube 订阅频道可以进 Users 列表、进 insight-segment 分群、进 flow 的 user 条件，和 X 的 follower 走同一套 UI 与查询路径。

## 现状

| 现状 | 位置 |
|---|---|
| YouTube 订阅只以快照存在于 `channels.config.subscriptions`（`{channelId, channelName, thumbnailUrl}[]`） | `services/youtube-account.ts` |
| 该快照只在 OAuth 连接时写一次 | `oauth.ts:635` |
| flow 的订阅选择器读这份快照 | `routes-channels.ts` `GET /youtube/subscriptions` |
| 从不写任何 `user` 行 | — |
| 写 user 的服务层硬编码 `UserMetadata_X` | `services/x-users.ts` |
| WebSub 订阅/续期由 flow 侧 `/internal/youtube-watches`（哪些 flow 引用了哪个频道）驱动，**不由 `config.subscriptions` 驱动** | `cron.ts:255-284` |

## 外部 API 事实（已核对官方文档）

- `subscriptions.list`（1 unit）：`part` 可选 `id / snippet / contentDetails / subscriberSnippet`。`snippet` 给 `resourceId.channelId`、`title`、`description`、`thumbnails`；`contentDetails` 给 `totalItemCount`（近似）、`newItemCount`、`activityType`。**任何 part 都不含被订阅频道的订阅数。**
- `channels.list`（1 unit，`id` 支持逗号分隔批量，每批 50）：`snippet` 给 `title / description / customUrl / thumbnails / publishedAt / country`；`statistics` 给 `viewCount / subscriberCount / hiddenSubscriberCount / videoCount`。
- `subscriberCount` 官方**四舍五入到 3 位有效数字**。

因此 `followers_count` 必须额外调 `channels.list`。一次全量刷新成本 = `ceil(订阅数/50) × 2` units。200 个订阅 ≈ 8 units。

## 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 写入时机 | 独立的 daily poller | 数字需要保持更新，一次性写死会过期 |
| poll 频率 | **每天一次** | `youtube-quota.ts` 的 10,000 units/天是**整个 Google Cloud 项目共享**的，不是每租户。每小时 = 192 units/天/账号，50 个账号吃光池子并饿死同池的 `videos.list`（content trigger）和写操作（50 units/次）。每天一次 = 8 units/天/账号，1000 个账号才到 8000 阈值。订阅数/粉丝数本来也不是分钟级数据 |
| follow 位 | `is_follow = 1`（我关注他们） | X 的 `own:get-followers` 是 `is_followed = 1`（他们关注我），方向相反 |
| 取消订阅 | `is_follow = 0`，**行保留** | 「重要的被关联数据用逻辑删除」。历史统计与「曾经订阅过」这个事实都保留；`is_follow` 恰好也能做 flow 条件。`subscriptions.list` 是全量走查（无增量游标），所以我们有能力 diff 出消失的频道——这是 X followers poller 做不到的（它靠 webhook 收 unfollow） |
| 服务层 | `XUsersService` → `UsersService`，metadata 作参数传入 | `persistUser`（probe→merge→upsert→RETURNING→entity_state 镜像→R2 副本）是这套代码里最难写对的一段，绝不复制第二份；类名叫 X 却在写 YouTube 用户会长期误导 |
| `viewCount` | **不提成列**，落 `raw_data` | 要加就得同时改 tenant D1 建表 SQL + 写存量租户迁移脚本 + 重建 R2 `user_stream` schema。本仓库在 R2 schema 重建上翻过车。以后真需要再提 |
| `config.subscriptions` | **删除**；选择器改为打开时实时拉取 | 轮询去喂一份快照没有意义。与 YouTube Condition 节点已定的「取实时 API 数据、不吃快照」同一原则。删掉后不留两份新鲜度不同的真相 |

## 架构

```
OAuth 连接 ──┐
             ├──► runYouTubeSubscriptionsPoller(env, accountChannelId)
每日 cron ───┘         │
                       ├─ subscriptions.list (全量分页)      → UC id 列表
                       ├─ channels.list (50/批)              → snippet + statistics
                       ├─ resolveProps(UserMetadata_YouTube) → props
                       ├─ UsersService.upsertUserFromMetadata → tenant D1 `user`
                       │                                       + entity_state 镜像
                       │                                       + R2 user 副本
                       └─ diff 消失的频道 → is_follow = 0

flow 编辑器打开选择器 ──► GET /api/channels/youtube/subscriptions
                            └─ 实时 subscriptions.list（不读任何快照）
```

## 组件

### 1. `metadata/youtube.ts` — 新增 `UserMetadata_YouTube`

```ts
export const UserMetadata_YouTube: UserMetadata[] = [
  {
    sourceUserType: "own:get-subscriptions",
    userProps: [
      { propId: "source_user_id",    dataId: "id" },                            // UC... 频道 ID
      { propId: "name",              dataId: "snippet.title" },
      { propId: "username",          dataId: "snippet.customUrl" },             // 形如 @mkbhd
      { propId: "description",       dataId: "snippet.description" },
      { propId: "profile_image_url", dataId: "snippet.thumbnails.default.url" },
      { propId: "followers_count",   dataId: "statistics.subscriberCount" },
      { propId: "post_count",        dataId: "statistics.videoCount" },
      { propId: "is_follow",         value: 1 },
    ],
  },
];
```

`metadata/index.ts` 增加导出。

- 无 `linkPrefix`：喂给 `resolveProps` 的是 `channels.list` 的单条 item，不是整个响应体。
- `hiddenSubscriberCount = true` 的频道，响应里 `subscriberCount` 字段缺席 → `resolveProps` 返回 undefined → `persistUser` 跳过该列 → 保持 **null 而不是 0**。不知道 ≠ 是零。
- `viewCount`、`hiddenSubscriberCount`、`publishedAt`、`country` 等未映射字段自动进 `raw_data`（`consumedPaths` 只剥离被消费的路径）。
- **无需任何数据库迁移**：这 7 个 propId 对应的列在 tenant D1 `user` 表和 R2 `user_stream` schema 里都已存在。

### 2. `link/src/services/x-users.ts` → `users.ts`

`XUsersService` → `UsersService`。

| 成员 | 处理 |
|---|---|
| `persistUser` / `buildUserRecord` / `mirrorFollowState` / `sendUserRecord` / `buildEventRecord` / `insertEvents` | 不动——本来就是平台中立的 |
| `USER_VALUE_COLUMNS` / `USER_FOLLOW_COLUMNS` / `MAPPED_USER_PROP_IDS` / `EVENT_VALUE_COLUMNS` | 不动 |
| `upsertUserFromMetadata(rawItem, resolvedProps, channelId, channelType)` | 新增第 5 个参数 `meta: UserMetadata`，用于算 `consumedPaths` 做 raw_data 剥离。参数**必填**，两个 X 调用点显式传 `UserMetadata_X[0]` |
| `upsertUser(user: XUserData, ...)` | 改名 `upsertXWebhookUser`，内部仍固定用 `X_USER_MAPPINGS`——它确实只服务 X webhook 的 payload 形状 |
| 模块级 `X_USER_META` / `X_USER_MAPPINGS` | 留在 `users.ts`，只给 `upsertXWebhookUser` 用 |

调用点更新：`webhook.ts`（4 处）、`services/pollers/x-followers.ts`（1 处）、`services/x-followers-api.ts` 的注释、以及测试文件里的类名引用。

### 3. `link/src/services/youtube-subscriptions-api.ts` — 新增

```ts
// channels.list 的一条 item，原样交给 resolveProps —— 结构不在这里收窄，
// 未映射字段要完整留给 raw_data。
export interface YouTubeChannelItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string } };
    [k: string]: unknown;
  };
  statistics?: {
    subscriberCount?: string;      // API 返回字符串
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// 全量分页；返回被订阅频道的 UC id 列表。complete=false 表示走查被中断（分页失败/撞 deadline）
export async function fetchSubscribedChannelIds(
  accessToken: string,
  deadline: number
): Promise<{ ids: string[]; complete: boolean; calls: number }>

// 一批最多 50 个；返回 channels.list 的原始 item
export async function fetchChannelDetails(
  accessToken: string,
  channelIds: string[]
): Promise<YouTubeChannelItem[]>
```

`subscriberCount` / `videoCount` 是字符串，D1 列是 INT——`persistUser` 绑定时 SQLite 会做数值转换，但测试需显式断言存入的是数值而非字符串。

现有 `youtube-api.ts` 的 `fetchAllSubscriptions`（返回 `{channelId, channelName, thumbnailUrl}`）保留——选择器路由继续用它，形状正是前端要的。

### 4. `link/src/services/pollers/youtube-subscriptions.ts` — 新增

```ts
export async function runYouTubeSubscriptionsPoller(ctx: YouTubeSubscriptionsPollerContext): Promise<void>
```

上下文：`accountChannelId`、`accessToken`、`linkDb`、`tenantDb`、`entityState`、`tenantId`、`pipelineUser?`、`env`（配额记账）、`deadline`。

流程：

1. `INSERT OR IGNORE INTO channel_poll_state (channel_id, poller_name) VALUES (?, 'subscriptions')`
   —— **自播种**。X 那边「没有 state 行 = 未授权」，但 YouTube 的授权凭证就在 `channels` 行里；自播种省掉一整类播种时序 bug，也省掉给存量频道补行的运维脚本。
2. `fetchSubscribedChannelIds(accessToken)` 全量分页。记 `completeWalk = true`；任一页失败或撞 deadline 则 `completeWalk = false` 并中止后续步骤。
3. 按 50 分批 `fetchChannelDetails`。每批后 `recordYouTubeQuota(env, 1)` 记账。任一批失败 → 记日志、跳过该批、`completeWalk = false`（该批频道本轮不更新，因此其缺席不能被解释成取消订阅）。
4. 每条：`resolveProps(item, YT_USER_META.userProps)` → `usersService.upsertUserFromMetadata(item, props, accountChannelId, "YOUTUBE", YT_USER_META)`。
5. **仅当 `completeWalk === true`** 才做 diff：
   ```sql
   SELECT source_user_id FROM user WHERE channel_id = ? AND is_follow = 1
   ```
   本次列表里没有的，调 `persistUser({ columnValues: {}, followValues: { is_follow: 0 }, forceSend: true })`
   —— 置 0 + 镜像 entity_state + 推一条 R2 副本（R2 无列级更新，不 forceSend 分析侧永远看不到这次变化）。
6. `UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now')`。

**半份列表绝不 diff**：被配额或 deadline 打断的走查会把仍在订阅的频道误置 `is_follow = 0`。数据准确性优先于「这次也把状态更新掉」。

`channel_type` 写 `"YOUTUBE"`——与账号行的 `YOUTUBE_ACCOUNT` 区分，和 X 的 user 行写 `"X"`（账号行是 `X`/`TWITTER`）同构。`user` 表主键是 `(channel_id, source_user_id)`，同一频道被同租户两个 YouTube 账号订阅会产生两行，与 X 一致。

### 5. `link/src/services/pollers/poll-channel.ts`

- `shouldPoll(env, channelId, pollerName, intervalMs = REPOLL_INTERVAL_MS)` —— 加第 4 个可选参数。X/TikTok 调用点不变。
- 新增 `pollYouTubeChannel(env, row)`：`shouldPoll(..., 'subscriptions', 23 * 60 * 60 * 1000)` → `resolveTenantDb`（null 则在任何外部 API 调用前跳过，与 X 同规则）→ `YouTubeTokenService.getValidToken` → `runYouTubeSubscriptionsPoller`。
- `pollChannelOnce` 增加 `YOUTUBE_ACCOUNT` 分支。

### 6. `link/src/services/youtube-quota.ts`

`recordYouTubeWriteQuota(env, units = 50)` → `recordYouTubeQuota(env, units)`：本 poller 记的是**读**配额（1 unit/次调用），沿用带 `Write` 的名字会误导。现有两个调用点显式传 `50`，默认值取消。阈值逻辑与 KV key 不变。

### 7. `link/src/cron.ts`

`handlePolling` 的 SELECT 从 `channel_type IN ('X','TIKTOK')` 扩到 `IN ('X','TIKTOK','YOUTUBE_ACCOUNT')`。`json_extract(config,'$.x_frozen_at') IS NULL` 对 YouTube 行恒真（从不带该 key），无副作用。

### 8. 删除 `config.subscriptions`

- **`services/youtube-account.ts`**：`syncYouTubeSubscriptions` 删除。
- **`oauth.ts:635`**：改为 `c.executionCtx.waitUntil(runYouTubeSubscriptionsPoller(...))` —— 连接时立刻跑一次，之后由 daily cron 接手。
  `config.sync_status` / `last_synced_at` 保留（描述的是「同步跑了没」，不是数据快照），写入用 `json_set` 只改这两个 key，**不整个重写 config**——`YouTubeTokenService` 刷 token 时会整体重写 config，读改写会互相覆盖（本仓库在 X 冻结标记上踩过这个坑）。
- **`routes-channels.ts` `GET /youtube/subscriptions`**：改为实时调 `fetchAllSubscriptions(accessToken)`，不读任何快照。**响应结构一字不改** → `flow/frontend/components/Inspector.tsx` 与 `flow/frontend/lib/api.ts` 零改动。
- **`routes-channels.ts` `GET /youtube/status`**：`subscription_count` 改为查 tenant D1
  `SELECT COUNT(*) AS c FROM user WHERE channel_id = ? AND is_follow = 1`（未 provision 则返 0）。
- **`link/frontend`**：`SocialChannels.tsx` / `useYouTubeAccount.ts` 的 syncing 状态机不变——`sync_status` 与 `subscription_count` 两个字段都还在，只是来源换了。

## 错误处理

| 情况 | 行为 |
|---|---|
| tenant D1 未 provision | 在任何 YouTube API 调用前跳过整个 poll（与 X 同规则：不为存不下的数据烧 token 与配额） |
| token 刷新失败 | 记 `youtube_subscriptions_poll_token_error`，跳过该账号，不影响其他账号 |
| `subscriptions.list` 中途失败 / 撞 deadline | `completeWalk = false`：已拉到的照常 upsert，**跳过 diff**，`last_polled_at` 仍更新（下一天重试） |
| `channels.list` 某一批失败 | 记日志，跳过该批（这批频道本轮不更新），`completeWalk` 置 false（本轮不 diff） |
| 配额超阈值 | 现有 `recordYouTubeQuota` 的 8000 阈值告警照常触发；poller 不自行熔断（每天 8 units/账号，不是配额压力源） |
| 选择器实时拉取失败 | 返回 `{connected: true, subscriptions: []}` + 错误日志；前端已有「No subscriptions found」空态 |

## 测试

`link/tests/services/pollers/youtube-subscriptions.test.ts`（新增）：

- 映射正确性：`statistics.subscriberCount → followers_count`、`statistics.videoCount → post_count`、`snippet.customUrl → username`、`snippet.title → name`
- `hiddenSubscriberCount = true`（`subscriberCount` 字段缺席）→ `followers_count` 不写入，**不是写 0**
- `viewCount` 未映射 → 出现在 `raw_data` 里
- 取消订阅：上一轮 `is_follow=1` 而本次列表中缺席 → 写 `is_follow=0`，行未删除，`forceSend` 使 R2 副本被推送
- **半份列表不 diff**：`subscriptions.list` 第二页失败时，缺席的频道**不**被置 0
- 50 个一批：120 个订阅 → 3 次 `channels.list`
- 自播种：无 `channel_poll_state` 行时创建并正常跑完

`link/tests/services/users.test.ts`（原 `x-users.test.ts`）：类名与 `upsertUserFromMetadata` 新参数，其余断言不变。

`link/tests/services/routes-channels-youtube.test.ts`：`GET /youtube/subscriptions` 实时拉取（不读 config）、`GET /youtube/status` 的 `subscription_count` 来自 tenant D1 COUNT。

`link/tests/services/poll-channel.test.ts`：`shouldPoll` 的 23h 间隔生效（22h 前跑过 → 跳过；24h 前跑过 → 跑）。

## 已知代价（非遗漏）

1. **`subscriberCount` 只有 3 位有效数字**——YouTube 官方行为。1,234,567 存进去是 1,230,000。做分群、排序、量级判断没问题；当精确数字用会错。
2. **取消订阅但仍被 flow 引用的频道，WebSub 续期不受影响**——续期由 flow 的引用驱动（`/internal/youtube-watches`），不由订阅列表驱动。即取消订阅后该 flow 仍会收到新视频。这是现有行为，本次不改动，但需知晓。
3. **选择器每次打开消耗 `ceil(订阅数/50)` units**——比每天一次的 poller 更频繁，但只在编辑 flow 时发生，量级可忽略。

## 不做

- 不加 `view_count` 到 user 实体（见决策表）
- 不改 WebSub 订阅/续期逻辑
- 不为 YouTube 加 follow/unfollow 类的 flow action
- 不动 X / TikTok 的任何 poller 行为
