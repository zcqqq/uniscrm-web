# Condition AND/OR 逻辑切换 — 设计

**日期**：2026-07-31
**状态**：已确认，待写实现计划

## 目标

Flow 编辑器里所有 props condition 支持 AND / OR 切换，默认 AND。UI 为「Add」按钮左侧的紧凑分段控件。顺带把 5 个调用点收敛成真正的同一套代码（同一个组件、同一个标题、同一个后端 helper），而不只是长得像。

---

## 一、现状事实（全部经代码验证）

### 1.1 UI：一个共享组件，5 个调用点

`ConditionsEditor`（`flow/frontend/components/Inspector.tsx:82`）：

| 行号 | Inspector | 当前 `label` | 域 | 传 `systemFilters` |
|---|---|---|---|---|
| 263 | X Trigger（事件触发） | `Event Props` | user | 否 |
| 361 | X Content Trigger | `Condition` | content | 否 |
| 441 | YouTube Content Trigger | `Condition` | content | **是** |
| 535 | Wait For Event | *(默认 `Conditions`)* | user | 否 |
| 982 | YouTube Condition | `Condition` | content | 否 |

`label` 是个 prop，三种取值来自三处调用，是本次要消掉的分叉。

### 1.2 后端：三个求值点，全部硬编码 `.every()`

| 位置 | 场景 | conditions 来源 |
|---|---|---|
| `flow/src/engine.ts:239` | `executeFlow` 里的 trigger 节点（覆盖 xTrigger / cronTrigger / xContentTrigger / youtubeContentTrigger） | live graph |
| `flow/src/index.ts:1844` | `flow_pending` sweep，解析 Wait For Event | **D1 快照**（`flow_pending.conditions` 列） |
| `flow/src/youtube-condition.ts:123` | YouTube Condition | live graph |

三处的空 field 跳过写法各不相同但语义一致：`!c.field` 的条目不参与判定。

### 1.3 不在范围内

- `userPropsCondition` / `abSplit` 同样带 `data.conditions`，但**两者都不用 `ConditionsEditor`，且引擎里从未被求值**（`engine.ts:471`/`478` 只把它们 push 成 action，没有任何消费者）。这是既有的空洞，本次不碰。
- `content_flow_pending` 有 `conditions` 列且被写入，但从未被读取 —— content 域没有 waitForEvent 节点（`generate-prompt.ts:64` 明确排除）。因此不需要 migration。

### 1.4 系统级 filter 与本设计无关

`systemFilters`（YouTube Content Trigger 唯一使用，`Inspector.tsx:446`）来自 metadata 的 `contentPropsFilter`，由 **link 侧在入队前强制执行**（`passesPropsFilter`）。flow 引擎根本看不到它，结构上不可能被 AND/OR 开关影响。

---

## 二、决策

### D1 — 作用范围：全部 5 个调用点

**决定**：3 个 trigger + Wait For Event + YouTube Condition 全部支持切换。

**理由**：同一个组件在不同 Inspector 里长得不一样，用户会对着两块一模一样的 UI 猜哪块能切。要做例外就得加 prop 关掉开关，是往「同一套代码」的反方向走。

**否决**：只做 3 个 trigger（字面理解「trigger condition」）；只做 content flow 的 3 个。

### D2 — 删掉 `label` prop，统一为 `Condition`

**决定**：`ConditionsEditor` 不再接受 `label`，标题写死 `Condition`。X Trigger 的 `Event Props`、Wait For Event 的默认 `Conditions` 一并消失。

**理由**：用户明确要求「label 也统一成 Condition」。三种叫法描述的是同一件事。

### D3 — 存储：`data.conditionLogic`

**决定**：与 `data.conditions` 同级新增 `data.conditionLogic`。判定只认一个字面量：`=== "or"` 才是 OR，**缺省、`"and"`、以及任何畸形值（AI 生成的 `true` / `null` / 对象 / 数字）一律判定为 AND**。存量 graph 没有这个键，天然走 AND。用户显式点 AND 时写入 `"and"`（而非留空），让 `graph_json` 的读者看得出这是一个明确选择。

**理由**：存量 graph 零迁移，不需要给现有 flow 补字段；畸形值自然降级成今天的行为，而不是抛异常。判定写成 `logic === "or"` 这一个表达式，没有别的分支可以写错。

**否决**：始终写 `"and" | "or"`（要迁移存量，收益为零）。

### D4 — OR 且 0 条可用条件：全拦住 + publish 校验

**决定**：
- AND + 0 条 → 通过（与今天 `[].every() === true` 逐字一致，不变）
- OR + 0 条 → **拦住**（`[].some() === false`）
- publish 时拦下「logic 为 `or` 且可用条件为 0」的节点，不让它上线

**理由**：数学上 OR 的恒等元就是 false。纯语义拦住可能让一条 flow 静默死掉，所以配一条发布期校验把它挡在上线之前；已发布 flow 后来被 AI 重写成 0 条的情况校验挡不住，但那时语义拦住才是安全侧。

**否决**：全通过（同一个空节点 AND 全放行、OR 全拦死，而 UI 上只差一个小开关 —— 但用户选择了语义纯粹 + 发布校验的组合，认为静默放行比静默拦截更危险）。

### D5 — 控件形态：分段 `AND | OR`

**决定**：两个 `size="sm"` 的 `Toggle`（`shared/frontend/ui/toggle.tsx`）拼成分段控件，当前生效项高亮，位于 header 行「+ Add」左侧。各带 tooltip：`所有条件都满足才通过` / `任一条件满足即通过`。

**理由**：shadcn 的 `Switch` 是无字圆胶囊，看不出哪边是 AND。分段控件两个选项都可见，不存在「这个字是当前状态还是点了会变成的状态」的经典歧义。符合 CLAUDE.md「所有 icons 都要加 tooltip」。

**始终显示**，不因条件数 <2 隐藏。隐藏会造成陷阱：设了 OR → 删到 0 条 → 开关消失 → 卡在全拦住且无法改回。

### D6 — `stat_unavailable` 守卫不变

**决定**：`youtube-condition.ts:105-120` 逐字不改，与 logic 无关 —— 任一被引用字段在新鲜数据里缺失而在旧快照里存在，整个节点判 `failed`。

**知情代价**：OR 下，若条件 A 引用的字段已被作者隐藏、但条件 B 已经通过，本来能确定为 `true` 的情况会被当成故障丢掉。

**理由**：行为与今天逐字相同，AND/OR 两种模式下可预测性一致；符合「以稳定、安全、少改动为主」。

**否决**：先算 OR、算得出就不 failed（能判的不丢，但守卫要从「扫一遍就 return」改成与求值交织，多一层测试面）。

### D7 — AI 生成不教它 `conditionLogic`

**决定**：`flow/src/generate-prompt.ts` 与 `nodeTypeRegistry.ts` 的 `promptFragment` 不动。AI 生成的 graph 恒为 AND。

**理由**：安全侧默认，且少一个 AI 编出畸形 logic 值的入口。用户想要 OR 时在 UI 上点一下即可。

---

## 三、架构

### 3.1 共享 helper

`flow/src/engine.ts` 新增导出：

```ts
export const CONDITION_LOGIC_OR = "or";

export function conditionsPass(
  conditions: unknown,
  logic: unknown,
  payload: Record<string, unknown>
): boolean {
  const usable = (Array.isArray(conditions) ? conditions : []).filter(
    (c) => c && typeof c === "object" && String((c as { field?: unknown }).field ?? "") !== ""
  ) as { field: string; operator: string; value: string }[];
  const check = (c: { field: string; operator: string; value: string }) =>
    evaluateCondition(c.field, c.operator, String(c.value), payload);
  return logic === CONDITION_LOGIC_OR ? usable.some(check) : usable.every(check);
}
```

D4 的两条语义不用写特判 —— 各自落在语言的恒等元上（`[].some()` 为 `false`，`[].every()` 为 `true`）。

畸形值防护（`Array.isArray` 守卫 + 空 field 过滤）从三处各自的写法收进这一处，与前端 publish 校验的 `countUsableConditions`（`validate-flow-graph.ts:63`）判空口径逐字一致 —— 否则会出现「发布拦不住但运行时当没条件」的错位。

### 3.2 三个调用点改写

| 位置 | logic 取自 |
|---|---|
| `engine.ts:239` | `trigger.data.conditionLogic` |
| `youtube-condition.ts:123` | 由 `index.ts:893` 一带读出，随 conditions 传入 `resolveYouTubeCondition` |
| `index.ts:1844` | `pending.condition_logic`（D1 列，见 3.3） |

### 3.3 Wait For Event 需要一条 migration

Wait For Event 的 conditions 在建 wait 时**快照**进 `flow_pending.conditions`，resume 时从 D1 读，且发生在原子 claim（`index.ts:1852` 那个防重复投递的 DELETE）之前。

若 logic 改从 live graph 读，会出现「旧条件 + 新逻辑」—— 用户在等待期间编辑 flow 就踩中。所以 logic 必须跟 conditions 同源快照。

`flow/migrations/0016_flow_pending_condition_logic.sql`：

```sql
ALTER TABLE flow_pending ADD COLUMN condition_logic TEXT NOT NULL DEFAULT '';
```

空串 = AND，存量行自动正确。`engine.ts` 的 `PendingWait` 类型增加 `conditionLogic?: string`，所有 `INSERT INTO flow_pending` 语句带上该列。`content_flow_pending` 不动（1.3）。

### 3.4 前端

**`ConditionsEditor`**：
- 删除 `label` prop，标题写死 `Condition`
- 新增 `logic: string` 与 `onLogicChange: (logic: string) => void` 两个 prop
- header 行：`Condition` … `[AND|OR]` `+ Add`
- 当同时存在 `systemFilters` 与用户条件行时，两块之间插一行 muted 的 `and` 字样，避免开关看起来管着 🔒 行

**5 个调用点**：各自传 `logic={data.conditionLogic}` 与 `onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}`。

**节点卡片**：logic 为 `or` 且可用条件 ≥2 时加 `(any)` 后缀，AND 保持原样。卡片常是画布上唯一可见的信息，不标出来等于藏了一半语义。四个节点文案一致，第五个有既有分叉：

| 节点 | 现在 | OR 且 ≥2 条 |
|---|---|---|
| `XTriggerNode:45` / `XContentTriggerNode:32` / `YouTubeContentTriggerNode:29` / `YouTubeConditionNode:24` | `N conditions` | `N conditions (any)` |
| `WaitForEventNode:19` | `(N filters)` | `(N filters, any)` |

`WaitForEventNode` 另有一处既有不一致：它按 `conditions.length` 原始长度计数，没有像另外四个那样过滤掉 `!c.field` 的空行，所以一个刚点了「+ Add」还没选字段的空行会被算进去。顺手对齐成 `?.field` 过滤 —— 否则 `(any)` 的显示门槛（可用条件 ≥2）与它自己显示的数字对不上。

### 3.5 Publish 校验

`flow/frontend/lib/validate-flow-graph.ts` 新增：

```ts
export function findOrLogicEmptyNodeIds(nodes): string[]
```

覆盖 5 种带 condition 的节点类型，命中条件为 `conditionLogic === "or"` 且 `countUsableConditions(data.conditions) === 0`。

`validateFlowGraph` 返回值增加 `orLogicEmptyNodeIds`；`EditorPage.tsx` 的 Publish handler 增加第 4 类文案：`N 个节点选了 OR 但没有条件，无法发布`。既有的 YouTube Condition 空条件规则不变（它更严，不论 logic 都拦）。

---

## 四、测试

**新增 `flow/tests/unit/conditions-pass.test.ts`**：
- AND × {0 条、全空行、1 条真、1 条假、2 条一真一假、2 条全真}
- OR × {0 条 → false、全空行 → false、1 条真、1 条假、2 条一真一假 → true、2 条全假 → false}
- 畸形 `conditions`（对象 / null / 字符串）降级为 0 条
- 畸形 `logic`（`true` / `null` / `"OR"` 大写 / 数字）一律走 AND
- `$user.` 未解析引用在 OR 下的表现（该条为 false，不影响其他条）

**改 `flow/tests/unit/validate-flow-graph.test.ts`**：第 4 类校验；既有断言补 `orLogicEmptyNodeIds` 键。

**改 `flow/tests/unit/editor-dirty-tracking.test.ts`**：切换 AND/OR 走 `updateNodeData`，应标 Unsaved。

**改既有 trigger / youtube-condition 测试**：确认默认（无 `conditionLogic`）行为与改造前逐字一致。

**Wait For Event 快照测试**：建 wait 时写入 `condition_logic`，resume 时按快照值判定，不受 live graph 编辑影响。

---

## 五、部署

`npm run deploy:dev` 部署 flow 模块；migration 走 flow 模块的 D1（dev 与 prod 同步建列，prod 只 ADD COLUMN 不重建表，不破坏数据）。自测需在 `flow-dev.uni-scrm.com` 上验证，localhost 不算完成。
