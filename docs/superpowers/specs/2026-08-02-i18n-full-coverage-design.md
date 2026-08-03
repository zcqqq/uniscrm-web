# 全系统 UI 文案中文化设计（2026-08-02）

## Context

产品支持 en/zh 双语（`members.language`，D1），但实际只有零星覆盖：web 模块有 react-i18next（仅 3 个文件、约 30 个 key 在用），link/flow/analytics/shared 通过 `useLocale()` + `metadata/locale.ts` 的 `t(s, locale)` 渲染元数据标签（这部分已全双语），insight-segment 与 content 零机制。其余全部是硬编码英文——2026-07-31 摸底：前端约 1,500–2,000 条。

目标：把所有用户可见的前端硬编码英文接入双语，中文语言下全站显示中文。

## 已确认的决策

1. **范围只含前端 UI 文案**。后端 `c.json({error:...})`（约 170–220 条）、邮件模板（2 封）、各模块 `<title>` 均不在本期。
2. **admin 模块跳过**——内部运维工具，本来就是中文。
3. **机制选内联双语串（方案 C）**：`t({en, zh}, locale)` 写在使用处，全系统唯一机制，**退役 i18next**。用户在 A/C 两案间明确确认选 C。
4. 语言切换生效时机：跨模块整页加载自然生效；web Settings 切语言后当页 reload 一次。

## 机制设计

### 保持不动

`metadata/locale.ts`：`type Locale = "en" | "zh"`、`LocalizedString = { en: string; zh?: string }`、`t(s, locale)`。已被 4 个模块验证。

### 新增（shared/frontend）

1. **`useT()`**（`shared/frontend/hooks/useT.ts`）：包装 `useLocale()`，返回绑定当前 locale 的翻译函数。调用处：
   ```tsx
   const T = useT();
   <Button>{T({ en: "Publish", zh: "发布" })}</Button>
   ```
   非组件上下文（如列定义工厂函数）继续用 `t(s, locale)` 显式传 locale——现有 `metadata-columns.tsx` 已是此模式。

2. **common 词表**（`shared/frontend/i18n-common.ts`）：约 30 个高频词导出为 `C`，如 `C.save = { en: "Save", zh: "保存" }`。覆盖：Save/Cancel/Delete/Edit/Add/Create/Search/Loading.../Confirm/Close/Back/Next/Name/Status/Actions/Type/Date/Description/Enabled/Disabled/Yes/No/None/All/Error/Retry/Copy/Export/Settings/Refresh。调用处 `T(C.save)`。**判断标准：一个词在 3 个以上模块出现才进 common**；页面专属文案一律内联，不建每模块字典。

3. **`useLocale` 消闪烁**：现为异步 fetch(/api/auth/me)，每页先渲染英文再跳中文。改为：初值同步读全域 `lang` cookie（登录/切语言时由 web worker 落好，`domain=uni-scrm.com`），fetch 结果到达后仅在与 cookie 不一致时纠偏。cookie 缺失时初值 en，行为与今天一致。timezone 逻辑不动。

### web 模块迁移

`web/src/lib/i18n.ts` 的约 30 个 key 全部改写为内联式；`Settings.tsx`、`PasswordCard.tsx`、`useAuth.tsx` 去掉 `useTranslation`/`i18n.changeLanguage`；Settings 切语言成功后 `window.location.reload()`；从 `web/package.json` 删除 `i18next`、`react-i18next` 依赖。完成后仓库内不得再出现这两个包。

### 接入空白模块

insight-segment、content 的组件 import `useT` 即接入。无需其它管线。

## 术语表（并行翻译的一致性契约）

所有翻译任务必须遵守。核心名词：

| en | zh | | en | zh |
|---|---|---|---|---|
| Channel | 渠道 | | Segment | 分群 |
| Flow | 流程 | | List | 名单 |
| Trigger | 触发器 | | Tier / Plan | 套餐 |
| Action | 动作 | | Credit | 额度 |
| Condition | 条件 | | Publish | 发布 |
| Node | 节点 | | Draft | 草稿 |
| Member | 成员 | | Subscription（计费） | 订阅 |
| User（渠道账号） | 用户 | | Subscription（YouTube 订阅） | 订阅 |
| Recommendation | 推荐 | | Connect / Disconnect | 连接 / 断开 |
| Content Library | 内容库 | | Sync | 同步 |
| Dashboard | 仪表盘 | | Upgrade | 升级 |

**保留英文不译**：UniSCRM、X、YouTube、TikTok、Shopify、Notion、Stripe、Webhook、API、OAuth、BYOK、Cron、A/B、URL、ID、Token。

**风格**：简体中文；中英文之间加半角空格（"连接 X 渠道"）；标点用全角；语气用陈述句不用敬语；按钮文案动词开头且简短。

## 边界处理

- **`flow/nodeTypeRegistry.ts`（deny 名单禁改）**：新建 `flow/frontend/config/nodeTypeLabels.ts`，按节点 id 映射 `{ label: LocalizedString, description: LocalizedString }`，覆盖全部 17 个节点。渲染处（palette Sidebar、节点组件、Inspector 标题）查此表，查不到回落注册表原文。注册表本体一字不动。
- **prop 驱动组件**（EmptyState/ConfirmDialog/PageHeader 等）：文案在调用处，按普通调用处翻译；组件自身只翻默认值（如 ConfirmDialog 的 "Confirm"/"Cancel" 默认值改用 common 词表）。
- **原生 `confirm()`/`alert()` 调用**：字符串照常翻译，不换组件（换组件是另一件事，YAGNI；flow 列表页那个已知会冻结 claude-in-chrome 的原生 confirm 不在本期动）。
- **无障碍文本**（aria-label、`sr-only` 的 "Close" 等）：属普通字符串，本期一并翻译。
- **明确不动**：日期格式（`format-time.ts` 刻意固定 M/D/YYYY，有 `time-format-audit.mjs` 把关）；`metadata/*.ts`（已双语）；admin；后端错误串；邮件；`<title>`。

## 完成度门禁

新增 `scripts/i18n-audit.mjs`：

- 扫描 8 个前端目录（web/src、link/frontend、flow/frontend、analytics/frontend、insight-segment/frontend、content/frontend、shared/frontend、shared/components 若有）的 `.tsx/.ts`
- 启发式：JSX 文本节点、`placeholder=`、`title=`、`label:`、`description:`、`confirm(`、toast 调用中，匹配"以大写字母开头、含 ≥2 个英文单词"的裸字符串字面量（不在 `{en:...}` 结构内）
- 支持行内 `// i18n-ok: <理由>` 豁免（如日志、纯技术串）
- 输出未翻译清单与计数；退出码非零表示有未豁免残留
- 定位是**辅助门禁**：启发式必有漏报误报，最终判据是逐模块浏览器目检

## 测试

- `useT` / `useLocale` cookie 初值：单测（cookie 有值同步生效、缺失回落 en、fetch 纠偏）
- common 词表：单测校验每个词 en/zh 都非空
- `nodeTypeLabels`：单测校验 17 个节点 id 与注册表一一对应（防注册表将来加节点而映射表漏加）
- web 迁移后：现有测试无新增失败；仓库 grep 无 i18next 残留
- 每模块翻译完成后：`npm run deploy:dev` + 浏览器切 zh 逐页目检 + audit 脚本通过

## 执行组织

约 14 个任务，subagent 并行（翻译任务互不依赖，内联式无合并冲突）：

1. 机制层（串行先行）：useT + common 词表 + useLocale 消闪烁；web i18next 迁移退役
2. 审计脚本（先于翻译任务完成，作为各任务的验收工具）
3. 翻译任务（并行）：shared / web 余量 / link / flow-Inspector / flow-其余 / analytics-Detail+ReportConfig / analytics-其余 / insight-segment / content / flow-nodeTypeLabels
4. 收尾：全模块 deploy dev + 浏览器 zh 走查 + audit 全绿

## 本期不做

- 后端错误串中文化（需错误码机制，独立题目）
- 邮件模板双语
- `<title>` 运行时切换
- 第三语言扩展（机制天然支持，加 locale 枚举即可）
- 原生 confirm/alert 换自定义组件
