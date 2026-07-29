# Content Flow 条件支持 User Props — 设计

**日期**：2026-07-29
**状态**：已确认，待实现

## 问题

Content flow 的条件今天只能判断**内容自身**的字段。`like_count`、`view_count`、`duration` 都是这条推文/这个视频的数值，判不了"这条内容相对它的作者算不算跑得好"。

要表达的典型条件是：

```
like_count  >  $user.followers_count * 0.01
```

—— 视频点赞数超过作者粉丝数的 1%。这在 user flow 里是天然可写的（条件字段列表是 `eventProps + userProps`），在 content flow 里写不出来，因为 payload 里根本没有"人"。

## 已核实的事实

以下每条都在代码里确认过，是本设计的地基。

1. **user flow 的 user props 是跟着事件一起来的**。`link/src/webhook.ts:71` 的 `flattenUserPayload` 把事件里的用户对象拍平进 payload，flow 侧 `executeFlow` 纯同步、只读 payload、不查任何库。字段列表来自同一条 `EventMetadata` 的 `eventProps + userProps`（`flow/frontend/config/trigger-fields.ts:72-73`）。

2. **content flow 的 payload 里没有"人"**。`ContentService.emitContentTriggerEvent`（`link/src/services/content.ts:601`）发出的是 `{ channel_type, ...contentProps }`；所有 `ContentMetadata` 的 `contentProps` 里没有任何作者字段；`ContentMetadata` 类型本身也没有 `userProps`。

3. **表达式引擎已经支持要写的式子**。`evaluateCondition` 的数值分支走 `resolveValue` → `evaluateExpr`（`flow/src/engine.ts:55-113`），支持 `+ - * / ( )` 与 `$field` 引用；Inspector 的值输入框是自由文本 + `$` 字段插入按钮（`flow/frontend/components/Inspector.tsx:56-77`）。**判定逻辑一行都不用改**，唯一缺的是作者字段没进 payload。

4. **X 侧作者数据可以零成本拿到**。`fetchListPostsPage`（`link/src/services/x-posts-api.ts:112`）今天只传 `tweet.fields`（其中已含 `author_id`）。X API v2 的 `expansions` 不额外计费、不额外消耗调用配额 —— 同一请求加 `expansions=author_id&user.fields=...`，作者的完整用户对象会出现在 `includes.users[]`。

5. **YouTube 侧作者数据要额外一次调用**。`videos.list` 的 `snippet` 白送 `channelId`/`channelTitle`，但订阅数在 `channels.list?part=snippet,statistics` 里，1 unit/次。`link/src/services/youtube-api.ts` 目前**没有** `channels.list` 的 helper。

6. **payload 是扁平的单一 key 空间，`$user.` / `$event.` 前缀是装饰性的**。`engine.ts:55` 与 `:117` 的正则 `/\$(?:event\.|user\.)?(\w+)/g` 把前缀**剥掉**后按裸名查 payload。`SelectPropsValue`（`shared/frontend/components/SelectPropsValue.tsx:78-80,87`）已有 `event`/`user`/`content` 三个分组，插入时按分组加前缀 —— 但那个前缀今天不改变解析结果。

7. **撞名是必然的，不是理论风险**：

   | | 撞名 propId | 内容侧含义 | 作者侧含义 |
   |---|---|---|---|
   | X（`get-list-posts` × `UserMetadata_X`） | `like_count` | 这条推文被点赞数 | 作者一共点过多少赞 |
   | YouTube（`watch:get-videos` × `channels.list`） | `view_count` | 这个视频的播放量 | 频道历史总播放量 |

   撞的这两个恰好都是目标式子的**左边**。

8. **`content_flow_log` 只从 payload 取三个固定键**（`flow/src/index.ts:85-87`：`title`/`content_text`/`content_url`），payload 不展开成列 —— 带点号的 payload 键不会污染 R2 schema。

9. **`evaluateExpr` 的分词器把 `.` 当小数点**（`engine.ts:75`），但它只在正则替换**之后**运行，那时字段名已经变成数字，点号进不去。

10. **不受影响的**：`videoCondition` 是固定操作节点（无字段选择器）；TikTok 没有 content trigger（`metadata/tiktok.ts` 只有 `content`/`action`）；`flow/src/generate-prompt.ts` 不枚举条件字段；`xContentTrigger` 的字段列表本来就按 mode 取（`Inspector.tsx:363`）。

## 决策

### D1 — user 指的是内容的**作者**

X 推文的发帖人、YouTube 视频的频道。这是与 user flow 语义上真正对应的那个"人"。

### D2 — 作者数据"跟着内容一起来"，不回查我们自己的库

X 走 `expansions`（零额外成本），YouTube 走 `channels.list`（1 unit）。**不查 `user` 表**：`user` 表只装粉丝和互动过的人，而 X 列表里的作者大多是你关注的创作者、不是你的粉丝，回查会大面积落空；且是上次抓取的快照。

**代价（知情接受）**：`is_follow` / `is_followed` 这两个"我方视角"字段拿不到 —— 它们只存在于 `entity_state` 和 `user` 表里，X/YouTube 的 API 不会告诉你"你有没有关注他"。「只对我已关注的作者动作」这个场景本次不做。

### D3 — YouTube trigger 与 condition 两边都支持作者字段

Trigger 摄取时对每条视频固定多打一次 `channels.list`。**代价（知情接受）**：`YOUTUBE_API_KEY` 是全平台共享的 10000 units/天免费配额，YouTube 摄取的日处理量因此减半，配额耗尽的日子会更早到来 —— 而配额耗尽时该节点走 `failed` 且不重试（沿用 `2026-07-29-youtube-condition-design.md` 的既定裁决）。

### D4 — YouTube Condition 节点**按需**打 `channels.list`

派发前扫描该节点的 conditions，只有真的引用了作者字段才追加第二次请求：

```
c.field.startsWith("user.")  ||  /\$user\./.test(String(c.value))
```

没引用时仍是 1 unit。Condition 节点的调用量随 flow 数量线性增长，而配额是全平台共享的死线，这一行判断买到的是一半。

（Trigger 侧做不到按需：link 在摄取时不知道任何 flow 配了什么条件，它只管往队列里扔 `content.created`。）

### D5 — 用 `user.` 做**真正的命名空间**，撞名从根上消失

payload 里作者字段的键是 `user.<propId>`，内容字段保持裸 `<propId>`。于是：

- 条件字段侧：`cond.field = "user.followers_count"` → `evaluateCondition` 的 `payload[field]` 直接命中，**零改动**。
- 条件值侧：`$user.followers_count` **严格**解析 `payload["user.followers_count"]`。
- 目标式子写作 `like_count > $user.followers_count * 0.01`，左右两边指向明确。
- UI 上分属 CONTENT PROPS / USER PROPS 两个分组，`SelectPropsValue` 现成支持。

被否掉的两个替代方案：

- **不声明撞名的 prop**（X 不声明 `like_count`、YouTube 不声明 `view_count`）—— 白白丢字段，且要长期维护一条"userProps 与 contentProps 的 propId 不得相交"的断言。
- **payload 改成嵌套 `{ ...content, user: {...} }`** —— 要改三处解析、所有 payload 构造点、user flow 一起改，且存量已发布 flow 的条件写的都是裸名，等于长期维护两套解析规则。与「以稳定、安全、少改动为主」冲突。

### D6 — `user.` 严格解析，**不做 fallback**；user flow payload 双写

这是 D5 的必要配套，不是可选优化。

若值侧采用"完整名 miss 就降级查裸名"的 fallback，会出现**静默取错值**：

> content flow 里作者数据抓取失败（见 D7，照发、不带 `user.*`）→ 条件写的是 `$user.view_count` → 完整名 miss → 降级命中裸 `view_count` → **取到了这个视频自己的播放量**，条件照常求值并给出一个看似合理的答案。

`view_count` 正是要声明的作者字段之一，配额耗尽又是设计里预期会发生的事 —— 这不是理论风险。

因此：`user.` 前缀**严格**解析，永不降级。存量兼容改为让 `flattenUserPayload`（user flow payload 的**唯一**产出口，`link/src/webhook.ts:71`，三个调用点 `:243`/`:269`/`:320` 都走它）**同时写裸键和 `user.` 键**：

| 场景 | 解析 | 结果 |
|---|---|---|
| 存量 user flow，条件字段裸 `followers_count` | 裸键仍在 | 不变 |
| 存量 user flow，值里 `$user.followers_count` | 命中新写的 `user.` 键 | 不变 |
| content flow，`$user.view_count`，作者数据正常 | 命中 `user.view_count` | 正确 |
| content flow，`$user.view_count`，作者抓取失败 | 严格 miss → null | **fail-closed** |

`$event.` 前缀**继续剥离** —— 它没有任何带点号的对应键，剥了无害且保存量兼容。只有 `user.` 变严格。

### D7 — 作者数据取不到时：照发内容，不带 `user.*`

- **X**：`includes.users[]` 里匹配不到该 author（作者被封/受保护）。
- **YouTube trigger**：`channels.list` 失败或返回空。记一条 `youtube_author_fetch_failed` 日志。

两种情况都**照常发 `content.created`**，只是 payload 里没有 `user.*` 键。引用作者字段的条件按现有 fail-closed 语义（`engine.ts:131` 对 `undefined` 返回 false）不通过；没配作者条件的 flow 完全不受影响。

**不选"整条跳过"**：`recordTriggerContentSeen` 已经把这条记成"见过"，而 WebSub 只推一次 —— 跳过等于这个视频永久丢失，配额恢复也不会补。

**已知的可观测性缺口（知情接受）**：trigger 的条件不通过时 `executeFlow` 只记 `enter`、不记 `exit`，trigger 也没有 failed 分支。所以「配额耗尽导致作者数据拿不到」与「作者粉丝数确实不够」在 UI 上长得一样。为它新增一整套 trigger 级失败日志形态与「少改动」冲突，不做；配额耗尽是全局事件，link 的 console log 足以定位。

### D8 — YouTube Condition 失败语义

与既有的 `videos.list` 出口完全对称，绝不猜 `true`/`false`：

| 情况 | 分支 | reason |
|---|---|---|
| `channels.list` 配额耗尽（HTTP 403） | `failed` | `youtube_quota_exceeded: channels.list HTTP 403` |
| `channels.list` 其它 HTTP 错误 | `failed` | `youtube_api_error: channels.list HTTP <code>` |
| `channels.list` 返回空（频道已删/已封） | `failed` | `channel_unavailable` |

reason 一律有界 —— 它会一路写进 `content_flow_log` 这张分析表，外部返回体长度不可控（「调用外部 API 返回的 payload 全量数据不要存在数据库中，存在日志中即可」）。全量错误体只进 console.log。

现有的 `boundedVideoStatsReason`（`link/src/routes-internal.ts:116`）正则写死了 `videos.list`，泛化为按端点名提取。

### D9 — 字段集

`ContentMetadata` 新增可选 `userProps: PropMapping[]`。**它的 dataId 相对于「作者对象」本身，不走 `contentProps` 的 `linkPrefix`** —— 作者对象来自另一个响应：X 要按 `item.author_id` 从 `includes.users[]` 数组里匹配（不是一条路径能表达的），YouTube 干脆来自另一次 API 调用。由调用方负责先取出作者对象，再交给 `resolveProps`。

只有两条 metadata 声明 `userProps`：

**`ContentMetadata_X` 的 `get-list-posts`**

| propId | dataId |
|---|---|
| `source_user_id` | `id` |
| `name` | `name` |
| `username` | `username` |
| `description` | `description` |
| `profile_image_url` | `profile_image_url` |
| `verified_type` | `verified_type` |
| `followers_count` | `public_metrics.followers_count` |
| `following_count` | `public_metrics.following_count` |
| `post_count` | `public_metrics.tweet_count` |
| `listed_count` | `public_metrics.listed_count` |
| `like_count` | `public_metrics.like_count` |
| `media_count` | `public_metrics.media_count` |

**砍掉 `is_followed`**：`UserMetadata_X` 里它是 `{ propId: "is_followed", value: 1 }` —— 一个写死的字面量，因为那份 metadata 是给「拉自己的粉丝列表」用的。照抄会让每个列表作者恒等于"我的粉丝"，静默且恒真。

对应的请求参数（`fetchListPostsPage` 新增）：

```
expansions=author_id
user.fields=id,name,username,description,profile_image_url,verified_type,public_metrics
```

**`ContentMetadata_YouTube` 的 `watch:get-videos`**（来自 `channels.list?part=snippet,statistics`）

| propId | dataId |
|---|---|
| `source_user_id` | `id` |
| `name` | `snippet.title` |
| `username` | `snippet.customUrl` |
| `description` | `snippet.description` |
| `profile_image_url` | `snippet.thumbnails.default.url` |
| `followers_count` | `statistics.subscriberCount` |
| `post_count` | `statistics.videoCount` |
| `view_count` | `statistics.viewCount` |

`user.view_count`（频道历史总播放量）在 D5 下与内容侧的 `view_count` 不再冲突，且同一次请求白送，故声明。UI 上会出现两个都叫 "Views" 的选项，靠分组标题区分 —— X 侧的两个 "Likes" 同理，且那个是目标场景的核心字段，躲不掉。

## 组件与改动

### metadata/

- `dataTypes.ts`：`ContentMetadata` 增加可选 `userProps?: PropMapping[]`，注释说明其 dataId 相对作者对象、不走 `linkPrefix`。
- `x-byok.ts`：`get-list-posts` 增加 `userProps`（D9 表一）。
- `youtube.ts`：`watch:get-videos` 增加 `userProps`（D9 表二）。

### link/

- `services/pollers/resolve-props.ts`：新增 `resolveAuthorProps(author, userProps)` —— 调 `resolveProps` 后把每个键统一加 `user.` 前缀。**前缀只在这一处施加**，metadata 里的 propId 保持干净（这不违反「propId ≠ field name」那条教训：那条说的是"用字符串猜某个 propId 对应哪个字段"，这里是在单一位置施加的命名空间规则）。
- `services/x-posts-api.ts`：`fetchListPostsPage` 加 `expansions=author_id` 与 `user.fields=<按 D9 表一>`；返回值带上 `includes.users`。**不动** `fetchPostsPage`（`own:get-posts` 的作者恒为自己）。
- `services/pollers/x-list-posts.ts`：按 `item.author_id` 从 `includes.users[]` 匹配作者，`resolveAuthorProps` 后并入发给 flow 的 props。匹配不到 → 不带 `user.*`。
- `services/youtube-api.ts`：新增 `fetchChannelDetails(apiKey, channelId)`，`part=snippet,statistics`，抛错格式与 `fetchVideoDetails` 一致（`YouTube channels.list failed: <status> <body>`）。
- `services/pollers/youtube-content.ts`：`ingestYouTubeVideo` 里按 `snippet.channelId` 取作者对象并并入 props；失败/为空 → 记 `youtube_author_fetch_failed`，照常发。
- `routes-internal.ts`：`POST /youtube/video-stats` 接受可选的 `withAuthor: boolean`；为 true 时追加 `channels.list` 并把作者 props 并进返回的 `props`。`boundedVideoStatsReason` 泛化为按端点名提取。

### flow/

- `src/engine.ts`：`resolveValue`（`:55`）与 `resolveStringValue`（`:117`）的正则改为捕获完整引用；`user.` 严格解析、`event.` 仍剥离。两处的解析规则统一为：

  ```
  正则：  /\$((?:event\.|user\.)?\w+)/g
  查键：  ref.startsWith("event.") ? payload[ref.slice(6)] : payload[ref]
  ```

  即 `$event.x` → 查 `x`（保存量兼容）；`$user.x` → 查 `user.x`（严格）；`$x` → 查 `x`。
- `src/youtube-condition.ts`：请求体带上 `withAuthor`（由条件扫描决定，见 D4）；`stat_unavailable` 守卫（`:62-74`）针对**合并后的**新鲜 props 判断 —— `videos.list` 与 `channels.list` 两次结果必须先合成同一份，否则每个 `user.*` 条件都会被误判成 `stat_unavailable` 而走 `failed`。
- `frontend/config/trigger-fields.ts`：`getContentTriggerFields` 把 `userProps` 以 `id: "user.<propId>"`、`group: "user"` 追加。没声明 `userProps` 的源行为逐字节不变。

### shared/

- `frontend/components/SelectPropsValue.tsx:87`：插入前缀改为直接用已限定的 id，避免拼出 `$user.user.followers_count`。

### 不改

user flow 的字段列表、`videoCondition`、TikTok、`generate-prompt.ts`、`own:get-posts`、`fetchPostsPage`、`getChannelTypes`。

## 数据流

**X List Posts trigger**

```
fetchListPostsPage (expansions=author_id)
  → { data: [tweet], includes: { users: [author] } }
  → resolveProps(tweet, contentProps)            → { like_count, view_count, ... }
  → resolveAuthorProps(matchAuthor, userProps)   → { "user.followers_count", ... }
  → emitContentTriggerEvent(合并)                 → FLOW_QUEUE
  → executeFlow → evaluateCondition(payload)
```

**YouTube trigger**

```
WebSub → videos.list → contentProps（含 snippet.channelId）
       → channels.list(channelId) → resolveAuthorProps → user.*
       → emitContentTriggerEvent(合并) → FLOW_QUEUE
```

**YouTube Condition（1天后）**

```
条件扫描 → 是否引用 user.* ？
  → POST /internal/youtube/video-stats { videoId, withAuthor }
  → videos.list [+ channels.list]
  → 合并成一份"新鲜 props" → stat_unavailable 守卫 → evaluateCondition
  → true / false / failed
```

## 错误处理

| 位置 | 情况 | 行为 |
|---|---|---|
| X poller | `includes.users[]` 无匹配 | 照发，不带 `user.*` |
| YouTube ingest | `channels.list` 失败/空 | 记 `youtube_author_fetch_failed`，照发，不带 `user.*` |
| flow 求值 | `user.*` 键缺失 | `evaluateCondition` 返回 false（fail-closed），**绝不降级到裸键** |
| YouTube Condition | `channels.list` 失败/空 | `failed` 分支 + 有界 reason（D8） |

## 测试

**存量兼容（回归，最重要）**
- user flow 条件字段写裸 `followers_count` → 行为不变。
- user flow 值里写 `$user.followers_count` → 命中双写的 `user.` 键，行为不变。
- user flow 值里写 `$event.followers_count` → 前缀仍被剥离，行为不变。
- 没声明 `userProps` 的 content 源（`own:get-posts`、YouTube 之外）字段列表逐项不变。

**撞名**
- content flow payload 同时含 `like_count` 与 `user.like_count` 时，`like_count > 100` 取内容值、`$user.like_count` 取作者值。
- `view_count` / `user.view_count` 同上。

**fail-closed（D6 的坑）**
- content flow payload **不含** `user.*` 时，`$user.view_count` **不得**降级命中裸 `view_count`；条件必须为 false。

**按需（D4）**
- YouTube Condition 的条件不引用作者字段时，`channels.list` **不被调用**。
- 引用 `c.field = "user.followers_count"` 时调用；只在 `c.value` 里写 `$user.x` 时也要调用。

**端到端表达式**
- `like_count > $user.followers_count * 0.01`：粉丝 10000、点赞 150 → true；点赞 50 → false。

**link 侧**
- X：`includes.users[]` 匹配命中 / 匹配不到（不带 `user.*`）。
- YouTube：`channels.list` 成功 / HTTP 403 / 返回空。
- `boundedYouTubeReason` 对 `videos.list` 与 `channels.list` 各自产出正确的有界字符串；5000 字符错误体不得进入 reason。

**自测**：部署 link-dev + flow-dev（`npm run deploy:dev`），在浏览器真实会话里建一条 X List Posts trigger 的 content flow，确认字段下拉出现 USER PROPS 分组、写出目标式子、保存并发布。

## 不做

- `is_follow` / `is_followed`（需回查我们自己的库，另立项）。
- X `own:get-posts`、TikTok 的作者字段。
- user flow 的字段列表改动。
- trigger 级的失败日志形态（D7 的可观测性缺口）。
- payload 嵌套命名空间（D5 里被否掉的方案）。
