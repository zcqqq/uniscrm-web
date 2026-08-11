# GitHub Release Content Channel 设计

日期：2026-08-10
状态：已批准（用户逐项确认 D1–D7 后批准整体设计）

## 背景

新增一个 content channel：租户连接自己的 GitHub 账号，从**自己 Watch 的 repo** 中选一个
或多个，这些 repo 的 release 作为 content flow 的触发信号，release 正文进 flow payload 的
`content_text`。同时提供一个条件能力：判断该 repo **一段时间内的 release 数量**（发版活跃度）。

仓库里目前**没有任何 GitHub 集成**（全仓 grep 为空），这是一块全新 channel。

最接近的先例是 YouTube：

- `YOUTUBE_ACCOUNT`（OAuth 账号）+ `YOUTUBE`（每个被订阅频道一行，承载 WebSub 回调）
- `youtubeContentTrigger` 触发节点（多订阅选择）
- `youtubeCondition` 条件节点（判定当刻重新拉一次新鲜数据）
- `/internal/youtube-watches`：以 `graph_json` 为「要盯什么」的唯一真相来源

### 实测事实（不采信文档，全部本地验证过）

写这份设计时对 GitHub API 做了三组实测，结论直接影响设计，记录在此以免后人重走：

**1. `/repos/{owner}/{repo}/releases` 的响应结构**（`oven-sh/bun`，未认证）

字段：`url, assets_url, upload_url, html_url, id, author, node_id, tag_name,
target_commitish, name, draft, immutable, prerelease, created_at, updated_at,
published_at, assets, tarball_url, zipball_url, body, discussion_url, reactions`。
按 `created_at` 倒序，带 `Link` 分页头，带 `ETag`。

**响应里没有任何 repository 信息**——没有 `stargazers_count`，没有 repo description。
作者（repo）字段必须另打一次 `GET /repos/{owner}/{repo}`。这一条直接决定了 D4 的调用策略。

**2. 304 响应计入 rate limit**（与广泛流传的说法相反）

连打三轮「取 ETag → 带 `If-None-Match` 再打」，`x-ratelimit-used` 每轮 +2，
304 那次确实吃掉一个额度：

```
round1  status=200  used=11
round2  status=304  used=13   ← 取 etag(+1) + 条件请求(+1)
round3  status=304  used=15
```

所以 `If-None-Match` 只省带宽和 JSON 解析，**不省配额**，预算必须按
「每 repo 每轮 1 次调用」算。（未认证下测得，limit=60。认证态未复核，
但设计按「同样计入」这个更保守的假设做，即便实际不计入也只是更宽裕。）

另观察到 ETag 是弱验证器且可能在两次请求间变化（不同边缘节点），
所以 304 是优化不是保证，代码不能依赖它成立。

**3. Events API 不可用于发版检测**

`GET /repos/oven-sh/bun/events?per_page=100` 实测：

```
100 条事件跨度 12:57:50Z → 13:49:51Z —— 52 分钟
PushEvent 12 / PullRequestReviewComment 36 / PullRequestReview 33 /
PullRequest 5 / IssueComment 8 / Issues 5 / Create 1
（一条 ReleaseEvent 都没有）
```

Events API 总共只保留 300 条（3 页）。活跃 repo 一小时就把窗口冲干净，
`ReleaseEvent` 会被 PR 评论淹没。cron 每小时一轮已经踩在窗口边缘，一次部署中断即永久丢事件。
`/releases` 是完整历史，漏一轮下一轮补得回来。

**4. `/user/subscriptions` 的 scope**

文档页（`docs.github.com/en/rest/activity/watching`）**没有声明任何 scope 要求**。
按 GitHub 文档惯例这意味着不需要额外 scope（需要时会明写，如「requires the `repo` scope」），
私有 repo 才需要 `repo`。分页默认 `per_page=30`，最大 100。
**实现时用真 token 复核**，若实测需要 `repo` scope（授权页会显示私有仓库读权限，观感差），
回头重新权衡（见「待验证」一节）。

## 决策

### D1. 连接模型：单个 `GITHUB` 账号 channel，repo 选择长在 trigger 节点里

**不为每个 Watch 的 repo 建 channel 行。**

YouTube 之所以要为每个被订阅频道建一行，是因为 WebSub 订阅是每频道一个回调 URL，
必须有实体承载。GitHub 没有这个约束——**Watch 的 repo 拿不到 webhook**
（repo webhook 只有对该仓库有 admin 权限的人能装；GitHub App 也要 repo owner 安装；
GitHub 不存在面向订阅者的公开推送机制）。既然只能轮询，就没有「每 repo 一个实体」的技术必要性。

- `channels.channel_type` 新增 `"GITHUB"`，每租户一行
- repo 下拉框的数据实时调 `GET /user/subscriptions`，**不落库**
- `link/frontend/lib/channelRegistry.tsx` 的 `SIMPLE_CHANNELS` 加一条

（未来若要接**租户自己拥有的** repo，那条路可以装 webhook 走真推送，属于另一个 channel 形态，
不在本设计范围内。）

### D2. `flowType: "trigger"`——release 不落 D1 `content` 表

代码里现有的分界是「谁的内容」决定的，不是「哪个平台」：

| 来源 | flowType | 落库 |
|---|---|---|
| X `own:get-posts`（自己发的帖） | `content` | 是 |
| TikTok `video.list`（自己的视频） | `content` | 是 |
| X `get-list-posts`（别人的帖） | `trigger` | 否 |
| YouTube `watch:get-videos`（订阅频道的视频） | `trigger` | 否 |

自己的内容是 CRM 资产要留档；别人的内容只是触发信号。Watch 的 repo 是别人的内容 → `trigger`。

链路只走 `recordTriggerContentSeen`（去重）+ `emitContentTriggerEvent`（发 flow 事件），
**永不调用 `upsertContentFromMetadata`**——后者有硬防线，flowType 不是 `"content"` 直接抛错。

「release 内容作为 `content.content_text`」照样成立：`content_text` 是 flow payload 里的字段名
（metadata 映射产出），后续节点引用即可，与 YouTube 订阅视频的 `content_text` 拿到视频简介同理。

### D3. prerelease：默认不触发，节点上给开关；draft 与纯 tag 天然排除

- **draft**：只有有 push 权限的人可见，Watch 的 repo 拿不到。轮询器仍显式 `draft === true → 跳过`
  作为防线。
- **纯 tag（未建 release 对象）**：`/releases` 不返回，天然排除。
- **prerelease**：`githubContentTrigger` 节点上一个 `includePrerelease` 勾选框，**默认关**。
  理由：本 channel 的用途是拿发版当内容素材/趋势信号，nightly 类 repo 一天数个 rc 是噪音；
  但也有 repo 长期只发 prerelease，一刀切排除会让它永不触发，所以给开关而非硬编码。

**过滤发生在 flow 侧，不在轮询器。** 轮询器把所有非 draft 的 release 都发出去，
`is_prerelease` 作为字段跟着走；是否触发由 `TRIGGER_MATCHERS.githubContentTrigger`
按节点的勾选框决定。必须这样：同一个 repo 可能被两个勾选框状态不同的 flow 盯着，
轮询器按 repo 走，没资格替它们做决定。

### D4. 首次纳入只记不发；作者字段按需拉取

**seed 阶段**：某个 (channel, repo) 第一次被轮询时 `emitFlowEvent=false`——把每条 release 都记进
`recordTriggerContentSeen` 但一条都不发。这是 `link/src/services/pollers/x-list-posts.ts`
已经验证过的做法，其注释写明了原因：dedup 表是「见过」状态的唯一存放处，seed 时不记录，
第一次增量轮询就会把整个历史当新的灌进 flow。

**release 发布后被编辑**（补 release notes 很常见）：dedup 按 release `id`，不会二次触发。

**作者（repo）字段**：因为 `/releases` 响应不含 repo 信息（见「实测事实 1」），
需要另打 `GET /repos/{owner}/{repo}`。**只在这一轮真的发现了新 release 时才打**——
绝大多数轮次「没有新版」，那些轮次一次都不打。稳态成本 1 次/repo/小时，发版那一轮变成 2 次。
（同 `conditionsNeedAuthor` 的「不为大多数情况白烧配额」思路。）

### D5. 作者实体 = repo；star 数复用 `followers_count`

`ContentMetadata.userProps` 声明的字段会加 `USER_PROP_PREFIX`（`user.`）进 flow payload。

作者实体取 **repo 本身**，不取 repo owner（org 粒度太粗，同一 org 下 repo 冷热差得远，
条件没法写），也不取 release 的发布者（通常是 CI bot，无信息量）。

star 数**复用 `followers_count`**，不新增 `star_count`。理由：这个系统的价值在跨渠道归一——
同一个「够火才推」的判断，X / YouTube / GitHub 应该写同一个字段名。
YouTube 把 `subscriberCount` 映到 `followers_count` 是同一类归一。
代价是标签显示成「粉丝数」，看 GitHub 数据时略别扭，接受。

### D6. 发版计数：轮询器下发历史，flow 侧按节点配置算

窗口固定为 **1 天 / 7 天 / 30 天**三档（不做 90 天）。

计数口径**跟随节点的 `includePrerelease` 勾选框**。这带来一个实现约束：计数在轮询时算不出来——
轮询按 repo，勾选框在节点上，同一个 repo 被两个勾选框状态不同的 flow 盯着就要两套数。
所以计算必须挪到「已经知道勾选框是什么」的地方：

1. 轮询器在 payload 里下发 `release_history`——近 30 天每条 release 的
   `{ published_at, prerelease }`，只这两个字段，超过 100 条截断
2. flow 侧在 **trigger 命中之后、条件求值之前**，读节点的 `includePrerelease`，
   按该口径数出 `release_count_1d / _7d / _30d` 合进 payload
3. 随即删掉 `release_history`，条件编辑器里只看得见三个干净的数

体积无忧：30 天内的 release 绝大多数 repo 是个位数。

**已接受的副作用**：计数是「节点相对」的——同一条 release，勾了预发布的 flow 里
`release_count_30d` 可能是 12，没勾的 flow 里是 3。这是所选语义的必然结果，
排查日志时需要知道这一点。

**不做**独立的 `githubCondition` 节点。`youtubeCondition` 值得那个代价是因为它要判定当刻的
**新鲜播放量**（flow 里等 24 小时再看涨没涨）；发版频率不是这种量，trigger 当刻的数就是答案。
未来若确需可配窗口或「距上次发版多少天」，全在 flow 侧那个加工点里加，轮询器一行不动。

### D7. 认证：OAuth App

- **不用 PAT**：权限粒度粗（classic PAT 的 `repo` 是仓库全权限），要用户自己去 GitHub 生成再粘贴，
  且明文 token 保管责任落到我们这边——现有 `crypto.ts` 那套 BYOK 加密是为多租户自带凭据设计的，
  为一个平台级 channel 拉它进来不划算。
- **不用 GitHub App**：GitHub App 要装到 repo 上才能读，Watch 的是别人的 repo，装不上去。
- **用 OAuth App**：App 凭据平台共享（同 YouTube），非 BYOK。
  GitHub OAuth App 的 token **默认不过期**，省掉 X/YouTube 那一整套 refresh token 复杂度
  （`x-token.ts` 的 D1 锁、`youtube-token.ts`、freeze 处理全部不需要）。

配额结构也比 YouTube 好：OAuth user token 是**每个用户 5000/小时**，
不是 YouTube 那种全平台共享 10000 units/天。单租户盯 5000 个 repo 才会碰壁。

## 架构与数据流

```
flow: GET /internal/github-watches
      └─ 扫 status='published' 的 flow 的 graph_json，取出所有 githubContentTrigger 的
         (channelId, repoFullName) 对，去重
              ↓
link: 每小时 cron，逐 repo  GET /repos/{owner}/{repo}/releases?per_page=100
      带 If-None-Match（省带宽不省配额），304 → 跳过本 repo
              ↓
      对每条 release：
        draft === true            → 跳过
        recordTriggerContentSeen(channelId, repoFullName, String(release.id))
          isNew === false         → 跳过（含 release 发布后被编辑的情况）
          seed 阶段(emitFlowEvent=false) → 只记不发
          isNew && 增量           → 计入本轮「有新版」
              ↓
      本轮有新版 → GET /repos/{owner}/{repo} 取 repo 字段（否则不打）
              ↓
      emitContentTriggerEvent(channelId, "GITHUB", "repoId", repoId, payload)
      payload = 内容字段 + user.* (repo 字段) + release_history[]
              ↓
flow: TRIGGER_MATCHERS.githubContentTrigger 匹配
              ↓
      payload 加工点：按节点 includePrerelease 算三个计数，删 release_history
              ↓
      条件求值 / 后续节点
```

`graph_json` 是「要盯哪些 repo」的唯一真相来源——这是 `/internal/youtube-watches` 与
`/internal/list-watches` 已经用了两遍的模式：flow 里删掉节点，下一轮自然不再轮询，
不需要任何反向清理。

## 字段映射

新文件 `metadata/github.ts`，一条 `ContentMetadata`：

```
sourceContentType: "watch:get-releases"
flowType: "trigger"
label: { en: "Watched Repo Releases", zh: "关注仓库的发版" }
```

无 `linkPrefix`——轮询器逐条喂 release item。

### contentProps（`/releases` 的一条 item）

| propId | dataId / value | 备注 |
|---|---|---|
| `content_type` | value `"RELEASE"` | `props.ts` 的 `content_type` 枚举加一项 |
| `source_content_id` | `id` | release 数字 id，dedup 键 |
| `source_created_at` | `published_at` | |
| `title` | `name` | 为空时轮询器回退 `tag_name`（很多 repo 不填 name） |
| `content_text` | `body` | 截断见「错误处理」 |
| `content_url` | `html_url` | |
| `tag_name` | `tag_name` | 新 prop |
| `is_prerelease` | `prerelease` | 新 prop，布尔 → 0/1 由轮询器归一 |
| `release_count_1d` | （无） | 新 prop，flow 侧注入 |
| `release_count_7d` | （无） | 同上 |
| `release_count_30d` | （无） | 同上 |

后三个只声明、不给 `dataId`/`value`——`resolveProps` 会跳过这类条目，
声明的唯一目的是让条件编辑器的字段列表带上它们（`getContentTriggerFields`）。
这是 `metadata/youtube.ts` 里 `duration` 已经在用的做法。

### userProps（`GET /repos/{owner}/{repo}` 的响应）

`dataId` 相对 repo 对象本身，**不走 contentProps 的 linkPrefix**。

| propId | dataId | 备注 |
|---|---|---|
| `source_user_id` | `id` | repo 数字 id，改名不变 |
| `name` | `full_name` | `oven-sh/bun` |
| `username` | `name` | `bun` |
| `description` | `description` | |
| `profile_image_url` | `owner.avatar_url` | |
| `followers_count` | `stargazers_count` | 见 D5 |

### `metadata/props.ts` 的新增

全部**不带 `entity`**——它们只活在 flow payload 里，不是任何快照表上的列。
`dataTypes.ts` 的契约「entity = 表上的真实列」由
`analytics/tests/unit/{user,content}-stream-schema.test.ts` 机器对账，
标了 `entity` 不建列 CI 直接红。

| propId | dataType | label(en/zh) |
|---|---|---|
| `tag_name` | `TEXT` | Tag / 标签 |
| `is_prerelease` | `ENUM_INT`（0=正式版 / 1=预发布） | Is Prerelease / 是否预发布 |
| `release_count_1d` | `INT` | Releases (1d) / 24小时发版数 |
| `release_count_7d` | `INT` | Releases (7d) / 7天发版数 |
| `release_count_30d` | `INT` | Releases (30d) / 30天发版数 |

`content_type` 枚举追加 `{ value: "RELEASE", label: { en: "Release", zh: "发版" } }`。
追加枚举值不是加列，无 schema 影响。

`metadata/index.ts` 导出 `ContentMetadata_GitHub`。

## flow 模块改动

`youtubeContentTrigger` 这个节点类型在 flow 模块被 **28 个文件**引用（含测试），
新 trigger 节点是同一量级。改动点：

**后端**

- `src/node-executors.ts`：`TRIGGER_MATCHERS.githubContentTrigger`
- `src/node-executors.ts`：`TARGET_EXECUTORS.githubContentTrigger = triggerAsTargetNoop`
- **新增 payload 加工点**：trigger 命中后、条件求值前，只对 `githubContentTrigger` 生效，
  其它节点类型逐字不变。现在没有这个钩子（`TRIGGER_MATCHERS` 只返回布尔值），需新开一处
- `src/trigger-health.ts`：标签 `githubContentTrigger: "GitHub account"`
- `src/generate-prompt.ts`：让 AI 生成的 graph 认识这个节点
- `src/types.ts`：`ContentTriggerPayload` 加 envelope 字段 `repo_id`
- `src/index.ts`：`GET /internal/github-watches`、代理 `GET /api/channels/github/repos`

**前端**

- `nodeTypeRegistry.ts`：注册 + 共享的 repo 列表 resolver（前后端共用，
  沿用 `resolveYouTubeSubscriptions` 的形态；禁止前端 import `flow/src/*` 的既有约束不变）
- `frontend/nodes/GitHubContentTriggerNode.tsx` + `nodes/index.ts`
- `frontend/components/Inspector.tsx`：账号选择 + repo 多选 Popover + 「包含预发布」勾选框
- `frontend/components/Sidebar.tsx`：content domain 的节点面板加一项
- `frontend/config/trigger-fields.ts`
- `frontend/lib/validate-flow-graph.ts`：至少选 1 个 repo（对齐 YouTube 多订阅的
  「必须至少选 1 个」约束）
- `frontend/pages/{Flows,Editor,Analytics}Page.tsx`：图标与名称

### 匹配逻辑

```
eventType === "content.created"
  && node.data.channelId === payload.channel_id
  && 节点选中的 repo 里有 payload.repo_id
  && (node.data.includePrerelease === true || payload.is_prerelease !== 1)
```

`repo_id` 走 envelope 字段（与 `subscription_channel_id`、`list_id` 同一层），
不是 prop——它是路由信息，不是内容属性。

### flow domain 无需改动

flow 的 domain 现在是 `flows` 表上的存储列（migration 0014），
不再从 `graph_json` 嗅 `xContentTrigger` 字符串（`isContentDomainFlow`）。
`uniscrm-web/CONTEXT.md` 里「always inferred from whether a flow's node set contains an
xContentTrigger」那段描述已过时，本次顺手改正。

## link 模块改动

- `src/types.ts`：`ChannelType` 加 `"GITHUB"`
- `src/oauth.ts`：`/api/auth/github/connect` + `/callback`
- `src/services/github-api.ts`：`listWatchedRepos`、`listReleases`（带 ETag）、`getRepo`
- `src/services/pollers/github-releases.ts`：轮询器
- `src/services/pollers/poll-channel.ts`：接入
- `src/routes-channels.ts`：`GET /api/channels/github/repos`（供 Inspector 下拉框）
- `frontend/lib/channelRegistry.tsx`：`SIMPLE_CHANNELS` 加一条

ETag 与 seed 状态存放：复用 `channel_poll_state`。该表主键是
`(channel_id, poller_name)`，而 ETag / seed 标记都是**每 repo** 的，
所以 `poller_name` 取 `"github-releases:{owner}/{repo}"`——每个被盯的 repo 一行，
`backfill_complete` 兼作「seed 已完成」标记（0 = 本轮走 seed 路径只记不发），
ETag 存在既有的 cursor 列里。不新建表。

## 错误处理

| 情况 | 处理 |
|---|---|
| repo 404 / 403（删除、转私有、被封） | 跳过该 repo，记日志，不影响同轮其它 repo |
| token 401 | 标记 channel 需重连，停掉该租户本轮 |
| rate limit 403 / 429 | 本轮剩余 repo 直接跳过，下一小时再来。`/releases` 是完整历史，跳过一轮不丢数据 |
| `body` 过大 | `content_text` 截断到 32 KB（Cloudflare Queues 单条消息上限 128 KB），日志记原始长度 |
| `release_history` 过长 | 截断到 100 条（近 30 天） |
| `published_at` 为 null | 跳过该条（正常只在 draft 上出现，draft 已先被排除） |

外部 API 返回的全量 payload 只进日志，不入库（项目既有约定）。

## 测试

| 模块 | 用例 |
|---|---|
| `metadata` | 映射产出（含 `title` 回退 `tag_name`、`prerelease` → 0/1 归一）；新 prop 不带 `entity` |
| `link` | seed 阶段不发事件；dedup（同一 release 编辑后不二次触发）；draft 跳过；本轮无新版时不打 `GET /repos`；404 / rate-limit 不中断整轮；`content_text` 截断 |
| `flow` | matcher 四个条件各自的真假；`includePrerelease` 两种口径下三个计数的值；加工后 `release_history` 已删除；`/internal/github-watches` 去重；`validate-flow-graph` 要求至少 1 个 repo |

测试放各自模块的 `tests/` 目录。

## 待验证的三条，已在 dev 实测（2026-08-11）

1. **`/user/subscriptions` 的 scope —— 确认无需额外 scope。**
   OAuth 请求传空 scope，`GET /user` 返回的 `x-oauth-scopes` 头为空字符串，
   `/user/subscriptions` 返回 200。授权页上不出现私有仓库权限请求。D7 成立，不改。
   配额是 5000/hr **每用户**（不是 YouTube 那种全平台共享池）。

2. **认证态 304 是否计入 rate limit —— 未单独复测，保持保守假设。**
   预算按「计入」算的，实测若不计入只会更宽裕，不改设计。未认证态下已实测确认计入
   （见「实测事实 2」）。

3. **Watch 语义 —— `/user/subscriptions` 只认 "All Activity" 一档。已定性。**

   实测过程：同一个 repo（`anthropics/k12-teacher-skills`）、同一个 token、同一个端点，
   在用户最初选的那一档下**查不到**；改成 **All Activity** 后**立刻出现**。
   GitHub 的 REST subscription 模型是二元的（`subscribed` / `ignored`），
   Custom 那几档（Issues / Pull requests / **Releases** / Discussions / Security alerts）
   以及默认的 "Participating and @mentions" 都不在其中。

   **附带发现，值得单独记住**：`GET /repos/{owner}/{repo}/subscription` 在列表端点
   **已经包含该 repo 之后仍然返回 404** —— 两个端点对同一事实给出相反答案。
   任何时候都不要用单仓端点判断「用户有没有关注这个 repo」。

   **产品决策（用户 2026-08-11 拍板）：接受这个限制，选择器仍然只用 watched 列表。**
   即用户必须把 repo 设为 All Activity 才能在选择器里看到它。未做（可后续补）：
   在 Inspector 上加一句提示说明这一点——否则一个把 repo 设成「只看 Releases」的用户
   会发现选择器是空的，而界面不解释为什么。
   已评估但未采纳的替代方案：改用 starred 列表、watched ∪ starred、允许手填 `owner/repo`。

## 明确不做

- 独立的 `githubCondition` 节点（见 D6）
- 90 天窗口
- 新增 `star_count` prop（见 D5）
- release 落 D1 `content` 表（见 D2）
- Atom feed（`https://github.com/{owner}/{repo}/releases.atom`）作为抓取路径。
  它不吃 REST rate limit，是单租户盯几千个 repo 时的逃生口，但按 5000/小时/租户的预算
  现在不需要——多一条无认证抓取路径和一份 XML 解析代码，为尚未发生的规模问题买单
- 把 Watch 的 repo 同步成 `user` 表的行（YouTube 有 `syncYouTubeSubscriptionUsers` 的对应物）。
  本次不需要，repo 字段只随 release 事件进 flow payload
- 租户自有 repo 的 webhook 接入（另一个 channel 形态）
