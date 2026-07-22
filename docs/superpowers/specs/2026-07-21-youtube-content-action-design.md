# YouTube Content Action Node — Design Spec

**Date:** 2026-07-21
**Status:** Design approved (pending user spec review)
**Module(s):** `flow`, `link`, `metadata`

## Goal

给 content flow 增加一个 `youtubeContentAction` 节点，让 flow 在命中某个 YouTube 视频后，用触发该内容的 YouTube 账号对该视频执行**收藏类操作**。支持两个 operation：

- **Save to playlist** — 把视频加入用户自建的播放列表（`playlistItems.insert`）。
- **Like** — 给视频点赞（`videos.rate?rating=like`）。

## Feasibility Findings（决定设计边界，勿在实现中推翻）

- **YouTube 没有可写的 "favorite" / "bookmark"。** Favorites/Watch Later 是系统播放列表，`playlistItems.insert` 对系统列表返回 `playlistOperationUnsupported`（官方文档明确）。因此用户原始的 "add to favorite" 字面操作在 API 层不可实现，本设计以 **Save to playlist（用户自建列表）** 作为其真实等价物。
- **写操作用 OAuth token，不是 API key。** 触发器读取用 `env.YOUTUBE_API_KEY`（Data API key），但 `videos.rate` / `playlistItems.insert` 必须用 channel 的用户 OAuth access token。
- **写操作 scope 需求：** `https://www.googleapis.com/auth/youtube.force-ssl`（一个 scope 覆盖 rate + playlistItems.insert）。当前 OAuth 只申请 `youtube.readonly`。
- **写操作配额：** 每次 50 units（`videos.rate` 与 `playlistItems.insert` 各 50）。全平台共用单一 Google Cloud 项目的 10,000 units/天池子（`GOOGLE_CLIENT_ID` + `YOUTUBE_API_KEY` 均为系统单 App）。约等于全平台 200 次写/天。提高配额只能走 Google 的合规审核（慢、不保证），不作为上线前提。
- **存量迁移（已决策）：** 只往后加。存量 YouTube channel 既无写 scope 也无 refresh token；不做检测/提示 UI，其写操作直接走 failed 分支，直到用户重新连接。

## Sources

- YouTube Data API — PlaylistItems: insert — https://developers.google.com/youtube/v3/docs/playlistItems/insert
- YouTube Data API — Videos: rate — https://developers.google.com/youtube/v3/docs/videos/rate
- YouTube Data API — Quota and Compliance Audits — https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits

## Design Decisions（已与用户确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 支持的 operation | Save to playlist **和** Like，两个 |
| 2 | 配额防护 | **不做每租户限流**，改为全平台配额用量监控 + 阈值告警 |
| 3 | 存量 channel 迁移 | **只往后加**，老 channel 写操作失败到重连为止（无检测/提示 UI） |
| 4 | Save 目标列表 | **只允许选已有播放列表**（不提供"新建列表"） |
| 5 | acting channel 语义 | via triggering channel（运行时 `channelId` = 触发视频的 YouTube 账号），与 X content action 一致 |

## Architecture

沿用现有 `xContentAction` / `tiktokContentAction` 的分层：metadata 定义 → 节点在 flow 编辑器配置 → `flow` worker 的 `executeContentActions` 分发 → `link` worker 的 internal 端点调用 YouTube API。

```
[youtubeContentTrigger] --命中视频--> [youtubeContentAction]
                                          |
             flow/src/index.ts executeContentActions (type==="youtubeContentAction")
                                          |
              save-to-playlist ──> POST link /internal/youtube/playlist-insert
              rate-like        ──> POST link /internal/youtube/rate
                                          |
                        link: 加载 channel → 需要则刷新 OAuth token → 调 YouTube API
                                          |
                        2xx → success 分支 ; 4xx/5xx → failed 分支
                        401 → 刷新 token 重试一次
                        403 quotaExceeded → 按 rateLimited 处理，重试时间 = 下一个太平洋午夜
```

## Components

### 1. OAuth 扩权 + refresh token（`link/src/oauth.ts`）

- YouTube 授权 scope 列表加入 `https://www.googleapis.com/auth/youtube.force-ssl`（保留 `openid`/`email`/`youtube.readonly`）。
- 授权 URL 增加 `access_type=offline` 与 `prompt=consent`（Google 只有在 offline + consent 时才返回 refresh token）。当前已设 `prompt=select_account`，改为 `select_account consent` 或等价写法以同时保证账号选择与 refresh token 下发。
- 回调处理存储 `refresh_token` 到 channel `config`（沿用现有**明文**存储方式，与 X 系统 App / TikTok / 现有 YouTube token 一致，符合"少改动"；BYOK 加密不适用于系统单 App）。
- 存量 channel 无需迁移脚本：重连即获得新 scope + refresh token。

### 2. YouTube token 刷新 helper（`link/src/services/youtube-account.ts` 或新建 `youtube-token.ts`）

- `getValidYouTubeAccessToken(env, channel)`：若 `config.expires_at` 未过期直接返回 `access_token`；否则用 `config.refresh_token` 走 Google token endpoint（`https://oauth2.googleapis.com/token`，`grant_type=refresh_token`）换新，更新 `config.access_token` / `expires_at` 回写 D1，返回新 token。
- 无 `refresh_token`（存量 channel）→ 抛出可识别错误，internal 端点据此返回 failed（不重试）。
- 参照 `x-token.ts` 现有刷新模式，注意并发刷新（若 X 用了 D1 锁则比照，否则至少 last-write-wins 可接受）。

### 3. Metadata（`metadata/youtube.ts`）

在 `ContentMetadata_YouTube` 增加两条 `flowType: "action"`：

```
{
  sourceContentType: "save-to-playlist",
  flowType: "action",
  price: <display-only>,
  label: { en: "Save to Playlist", zh: "加入播放列表" },
  description: { en: "Adds the video to a playlist via the triggering channel",
                 zh: "通过触发该内容的账号把视频加入播放列表" },
  contentProps: [],
},
{
  sourceContentType: "rate-like",
  flowType: "action",
  price: <display-only>,
  label: { en: "Like", zh: "点赞" },
  description: { en: "Likes the video via the triggering channel",
                 zh: "通过触发该内容的账号给视频点赞" },
  contentProps: [],
}
```

price 仅展示、不扣 credit（与现有 content action 一致，content channel 始终 BYOK 豁免）。

### 4. 节点类型注册与前端（`flow/nodeTypeRegistry.ts`, `flow/frontend/`）

- `nodeTypeRegistry` 注册 `youtubeContentAction`：第三方 API action → success/failed 双分支（遵循 flow/CLAUDE.md 分支规则）。
- 新增节点组件 `YouTubeContentActionNode.tsx`（比照 `ActionNode` / xContentAction 节点），品牌图标用 shared `YouTubeIcon`。
- Sidebar 在 content domain 下可拖出该节点（比照 `youtubeContentTrigger` 的 `visible()` 逻辑）。
- Inspector 配置：
  - operation 选择器：Save to Playlist / Like。
  - operation === save-to-playlist 时显示**播放列表下拉**：调用新增 `api.channels.youtubePlaylists()` 拉取租户连接账号的自建播放列表，节点 `data` 存 `playlistId`（可附 `playlistTitle` 仅用于显示）。
  - operation === rate-like 无额外配置。

### 5. 播放列表列表 API（`link` channels 路由 + `flow/frontend/lib/api.ts`）

- 新增 `GET /api/channels/youtube/playlists`：服务端解析租户连接的 YouTube 账号（比照现有 `/api/channels/youtube/subscriptions`），用其 OAuth token 调 `playlists.list?part=snippet&mine=true`，返回 `{ playlists: { id, title }[] }`。
- 前端 `api.channels.youtubePlaylists()` 比照 `youtubeSubscriptions()`。
- 假设：租户单个 YouTube 账号（与现有 subscriptions 端点相同假设）。

### 6. 运行时分发（`flow/src/index.ts` `executeContentActions`）

- 增加 `else if (action.type === "youtubeContentAction")` 分支。
- `const videoId = String(payload?.source_content_id ?? "")`。
- operation === "save-to-playlist" → `POST ${env.LINK_URL}/internal/youtube/playlist-insert`，body `{ channelId, contentId, videoId, playlistId: action.playlistId, flowId }`。
- operation === "rate-like" → `POST ${env.LINK_URL}/internal/youtube/rate`，body `{ channelId, contentId, videoId, flowId }`。
- 复用现有 success/failed 分支解析、`resumeFromNode`、rateLimited 收集、pending 写入逻辑（与 xContentAction 的 bookmark/like/repost 路径同构）。
- header 带 `X-Internal-Secret`。

### 7. link internal 端点（`link/src/routes-internal.ts` + 新建 `link/src/services/youtube-actions.ts`）

- `POST /internal/youtube/rate`：加载 channel → `getValidYouTubeAccessToken` → `POST https://www.googleapis.com/youtube/v3/videos/rate?id={videoId}&rating=like`（Bearer token）→ 记配额 → 映射响应。
- `POST /internal/youtube/playlist-insert`：加载 channel → token → `POST https://www.googleapis.com/youtube/v3/playlistItems?part=snippet`，body `{ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }` → 记配额 → 映射响应。
- 响应映射：2xx → `{ ok: true }`；401 → 刷新 token 重试一次，仍失败 → `{ ok: false }`；403 且 reason `quotaExceeded` → `{ ok: false, rateLimited: true, rateLimitReset: <下一个太平洋午夜 ISO> }`；其它 4xx/5xx → `{ ok: false }`。
- 全量 API 返回 payload 不入库，仅日志（遵循项目约定）。

### 8. 配额监控告警（`link/src/services/youtube-actions.ts` + `link/src/cron.ts`）

- 每次写成功后，把 50 units 累加到按太平洋日期 key 的计数器（KV，key 形如 `yt_quota:{PT-date}`，TTL ~2 天）。
- 阈值告警：累加后若跨过 8000 units（10k 的 80%），发一次告警（复用现有邮件/日志告警通道），用 KV flag `yt_quota_alerted:{PT-date}` 去重，保证每天最多告警一次。
- **不做每租户硬限流**（用户决策）。

## Data Flow

1. `youtubeContentTrigger` 命中视频 → payload 含 `source_content_id`(videoId)、触发账号 `channelId`。
2. flow 收集到 `youtubeContentAction` → `executeContentActions` 按 operation 调对应 link internal 端点。
3. link 用触发账号 OAuth token 调 YouTube API，累加配额计数，映射 success/failed/rateLimited。
4. flow 据响应走 success/failed 分支或按 rateLimited 重排。

## Error Handling

| 情况 | 处理 |
|------|------|
| 存量 channel 无 refresh token / 无写 scope | 端点返回 failed（不重试）→ flow 走 failed 分支 |
| access token 过期 | 刷新后重试；刷新失败 → failed |
| 403 quotaExceeded | rateLimited，重试时间 = 下一个太平洋午夜 |
| 4xx（如视频不存在、无权限、系统列表） | failed，不重试 |
| 5xx / 超时 | failed（遵循 flow 第三方 API 规则；rate limit 重试耗尽才 failed） |

## Testing

- **单测（link/tests/）：** token 刷新逻辑（未过期直接返回 / 过期刷新 / 无 refresh_token 报错）；`/internal/youtube/rate` 与 `/internal/youtube/playlist-insert` 的响应映射（2xx/401 重试/403 quotaExceeded→rateLimited/4xx）；配额计数与阈值告警去重。
- **单测（flow/tests/）：** `executeContentActions` 的 `youtubeContentAction` 分支正确分发两个 operation、正确解析 success/failed。
- **浏览器自测：** flow 编辑器拖出 `youtubeContentAction`，Inspector 切换 operation、Save 下拉能列出播放列表、节点 configured 状态正确；dev 部署后验证节点渲染。
- **e2e（本地 wrangler）：** 用真实（重连后带写 scope 的）YouTube channel 触发一次 save + 一次 like，确认 API 200 且 YouTube 上生效。

## Out of Scope

- 提高 Google 配额（合规审核）作为并行运维任务，不在本实现内。
- 每租户限流（用户明确选择监控替代）。
- YouTube BYOK（每租户自带 Google Cloud 项目）。
- 多 YouTube 账号/租户的播放列表歧义（沿用现有单账号假设）。
- 「新建播放列表」操作。
