# 租户上传技能 — 设计

**日期：** 2026-08-12
**目标：** 让租户上传自己的 skill（zip 包、文件夹或单个 SKILL.md），上传后在 flow 节点的技能下拉里选择它，与预置技能走同一条注入链路。

---

## 1. 背景与边界

今天技能只有一个来源：`content/src/skills/catalog.ts` 里硬编码的 `SKILL_CATALOG`，正文缓存在 `skill_content_cache`。那张表**没有 `tenant_id`**，建表注释写明"内容跨租户共享"——预置技能对所有租户是同一份，这是对的，但也意味着租户上传的内容一个字节都不能进这张表。

三条已定的边界：

- **上传的与预置的并列，各自独立。** 不覆盖、不替换预置；下拉里同时出现。
- **一次上传可以是一个技能，也可以是一整包**，由内容自动识别。
- **上传的技能不注入租户上下文。** 那份「品牌与产品上下文」的 12 个小节是照着 `product-marketing` 那个包的消费方式写的，套到一个可能完全无关的自传技能上未经验证。代价是上传的 social 会弱于预置的 social——已知并接受。

---

## 2. 架构：浏览器端拆包，后端只收干净 JSON

```
浏览器  拖入 zip / 文件夹 / 单个 SKILL.md
          ↓ 解包，只留 SKILL.md 与 references/**/*.md
          ↓ 识别单技能还是整包
          ↓ 与已上传列表比对，标出重名
          ↓ 预览：本次导入哪几个、各自多大、重名的怎么办
   POST /api/skills/import { skills: [{ name, overwrite, files: [{ path, content }] }] }
          ↓
后端    校验体量与重名 → 内联 references → 每个技能写一行
```

**后端完全不碰 zip。** 不引入解压库、没有 zip bomb 风险、不吃 Worker 的 CPU/内存上限；体量问题在浏览器端就被拦下且用户看得见。这也与仓库既有做法一致——`link/frontend/components/LocalImport.tsx` 已经在浏览器端拖文件夹、递归读取、解析 `.md` 之后才发给后端。

### 识别规则

- 根目录有 `SKILL.md` → 单技能
- 没有，但存在若干含 `SKILL.md` 的子目录 → 整包，每个子目录一个技能
- 两者都不满足 → 报错，提示期望的目录结构

单个 `.md` 文件视作"只有 SKILL.md、没有 references"的单技能。

---

## 3. 存储

content D1 新表（migration `0009_tenant_skill.sql`）：

```sql
-- 租户自己上传的技能。与 skill_content_cache（全局、跨租户共享的预置技能）刻意分表：
-- 那张表没有 tenant_id，混进租户私有内容会跨租户泄漏。
CREATE TABLE tenant_skill (
  tenant_id   INTEGER NOT NULL,
  skill_id    TEXT NOT NULL,     -- "upload:<slug>"，与预置 id 天然不撞
  label       TEXT NOT NULL,     -- 下拉里显示的名字
  content     TEXT NOT NULL,     -- SKILL.md + 内联的 references
  source      TEXT NOT NULL,     -- 原始文件名，供界面显示
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, skill_id)
);
```

`skill_content_cache` 一个字节不动。`skill_id` 的 `upload:` 前缀让两个命名空间天然隔离，存量 flow 节点里存的 `skillId` 不受任何影响。

---

## 4. 两条来源在一处合流

`getSkillContent(env, skillId)` 今天只查全局表。改为按前缀分派：

```ts
export async function getSkillContent(env: Env, tenantId: number, skillId: string): Promise<string | null> {
  if (skillId.startsWith(UPLOAD_PREFIX)) {
    // 租户私有：必须带 tenant_id，否则一个租户能读到另一个租户上传的正文
    const row = await env.CONTENT_DB.prepare(
      "SELECT content FROM tenant_skill WHERE tenant_id = ? AND skill_id = ?"
    ).bind(tenantId, skillId).first<{ content: string }>();
    return row?.content ?? null;
  }
  const row = await env.CONTENT_DB.prepare(
    "SELECT content FROM skill_content_cache WHERE skill_id = ?"
  ).bind(skillId).first<{ content: string }>();
  return row?.content ?? null;
}
```

`generateContent` 已经持有 `tenantId`，只需多传一个参数。全仓库 `getSkillContent` 只有 **一个** 调用点（`content/src/services/generate.ts:27`），所以签名变更的涟漪就这一行。**flow 节点、link、marketing-context 全都不用改**——它们看到的仍然只是一个 `skillId` 字符串。

`GET /api/skills` 合并两份返回：预置来自 `SKILL_CATALOG`（带 `hasCachedContent`），上传的来自 `tenant_skill`。flow 的下拉因此自动有了。

**上传的技能不注入租户上下文是现有代码的自然行为，零改动**：`getSkillDefinition("upload:…")` 在 `SKILL_CATALOG` 里找不到 → 返回 `undefined` → `repo` 为 `undefined` → `generate.ts` 不查也不注入。

---

## 5. 导入规则

- 只取 `SKILL.md` 与 `references/**/*.md`，其余（`evals/`、图片、脚本）丢弃
- 按现有 `refreshSkillContent` 同一套逻辑内联 references，**上限沿用 8 个**
- `label` 取 SKILL.md frontmatter 的 `name`，缺失则用目录名（单文件则用文件名去扩展名）。frontmatter 是文件开头 `---` 包起来的 YAML，**只需正则取出 `name:` 那一行**，不要为此引入 YAML 解析库——我们不消费其余字段
- `skill_id` = `upload:` + label 的 slug（小写、非字母数字转 `-`）
- **单技能上限 256KB，单次导入上限 20 个技能**。预置的 social 是 61KB，留足余量又能挡住误传整个仓库

### 重名处理

重名只可能发生在**上传的技能之间**（预置 id 是 `marketingskills-*`，上传是 `upload:*`，构造上不相撞）。

- 浏览器在预览阶段就与已上传列表比对，把重名项标出来，逐个让用户选**覆盖**或**改名**（就地编辑名字）
- 请求体里每个技能带一个显式的 `overwrite` 布尔
- **后端不信任前端的判断**：若某个 `skill_id` 已存在而请求没有 `overwrite: true`，整个请求以 **409** 拒绝并回列冲突的名字。两个标签页、或列表过期的情况下，静默覆盖会让用户丢掉自己写的技能

---

## 6. 界面

AI Content Settings 增加一张「我的技能」卡：

- 拖拽区（同时接受 zip、文件夹、单个 `.md`），下方是已上传列表：名称、来源文件、大小、上传时间、删除
- 预览态显示本次将导入哪几个技能，重名的行内给出「覆盖」/「改名」二选一
- 删除即从 `tenant_skill` 删行

**删除后存量 flow 静默降级**：`getSkillContent` 返回 `null`，`generateContent` 就当没有技能继续生成——这与"技能尚未抓取"是同一条既有路径，无需新增发布校验。

---

## 7. 测试

**浏览器端拆包**（纯函数，真实行为测试）
- 三种入口：zip、文件夹、单个 `.md`
- 单技能 vs 整包的识别；两者都不满足时报错
- 非 `.md` 与 `evals/` 被丢弃
- references 超过 8 个时只取前 8

**后端**
- 导入端点的**租户隔离**：A 租户上传的技能，B 租户的 `GET /api/skills` 里不出现，`getSkillContent` 也读不到
- 重名且未带 `overwrite` → 409 且回列冲突名；带 `overwrite: true` → 覆盖那一行且不新增行
- 超过单技能 256KB / 单次 20 个 → 拒绝
- `getSkillContent` 的双来源分派：`upload:` 前缀走租户表并绑定 `tenant_id`，其余走全局表
- `GET /api/skills` 合并两份且预置项的 `hasCachedContent` 语义不变

**端到端**
- 导入一份 social，在生成里选它，产出与选预置那条**除租户上下文外**一致

---

## 8. 明确不做

- 后端解压（浏览器端做，理由见 §2）
- 上传技能注入租户上下文（§1）
- 上传技能覆盖或替换预置技能（§1）
- 从 URL 拉取租户自己的技能仓库（本次只做文件上传）
- 技能版本历史（同名覆盖即替换，不留旧版）
