# 租户技能上下文 + 两段式出图 — 设计

**日期：** 2026-08-11
**目标：** 让每个租户在 AI Content Settings 里通过多轮对话产出一份自己的 product marketing 上下文文档，注入到所有 AI 生成；并把图片生成从一段式改为两段式，由文本模型读触发内容写出视觉描述，再交给扩散模型。

---

## 1. 背景

当前状态有三个问题，它们是同一个根因的三个面：

**生成不知道租户是谁。** 文本生成的系统提示词只有通用的 `marketingskills/social` 技能和一段操作契约。模型不知道这个租户卖什么、卖给谁、什么调性，写出来的推文对任何产品都成立——也就对哪个产品都不贴。

**图片提示词要用户手写，还得自己插正文。** 节点上的图片提示词框写法是 `抽象科技风插画，基于内容：$content.content_text`。这既反直觉，又会撞上扩散模型的提示词上限：实测 flux-1-schnell 接受 2048 字符（含），2049 即失败；一篇 2271 字的 GitHub release 正文插进去就是 2284 字符，必然出不了图。而按现有降级规则，这会静默变成纯文本推，用户界面上完全无感。

**扩散模型吃不了长文。** 即使不超限，把整篇 changelog 当关键词丢给 flux 也只能得到一堆视觉噪音。扩散模型要的是"一个仪表盘、冷色调、浅景深"，不是产品说明书。

三者共同的解法是同一件事：**在内容和扩散模型之间插入一个理解内容的文本阶段，并给这个阶段一份关于租户自己的上下文。**

---

## 2. 架构

```
AI Content Settings
  「品牌与产品上下文」
      ├─ 首次：从租户近期内容自动起草 V1
      ├─ 多轮对话修正（受 product-marketing 技能指导）
      └─ 存为 markdown，按 (租户, 技能包) 一份
                    │
                    ↓ 注入所有生成
   ┌────────────────┴────────────────┐
   ↓                                 ↓
文本生成                         图片生成（两段式）
system = [social 技能,           stage 1: system = [image 技能,
          租户上下文,                                租户上下文,
          operationContext]                         出图契约]
                                          user = 触发内容 title + text
                                            ↓ 一行视觉描述
                                  stage 2: flux / gpt-image
```

**注入顺序固定为「技能 → 租户上下文 → operationContext」。** 技能是通用大块（60KB 量级），租户上下文是具体小块（2–4KB），越具体越靠后；operationContext 是执行契约，必须留在最末尾。这个顺序不是偏好——2026-08-09 实测过，长系统提示词里模型最看重尾部，契约放前面会被技能文档淹没。

---

## 3. 租户技能上下文

### 3.1 归属：包，不是技能

这份文档由 `product-marketing` 技能产出，但**属于整个技能包**——技能自己写明"其他 marketing 技能会自动使用这份上下文"。所以存储键是包，不是包里的某个技能。

`SkillDefinition` 增加 `repo` 字段：

```ts
export interface SkillDefinition {
  id: string;        // 按技能，如 "marketingskills-social"
  label: string;
  sourceUrl: string;
  repo: string;      // 按包，如 "coreyhaines31/marketingskills"
}
```

现有技能 id 不动——它们已经写进 `skill_content_cache` 和存量 flow 节点的 `skillId` 里，改名要迁移两处数据，收益为零。

### 3.2 存储

content D1 新表（migration `0008_skill_context.sql`）：

```sql
CREATE TABLE skill_context (
  tenant_id  INTEGER NOT NULL,
  skill_repo TEXT NOT NULL,     -- GitHub repo id，如 "coreyhaines31/marketingskills"
  content    TEXT NOT NULL,     -- 完整 markdown，含技能自带的 Changelog 段
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, skill_repo)
);
```

列名是 `skill_repo` 而不是 `skill_id`：存的是 repo id，叫 skill_id 会让下一个读代码的人以为它对应 `SKILL_CATALOG` 里的技能 id。

**不做行级版本历史。** 文档自带 Changelog 段，版本演进记在正文里——这是技能本身的设计，再存一份行历史是重复真相。`version` 列只用于界面展示和乐观并发。

### 3.3 起草

`POST /api/marketing-context/draft`：读该租户 per-tenant D1 里近期内容的 `title` / `content_text`，一次 LLM 调用产出 12 节草稿，作为对话的第一条助手消息返回。

技能推荐的做法是"读代码仓起草"，我们没有代码仓；**近期内容是我们手上最富的等价信号**——它直接反映这个租户在发什么、对谁发、什么调性。

**只读内容，不读渠道列表。** 两条理由，都经 dev 实测确认：

1. **渠道里没有定位信号。** `channels.config` 存的是 id、显示名和凭证——X 渠道里唯一的"内容"是 `x_name`，一个品牌名；YouTube/TikTok 同理。没有 bio、没有简介、没有"我们做什么"。
2. **渠道里存的是凭证。** `config` 同时装着 `access_token` / `refresh_token` / 加密的 `app_client_secret`。为起草新开一条读渠道的接口，等于把凭证放到离 LLM 提示词一步之遥的地方，换回来一个品牌名。

品牌名由对话问一句即可（12 节访谈里本来就要问）。`WEB_DB.tenants` 也没有租户名（只有 `tenant_id / email / created_at / d1_database_id`），所以不存在更便宜的来源。

真正富的信号其实是**租户自己 X 账号的 bio**——那是一段自己写的定位陈述——但它没有被存在任何地方（`UserMetadata_X` 的 `description` 映射的是粉丝简介，不是自己的），要拿得现调 X API。不在起草范围内。

content 需要新增 `CF_D1_API_TOKEN` secret 才能经 `shared/tenant-data-db.ts` 访问 per-tenant D1（租户的 `d1_database_id` 从它已有的 `WEB_DB` 读）。

租户一条内容都没有时，起草端点返回空草稿并附一句说明，对话从白纸开始——不报错。

### 3.4 对话

`POST /api/marketing-context/chat { messages }`，system = `marketingskills-product-marketing`（新目录条目）+ 当前文档（若有）。返回下一条助手消息。会话状态由前端持有，后端无状态。

**模型自己判断聊完**：按技能的流程逐节问完后，把完整文档放进带哨兵的围栏块。哨兵是固定串 `PRODUCT-MARKETING-CONTEXT-V1`，写在围栏的语言标签位：

````
```PRODUCT-MARKETING-CONTEXT-V1
# Product Marketing Context
...
```
````

选它做哨兵而不是认 ` ```markdown `：模型在对话里会为了举例、引用而输出各种 markdown 块，只有这个串明确表示"这是可保存的成品文档"。

**防跑偏**：前端只有在解析出**完整且带哨兵**的文档块时，才显示「保存这份文档」按钮。解析失败就是没有按钮，用户继续聊或直接用旁边的 markdown 编辑器改。**任何情况下都不自动保存**——一份残缺文档会污染此后所有生成，代价远高于让用户多点一次按钮。

`PUT /api/marketing-context { content }` 保存并递增 `version`。

### 3.5 模型

跟随租户已配置的文本模型：配了 OpenAI/Anthropic 就用 BYOK，没配就用免费默认。与全站一致，不引入新概念。免费默认模型做 12 节访谈质量有限，但可用，且用户随时能配 BYOK 提升。

### 3.6 注入

`getSkillContext(env, tenantId, repo)` 在每次生成时取，拼进系统提示词（顺序见 §2）。文档不存在就是不注入，行为退化到今天——**没有任何功能以它的存在为前提**。

---

## 4. 两段式出图

### 4.1 边界

两段都在 `content` 内，`/internal/generate-image` 内部变成两段。`link` 仍然只调一次、只认一个返回。理由：技能缓存和租户上下文都住在 content，提示词组装该留在它们旁边，而不是让 link 先取上下文再拼串。

### 4.2 接口

```
旧: { tenantId, prompt, provider }
新: { tenantId, provider, sourceTitle, sourceText }
```

`prompt` 消失。这是节点上删掉提示词框的必然结果，也让"用户手动把正文插进图片提示词"这个失败模式在接口层就不再可能出现。

### 4.3 stage 1

- system = `marketingskills-image`（SKILL.md + 由现有 `refreshSkillContent` 自动内联的 `references/ai-image-prompting.md`）+ 租户上下文 + 固定出图契约
- 出图契约（固定文案）：只输出一行英文视觉描述，不加引号、不加说明、不给备选；画面内不得出现可读文字
- user = `sourceTitle` + `sourceText`
- 模型 = 租户默认文本模型（**不跟节点上的文本 provider 走**——节点的文本 provider 可以是 `none`，而出图这一段总是需要一个文本模型）

**stage 1 的输出不设人为上限。** 它的职责就是压缩，正常输出一两百字符；给它加一道人造的墙没有依据。

### 4.4 长度保护住在适配器里

`WorkersAiImageProvider` / `OpenAiImageProvider` 各自知道自己模型的提示词上限，超出就截到上限再发，而不是让请求撞墙。flux-1-schnell 的上限实测为 **2048 字符（含）**，2049 即失败。

放在适配器而不是 stage 1 的理由：

- **数是推导出来的，不是发明的**——每个适配器只需知道自己那个模型的限制，这本来就是适配器存在的理由（它已经因为同样的道理长出了 gpt-image / dall-e 的请求分支）
- **保护所有调用方**，不只是 stage 1；今天和未来的任何调用方都不会再因为提示词过长而静默丢图
- **截断在扩散模型上近乎零损失**——扩散模型只对提示词开头一段有实质注意力

### 4.5 失败

stage 1 失败（模型报错、超时）→ 沿用现有降级：记 `create_post_image_failed` 日志、照发纯文本、节点记成功。两段的提示词都进日志，便于事后看模型到底写了什么。

---

## 5. 随之而来的删除

- 节点上的图片提示词输入框、`imagePrompt` 节点字段：**删**（X 与 TikTok 都删）。用户可控的风格来源从节点上移到租户上下文；租户还没写上下文时，画面只由触发内容和 image 技能决定（实测可用，见 §3.6：没有任何功能以上下文的存在为前提）。
- `metadata` 中 `message_image` 的 `aiType: "IMAGE"` 语义变为"本操作可附加生成图"，不再驱动一个提示词输入框。
- TikTok 的 `imageCount`（1–9）保留——多图是 TikTok 真实的平台能力。

存量 flow 里残留的 `imagePrompt` 被忽略，不做数据迁移。

---

## 6. 测试

**content**
- `skill_context` 读写、版本递增、按 `(tenant_id, skill_repo)` 隔离
- 注入顺序：技能 → 租户上下文 → operationContext（断言拼接结果的相对位置）
- 无上下文时行为与今天完全一致
- 起草端点：租户有内容 / 一条内容都没有
- chat 端点：转发历史、system 由技能 + 当前文档组成
- stage 1 契约：断言 user 消息是 title+text、system 含 image 技能
- **适配器截断**：给 flux 适配器一个 2100 字符提示词，断言实际发出的是 2048；给 2048 的，断言原样发出
- stage 1 失败时 `/internal/generate-image` 的返回

**link**
- create-post / photo-post 改传 `sourceTitle` / `sourceText`，不再传 `prompt`

**flow**
- 节点不再产出 `imagePrompt`；Inspector 不再渲染该输入框

**前端**
- 哨兵块解析：完整块 → 出现保存按钮；残缺块 → 不出现

---

## 7. 明确不做

- 行级版本历史（文档自带 Changelog）
- 起草时读渠道列表（渠道无定位信号且装着凭证，见 §3.3）
- 节点级的美术方向覆盖（风格唯一来源是租户上下文；将来需要再加）
- 存量 `imagePrompt` 的数据迁移
- 把 `SKILL_CATALOG` 的技能 id 改成 repo 限定形式（要迁移缓存表和存量节点数据，收益为零）
