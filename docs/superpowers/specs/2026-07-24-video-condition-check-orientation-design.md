# Video Condition: Check Orientation 设计

## 背景

起因：能否让 YouTube 视频的宽高作为 content prop？

调研结论（YouTube Data API v3）：`contentDetails`（公开可访问）只有 `dimension`
（2D/3D）和 `definition`（hd/sd），没有真实像素宽高；`fileDetails.videoStreams[].width/heightPixels`
需要视频**所有者自己的 OAuth**，第三方视频（我们的抓取场景）拿不到；`player` 部分
（`maxWidth`/`maxHeight` → `embedWidth`/`embedHeight`）虽公开可访问，但只是嵌入播放器
按请求尺寸缩放后的**近似值**，不是源文件真实宽高。

结论：**做不到**可靠的第三方 YouTube 视频真实宽高 content prop。改为在已有的
`videoCondition` 节点上新增 **Check Orientation** operation，通过下载视频后
ffprobe 探测真实宽高——这一步与视频来源平台无关（YouTube/TikTok/X 均可），
复用 [[2026-07-22-video-condition-face-ratio-design]] 已经建好的
"container 处理 + resume 回流程" 异步链路。

## 复用的现有架构

`content/main.py` 已有 `_probe_dimensions()`（ffprobe 探测宽高），目前只在
`/rotate-to-vertical`、`/burn-subtitles` 内部调用，没有独立暴露的端点。
`videoCondition` 节点已有 `check-face` operation 的完整异步链路（下载 → container
计算 → resume 回 flow → flow 侧读 operator/threshold 判分支），Check Orientation
完全复用同一条链路，只是 container 里跑的算法和最终 prop 字段不同。

```
flow 派发 → content_flow_pending (awaiting_event: video_action_complete)
         → VIDEO_ACTION_QUEUE
         → content 队列消费者 → container /probe-dimensions
         → POST flow /internal/video-action/resume (带 aspect_ratio)
         → flow 读 node.data 的 operator/threshold 判 true/false/failed
```

## 锁定的决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 新增 container 路由 `POST /probe-dimensions`，从 `_probe_dimensions()` 提取为独立端点 | 与现有"一个 operation 一个路由"的约定一致（`/face-ratio`、`/rotate-to-vertical` 等均如此） |
| 2 | 返回值为 `{width, height, ratio, error}`，`ratio = width / height` | 判定用连续数值而非布尔，用户可自行设定阈值 |
| 3 | 正方形视频（width == height，ratio == 1）算 **Portrait** | 用户明确选择，即判定边界为 `ratio > 1` 才是 Landscape |
| 4 | UI 复用 `check-face` 现成的 Operation 下拉 + 比较符下拉 + 数值输入，**不单独做 Landscape/Portrait 选择器** | 用户明确选择：让用户直接对 ratio 设比较符和阈值，不引入额外的分类抽象层 |
| 5 | 切到 `Check Orientation` 时预填 `> 1`，用户可改 | ratio > 1 即 Landscape，是最常见判定诉求 |
| 6 | 该 operation 的数值输入**不设 min/max/step**，自由输入 | ratio 范围远超 `check-face` 的 0~1（如 16:9 ≈ 1.78），限制没有意义；`check-face` 自身的 0~1/step 0.05 保持不变，仅对新 operation 生效 |
| 7 | 阈值判定仍在 **flow 的 resume 路由**，container 只返回原始 ratio | 与 `check-face` 一致：阈值是流程配置，单一真相在 graph，content 模块不需要知道"阈值"这回事 |
| 8 | 探测失败（下载失败/ffprobe 拿不到宽高）→ `failed`，不返回猜测值 | 与 `check-face` 一致："失败时绝不猜结果" |
| 9 | `operation` id 定为 `check-orientation` | 与 `check-face` 并列，命名风格一致 |
| 10 | 复用 `VIDEO_ACTION_QUEUE` 和 `video_action_jobs` 表，不新增 Cloudflare 资源 | 项目约定：能复用现有绑定就不新增 |
| 11 | `check-face` 的 UI/默认值/分支语义完全不变 | 纯新增，不影响任何既有 flow |

## 数据流细节

- container `POST /probe-dimensions` 入参 `{job_id, video_key}`（`video_key` 来自
  已下载到 R2 的视频，复用 `/download` 步骤，不重复下载），返回
  `{"width": 1080, "height": 1920, "ratio": 0.5625}`，失败按本文件惯例返
  `{"error": ...}, 200`
- `container-client.ts` 新增 `probeDimensions(env, jobId, videoKey)`，与
  `faceRatio()` 同构
- `queue-video-action.ts` 新增 `processCheckOrientation`，与 `processCheckFace`
  1:1 对照：下载 → `probeDimensions()` → 失败调
  `resumeFlow(..., "failed", {}, reason)`；成功调
  `resumeFlow(env, pendingId, "success", { aspect_ratio: ratio })`
- `processVideoActionJob` 新增 dispatch：`message.operation === "check-orientation"`
- `flow/src/engine.ts`：新增 orientation 分支判定，读 `props.aspect_ratio` 与
  `data.operator`/`data.threshold` 比较，语义与 `evaluateFaceRatioBranch` 完全一致
  （`true`/`false`/`failed`）。比较逻辑本身与 `check-face` 一模一样（都是
  数值 vs operator vs threshold），实现计划里应提取成一个共享 helper，
  `check-face`/`check-orientation` 各自一个薄调用点——这只是代码组织方式，
  不影响任何外部行为
- resume 时 `operator`/`threshold` 缺失，兜底为 `>`/`1`（与 `check-face` 缺失兜底
  `<=`/`0.2` 对应的模式一致：兜底值 = 该 operation 的默认预填值）

## 验证

1. `content` / `flow` 单测：ratio 计算、阈值判定（含默认 `> 1`）、探测失败走
   `failed`、无视频走 `failed`
2. 本地 wrangler 部署 dev，浏览器目验节点 UI：Operation 下拉出现 "Check Orientation"，
   切换后阈值输入无 min/max 限制且预填 `> 1`
3. 真实 e2e：用一个已知横屏和一个已知竖屏的 YouTube 视频各跑一次，确认分支正确
