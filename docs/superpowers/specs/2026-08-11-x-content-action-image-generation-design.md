# X Content Action 图片生成 — 设计

**日期：** 2026-08-11
**目标：** 让 X Content Action 的 create-post 操作能附带一张 AI 生成的配图；图片模型的选择集中到 AI Content Settings 页，并按 provider 动态发现。

---

## 1. 背景与范围

X create-post 目前能发纯文本，或附加上游 Video Action 产出的视频（`attachVideo`）。本设计新增第三种形态：附加一张由扩散模型生成的插图。

图片是**氛围配图**，不是信息卡片。题材偏技术感（例：GitHub release 触发的流程配一张抽象科技插画），但图上不承载准确文字——扩散模型写不准字，本设计不试图让它写。需要逐字精确的发布卡片不在范围内。

出图管道已经存在（TikTok photo-post 在用）：`content` 的 `/internal/generate-image` → Workers AI flux-1-schnell 或 BYOK OpenAI gpt-image-1 → R2 → 返回 URL。本设计复用它，并把"用哪个图片模型"从代码常量迁到租户配置。

同时，TikTok photo-post 的图片配置块收敛成与 X 相同的形态。

---

## 2. 用户可见的改动

### 2.1 X Content Action 节点（create-post）

文本生成那一块（provider / prompt / skill）不变。底部原有的单个 `Attach video` 勾选框变成两个，图片在上：

```
[✓] Attach AI-generated image
      Image provider  [ Default (free built-in model) ▼ ]
      Image prompt    [ abstract tech illustration about: $content.title   ]
[ ] Attach video (uses this flow's processed video, if any)
```

- **Image provider** 与文本 provider 相互独立。下拉只列出**该租户当前有图片模型可用**的 provider（见 3.2）。Anthropic 永远不出现在这个下拉里。
- **Image prompt** 支持 `$content.*` 变量，插值后**直接**送给扩散模型（一段式）。不经过文本模型改写。
- 两个勾选框**同时勾中是配置错误**，由发布校验拦下：X 一条推文只能挂一种媒体。

### 2.2 TikTok Content Action（photo-post）

图片块收敛为与 X 同形：**去掉 Image skill 下拉**，Image provider 改用同一套"只列有图片模型的 provider"逻辑。`imageCount`（1–9）保留——那是 TikTok 支持多图的平台差异，不是形态不一致。

已存档 flow 里的 `imageSkillId` 字段被忽略，不做数据迁移。把 60KB 的技能文档拼在出图 prompt 后面本来就只会把图带偏，去掉是行为改善。

### 2.3 AI Content Settings 页

现有三张 provider 卡（OpenAI / Anthropic / Default），每张卡的 `Model` 下面多一个 `Image model` 选择器：

| provider | 图片模型列表来源 | 结果 |
|---|---|---|
| Default | Cloudflare `ai/models/search?task=Text-to-Image` | flux-1-schnell 等 |
| OpenAI | `/v1/models` 筛 `gpt-image-*` / `dall-e-*` | gpt-image-1、dall-e-3 等 |
| Anthropic | `/v1/models` 只返回对话模型 | 空 |

**列表为空时整个 `Image model` 选择器不渲染**，卡片上不出现任何"本 provider 没有图片模型"的说明文字。"Anthropic 没有图片模型"这条事实由动态发现得出，不写死在代码里。

---

## 3. 模型配置的存储与解析

### 3.1 存储

`tenant_llm_credentials` 增加一列（migration `0007_image_model.sql`）：

```sql
ALTER TABLE tenant_llm_credentials ADD COLUMN image_model TEXT;
```

主键 `(tenant_id, provider)` 不变，不建新表。语义：这一行是"该租户在该 provider 上的模型选择"，`model` 是文本模型，`image_model` 是图片模型。

### 3.2 解析规则（无运行时硬编码回退）

- **Default provider**：`getDefaultImageModel()` 返回 `image_model ?? DEFAULT_WORKERS_AI_IMAGE_MODEL`（`@cf/black-forest-labs/flux-1-schnell`）。这与文本侧 `getDefaultModel()` 的 `model ?? DEFAULT_WORKERS_AI_MODEL` 完全同构——常量是**初始配置值**，不是"配置缺失时的兜底"。因此 Default 永远有图片模型、永远可选。
- **BYOK provider（openai / anthropic）**：`image_model` 为 NULL 就是**没有配置**，没有任何兜底。该 provider 不出现在节点的 Image provider 下拉里；若某个存档 flow 仍指着它，`generate-image` 返回 400 `no image model configured`，节点走图片失败降级（见 4.3）。
- 设置页保存一个 BYOK provider 时，若该 provider 的图片模型列表非空，表单默认选中列表首项并一并保存，使"连接了 OpenAI 却选不了 OpenAI 出图"这种状态不会因为用户没注意到新选择器而出现。

### 3.3 可用 provider 的查询

`content` 新增 `GET /api/image-providers`，返回该租户可用于出图的 provider 列表：

```json
{ "providers": [ { "provider": "default", "model": "@cf/black-forest-labs/flux-1-schnell" },
                 { "provider": "openai",  "model": "gpt-image-1" } ] }
```

规则：`default` 恒在（3.2）；BYOK provider 当且仅当同时有 API key 和非空 `image_model` 时列出。flow 的两个节点面板都用这一个接口填 Image provider 下拉。

---

## 4. 执行链路

### 4.1 节点数据

`xContentAction` 新增三个字段（`flow/src/node-executors.ts` 同步透传）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `attachImage` | boolean | 勾选框 |
| `imageProvider` | `"default" \| "openai"` | 独立于 `provider` |
| `imagePrompt` | string | 支持 `$content.*` |

`attachVideo` 保持原样。

### 4.2 调用链

```
flow/src/index.ts
  ├─ 插值 imagePrompt 的 $content.*（与 interpolatedPrompt 同一处理）
  └─ POST link /internal/content/create-post
         { contentId, interpolatedPrompt, provider, skillId, channelId, flowId,
           videoUrl?,                       ← attachVideo 分支，不变
           imagePrompt?, imageProvider? }   ← attachImage 分支，新增

link/src/routes-internal.ts  /content/create-post
  ├─ 文本生成（不变）
  ├─ videoUrl 分支（不变，含 pending 轮询）
  └─ imagePrompt 分支（新增）
       ├─ POST content /internal/generate-image { tenantId, prompt, provider }
       ├─ fetch(url) 取回图片字节
       └─ initMediaUpload(media_category="tweet_image") → append → finalize → mediaId

createPost(accessToken, text, mediaId)
```

`initMediaUpload` 目前写死 `media_category: "tweet_video"`，改为参数，视频路径传 `"tweet_video"`、图片路径传 `"tweet_image"`。图片走同一条 init/append/finalize 链路（单分片即可，出图产物为 JPEG，远小于分片上限），**不进入 pending 轮询**——图片没有 X 侧的异步转码。

### 4.3 失败降级

`generate-image` 非 2xx、图片下载失败、或 X 拒绝该 media 时：写一条 `create_post_image_failed` 日志（含 contentId / channelId / imageProvider / 原因），**继续发纯文本推文，节点记为成功**。理由：配图是锦上添花，内容流不该因为一张图断掉。

失败原因只进日志，不写进 `reason`——`reason` 会一路进 `content_flow_log`，外部错误体长度不可控（与 YouTube 那几个出口同一条约定）。

### 4.4 发布校验

`flow/frontend/lib/validate-flow-graph.ts` 新增一条：`xContentAction` 且 `operation === "create-post"` 且 `attachImage && attachVideo` → 阻止发布，提示"X 一条推文只能附加图片或视频之一"。

---

## 5. metadata

`metadata/x-byok.ts` 的 create-post：

```ts
contentProps: [
  {propId: "message_text",  aiType:"TEXT"},
  {propId: "message_image", aiType:"IMAGE"},   // 新增
  {propId: "message_video", aiType:"VIDEO"},
],
```

`price` 保持 `0.010` 不变——那是 X 的发推计费，出图不改变它（图片成本落在 Workers AI 免费额度或租户自己的 OpenAI 账单上，不是平台文档记载的 per-call fee）。

`message_image` 已在 `metadata/props.ts` 中定义，无需新增 prop 定义。

**注意** `flow/frontend/components/Inspector.tsx` 现有的 `aiProp` 查找是 `find(p => p.aiType && p.aiType !== "VIDEO")`——加入 IMAGE prop 后它仍返回 `message_text`（数组首项），文本块行为不变；图片块用独立的 `find(p => p.aiType === "IMAGE")` 取。

---

## 6. 改动清单

**content**
- `migrations/0007_image_model.sql`：加 `image_model` 列
- `services/llm-credentials.ts`：`getDefaultImageModel` / `getImageModel` / 保存时接受 `imageModel`；`listConfiguredProviders` 返回 `imageModel`
- `services/model-catalog.ts`：`listWorkersAiImageModels`（`task=Text-to-Image`）、`listOpenAiImageModels`（`/v1/models` 筛图片模型）
- `services/generate-image.ts`：模型改从租户配置解析；**删除 `skillId` 参数**（去掉 TikTok 的 image skill 后无调用方）
- `src/index.ts`：`/api/llm-models` 支持 `kind: "text" | "image"`；新增 `/api/image-providers`
- `src/routes-internal.ts`：`/generate-image` 去掉 `skillId`；无图片模型时返回 400
- `frontend/pages/SettingsPage.tsx`：`Image model` 选择器（列表为空则不渲染）

**link**
- `services/x-posts-api.ts`：`initMediaUpload` 接受 `mediaCategory` 参数
- `routes-internal.ts`：`/content/create-post` 的 imagePrompt 分支；`/tiktok/photo-post` 去掉 `imageSkillId`

**flow**
- `frontend/components/Inspector.tsx`：X 图片块（checkbox + provider + prompt）；TikTok 去掉 image skill、provider 下拉改用 `/api/image-providers`
- `frontend/lib/api.ts`：`imageProviders.list()`
- `frontend/lib/validate-flow-graph.ts`：图片与视频互斥校验
- `src/node-executors.ts`：透传 `attachImage` / `imageProvider` / `imagePrompt`
- `src/index.ts`：插值 imagePrompt 并转发
- `sequence.md`：xContentAction 时序图补上出图与 media upload 两步

**metadata**
- `x-byok.ts`：create-post 加 `message_image`

---

## 7. 测试

- **content**：`image_model` 读写与 Default 常量初始值；`listOpenAiImageModels` 的筛选（chat 模型不入选、`dall-e-2` 入选）；Anthropic 图片列表为空；`generate-image` 在 BYOK provider 无 `image_model` 时返回 400；`/api/image-providers` 只列有图片模型的 provider。
- **link**：`/content/create-post` 挂图成功路径（断言 `media_category="tweet_image"` 且 `createPost` 收到 mediaId）；出图失败 → 仍发纯文本且 `ok:true`；同时给 `videoUrl` 与 `imagePrompt` 时以视频为准（后端防御，正常路径已被发布校验挡住）。
- **flow**：`node-executors` 透传三个新字段；`validate-flow-graph` 双勾选报错、单勾选放行；`$content.*` 在 imagePrompt 中被插值。
- **frontend**：设置页在图片模型列表为空时不渲染选择器。

---

## 8. 明确不做

- 逐字精确的发布卡片（模板渲染 → PNG）。本设计只做扩散模型配图。
- X 多图（上限 4）。固定 1 张；同一条 prompt 出 4 张只会得到 4 张雷同的图。
- 两段式 prompt（先让文本模型写视觉描述）。用户直接写图片 prompt。
- TikTok `imageSkillId` 的数据迁移。字段留在存档 JSON 里被忽略。
