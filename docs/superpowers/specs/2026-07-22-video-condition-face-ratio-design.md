# Video Condition: Face Ratio 设计

## 背景

`videoCondition` 节点的 `check-face` operation 目前对**内容封面图**调用 Workers AI
moondream，同步返回 `has-face` / `no-face` / `failed`。

问题：封面图只是一帧，代表不了整个视频；而且结果是布尔值，用户无法调节松紧。

改为：对**整个视频**均匀抽 20 帧，用 YuNet 逐帧检测，返回**有人脸的帧占比**（0~1）。
节点上预置比较符下拉和阈值输入框（默认 `<= 0.2`），分支变成 `true` / `false` / `failed`。

## 关键后果：这个节点从同步变成异步

抽帧必须下载整个视频并跑 ffmpeg，只能在 container 里做。因此该节点不再当场出分支，
而是复用 `videoAction` 已有的异步链路：

```
flow 派发 → content_flow_pending (awaiting_event: video_action_complete)
         → VIDEO_ACTION_QUEUE
         → content 队列消费者 → container /face-ratio
         → POST flow /internal/video-action/resume (带 face_ratio)
         → flow 读 node.data 的 operator/threshold 判 true/false
```

15 分钟兜底扫描仍是回调丢失时的保险。

## 锁定的决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 复用 videoAction 的 queue + container + resume 链路 | 不新增 Cloudflare 资源 |
| 2 | 阈值判定在 **flow 的 resume 路由**，container 只返回原始比例 | 阈值是流程配置，单一真相在 graph；content 模块不需要知道"阈值"这回事 |
| 3 | 检测器 YuNet，`score_threshold` 0.9 → **0.6** | 0.9 已实测漏检正脸；漏检会让比例偏低，使 `<= 0.2` 误判为 True |
| 4 | 0.6 是共用常量，`remove-face` 一起降 | 否则同一条 flow 里两个节点对"什么算人脸"定义不一致 |
| 5 | 抽 **20 帧**均匀分布，`-ss` 快速 seek 不全解码 | 成本与时长无关；精度 0.05 |
| 6 | 无视频（纯图文）→ `failed` | 与 videoAction 一致，且"失败时绝不猜结果" |
| 7 | 删除 moondream 缩略图链路 | 改造后完全无调用方 |
| 8 | handle id 改为 `true` / `false` / `failed` | prod 零 flow 使用，迁移成本几乎为零 |
| 9 | 比较符 `<=` `<` `>=` `>`；阈值 0~1 小数，默认 `<= 0.2` | 浮点相等在这里几乎总是误用 |
| 10 | 比例进 payload → `$content.face_ratio` | 下游可插值；且 container 日志查不到，这是唯一的诊断线索 |
| 11 | 优先用上游 `processed_video_url`，继承 600 秒上限 | 与 videoAction 一致；支持 `Remove Face → Video Condition` 验证效果 |
| 12 | 复用 `VIDEO_ACTION_QUEUE` | 不新增资源 |
| 13 | `operation` id 保持 `check-face`，只改 UI 文案 | 名实仍相符，避免无谓的存量数据改动 |

## 顺带必修的缺陷

`flow/src/index.ts` 的超时兜底扫描按
`type === "action" && data.actionType === "videoAction"` 判断是否走 `failed`。
`videoCondition` 节点的 `type` 是 `"videoCondition"`，会落到 `"no"` 分支，
而新 handle 是 `true`/`false`/`failed` —— 一条边都匹配不上，**回调丢失时流程静默死掉**。
守卫必须扩展到 videoCondition。

## 语义翻转（迁移注意）

默认 `<= 0.2 → True` 表示"人脸很少"，对应的是旧的 `no-face`，与旧 `has-face` 正好相反。
dev 上唯一使用该节点的已发布 flow「Save no-face videos to Playlist」的连线
`sourceHandle: "no-face"` 需改为 `"true"`。prod 无 flow 使用。

## 数据流细节

- container `POST /face-ratio` 入参 `{job_id, video_key}`，返回
  `{"ratio": 0.35, "sampled": 20, "detected": 7}`，失败按本文件惯例返 `{"error": ...}, 200`
- 复用 `video_action_jobs` 表，`operation = "check-face"`，`JobStatus` 新增 `"sampling_faces"`
- resume 时 `operator` / `threshold` 缺失兜底为 `<=` / `0.2`
- 比例计算不到（0 帧可解码）→ `failed`，不返回 0

## 验证

1. `content` / `flow` 单测：比例计算、阈值判定、超时兜底走 failed、无视频走 failed
2. 本地 wrangler 部署 dev，浏览器目验节点 UI 与那条 flow 的连线
3. 真实 e2e：跑上次那个 YouTube 视频，同时验证 `remove-face` 在 0.6 阈值下是否切干净
