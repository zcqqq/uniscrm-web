# Content Analytics Design

## Context

`analytics` 模块已有 User Analysis（`type: "user"`）：对 `uniscrm.user` R2 表做单次聚合快照查询（measure + 可选 dimension + filters，无时间维度）。本设计新增 Content Analysis（`type: "content"`），对已存在的 `uniscrm.content` R2 表做同样形态的分析，尽可能复用 User Analysis 的代码路径而非新写一套。

## 1. Metadata: 给 PropDefinition 加 entity 标记

`metadata/dataTypes.ts` 的 `PropDefinition` 新增可选字段：

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  isInsight?: boolean;
  entity?: "user" | "content";
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

`metadata/x.ts` 中 `PROPS_X` 里，按 `UserMetadata_X.userProps` / `ContentMetadata_X.contentProps`（`metadata/x-byok.ts`）实际引用情况，给每个 prop 标注 `entity`。`like_count` 目前只被 `ContentMetadata_X` 引用（`UserMetadata_X` 未映射），标 `entity: "content"`。

这同时修复一个既有问题：`ReportConfig.tsx` 当前的 `USER_PROPS = PROPS_X.filter(p => p.isInsight)` 没有区分实体，User Analysis 的维度下拉里混入了 `content_type`/`bookmark_count` 等 content 专属字段，选中会导致 SQL 报错（列不存在于 `uniscrm.user`）。加 `entity` 后按实体过滤即修复。

## 2. 后端：抽取共用 snapshot 查询 helper

`analytics/src/index.ts` 的 `buildSQL` 中，`type === "user"` 分支的 SQL 构建逻辑抽取为：

```ts
function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string {
  // 现有 user 分支的 measure/dimension(+buckets)/filters 逻辑，FROM 改为参数 tableName
}
```

- `"user"` 分支 → `buildSnapshotSQL("uniscrm.user", params, tenantId)`
- 新增 `"content"` 分支 → `buildSnapshotSQL("uniscrm.content", params, tenantId)`

`computeReport` 里结果汇总逻辑（`summary`）已经是按“非 interval/funnel 走通用 else 分支”写的，`content` 无需改动即可复用。

## 3. 前端：复用 user 模式的既有代码路径

- **`ReportConfig.tsx`**：`USER_PROPS`/`NUMERIC_USER_PROPS` 改为按 entity 参数化取值（`PROPS_X.filter(p => p.entity === entity && p.isInsight)`），`mode === "user"` 的 JSX 分支扩展为 `mode === "user" || mode === "content"`，根据 mode 决定传入 entity 为 `"user"` 还是 `"content"`。measure/dimension/bucket/filter UI 完全复用，不新写分支。
- **`AnalyticsList.tsx`**：`+New` 下拉新增 "Content Analysis" → 路由 `/analytics/content/new`；locale 新增 `content` 文案（中英）。
- **`AnalyticsDetail.tsx` / `App.tsx`**：`mode` 类型从 `"event" | "interval" | "user" | "funnel"` 扩展为 `... | "content"`；默认图表类型逻辑（`m === "user" ? "pie" : ...`）与结果渲染分支（`mode === "user" && ...` 的 pie/bar 渲染块）均扩展为 `mode === "user" || mode === "content"`，不新建渲染代码。`MODE_TITLES` 新增 `content` 标题文案。

## 4. 不需要的新基础设施

`uniscrm.content` R2 Data Catalog 表、stream、sink 均已在此前工作中创建完毕（见项目记忆 "content R2 pipeline"），本设计不涉及新建/修改 pipeline。

## 5. 测试

按仓库 CLAUDE.md 的 coding-agent 要求，在 `analytics/tests/` 中：
- 新增测试：`buildSnapshotSQL` 对 `uniscrm.user` 与 `uniscrm.content` 两种 tableName，分别验证 measure 变体（count/avg/sum）、dimension+buckets、filters 生成的 SQL 正确。
- 新增/review 测试：entity 过滤后 `PROPS_X` 的 user/content 子集不互相包含对方专属字段。

## Verification

1. 创建 Content Analysis 报表：measure=count，dimension=content_type，验证维度下拉只出现 content 专属字段（不含 is_follow/followers_count 等 user 专属字段）。
2. 反向验证 User Analysis 维度下拉不再出现 content_type/bookmark_count。
3. 报表计算完成后默认渲染为饼图，可切换柱状图（与 User Analysis 一致的 ChartTypeToggle 行为）。
4. `tsc --noEmit` 通过；新增测试用例通过。
