# Condition AND/OR 逻辑切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flow 编辑器里所有 props condition 支持 AND / OR 切换（默认 AND），并把 5 个 UI 调用点与 3 个后端求值点收敛成真正的同一套代码。

**Architecture:** 一个字面量常量 `CONDITION_LOGIC_OR = "or"` 放在 `flow/nodeTypeRegistry.ts`（前后端都已在 import 它）；一个后端 helper `conditionsPass(conditions, logic, payload)` 取代三处硬编码 `.every()`；前端 `ConditionsEditor` 删掉 `label` prop、新增分段 AND|OR 控件，5 个调用点全部共用。Wait For Event 的逻辑必须跟它的条件一起快照进 `flow_pending`，因此有一条 migration。

**Tech Stack:** TypeScript、Cloudflare Workers、D1、React Flow、vitest（`@cloudflare/vitest-pool-workers`，跑在 workerd 里，**没有 DOM**）、shadcn/ui（Radix Toggle）。

**Spec:** `docs/superpowers/specs/2026-07-31-condition-and-or-logic-design.md`

## Global Constraints

- **判定只认一个字面量**：`logic === "or"` 才是 OR。缺省、`"and"`、`true`、`null`、`"OR"`（大写）、数字、对象 —— 全部走 AND。**任何畸形值都不许升级成异常**：一次抛出会逃出 `executeContentActions`，队列消息整条重试，这一批里已经执行过的 action 全部重跑（重复发帖 / 私信）。
- **空 field 的条件行不参与判定**，口径与前端 `countUsableConditions`（`flow/frontend/lib/validate-flow-graph.ts:63`）逐字一致。
- **AND + 0 条 = 通过；OR + 0 条 = 拦住。** 不写特判 —— `[].every()` 为 `true`、`[].some()` 为 `false`，两条语义各自落在语言的恒等元上。
- **`stat_unavailable` 守卫**（`flow/src/youtube-condition.ts:105-120`）逐字不改，与 logic 无关。
- **无 DOM 测试环境**：`@testing-library/react` 全仓库未安装，测试跑在 workerd 里没有 `document`。UI 逻辑必须抽成纯函数才能测。禁止为了测试去装 DOM 依赖（会改 `package.json` + `package-lock.json`，而其他 session 正在并发提交本仓库）。
- **前端不许 import `flow/src/engine.ts`** —— 会把整个引擎拖进前端 bundle。共享常量放 `flow/nodeTypeRegistry.ts`。
- **前端不用 inline CSS**，用 `shared/frontend/ui/` 下的组件。**所有 icons / 控件都要加 tooltip**。
- **git**：绝不 `git add -A` / `git add .`；绝不 `git stash`；每个 task 结束前必须提交自己的文件，不许跨 task 留在工作区（其他 session 的 commit 会把它们吸走）。只提交本 task 明确列出的文件。
- **不推 main**，全部留本地。
- **wrangler 用全局的**，不要 `npx wrangler`。部署只用 `npm run deploy:dev`。

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `flow/nodeTypeRegistry.ts` | 新增 `CONDITION_LOGIC_OR` / `CONDITION_LOGIC_AND` 两个常量（前后端唯一真相） | 1 |
| `flow/src/engine.ts` | 新增 `conditionsPass`；trigger 求值点改用它；`PendingWait` 加 `conditionLogic` | 1, 3 |
| `flow/src/youtube-condition.ts` | `resolveYouTubeCondition` 接受 logic | 2 |
| `flow/src/index.ts` | youtubeCondition 分发读 logic；`flow_pending` 4 处 INSERT 写 logic；sweep 读 logic | 2, 3 |
| `flow/migrations/0016_flow_pending_condition_logic.sql` | 新列 | 3 |
| `flow/frontend/lib/condition-logic.ts` | **新建**。两个纯函数：`conditionSummary`、`nextConditionLogic` | 4 |
| `flow/frontend/nodes/*.tsx`（5 个） | 卡片摘要标出 `· any` | 4 |
| `flow/frontend/components/Inspector.tsx` | `ConditionsEditor` 删 `label`、加分段控件；5 个调用点 | 5 |
| `flow/frontend/lib/validate-flow-graph.ts` | `findOrLogicEmptyNodeIds` | 6 |
| `flow/frontend/pages/EditorPage.tsx` | 第 4 类 publish 文案 | 6 |

---

## Task 1: `conditionsPass` helper + trigger 求值点

**Files:**
- Modify: `flow/nodeTypeRegistry.ts`（文件末尾追加常量）
- Modify: `flow/src/engine.ts:238-241`
- Test: `flow/tests/unit/conditions-pass.test.ts`（新建）

**Interfaces:**
- Produces: `CONDITION_LOGIC_OR = "or"`、`CONDITION_LOGIC_AND = "and"`（`flow/nodeTypeRegistry.ts`）；`conditionsPass(conditions: unknown, logic: unknown, payload: Record<string, unknown>): boolean`（`flow/src/engine.ts`）
- Consumes: 既有的 `evaluateCondition(field, operator, value, payload)`（`flow/src/engine.ts:166`）

- [ ] **Step 1: 在 `flow/nodeTypeRegistry.ts` 末尾追加共享常量**

放这里而不是 `engine.ts`：前端的 publish 校验也要判这个值，但前端不能 import engine（会把整个引擎拖进 bundle）。`CONTENT_X_TRIGGER_MODE_LIST_POSTS` 已经是这个模式，两侧都在 import 本文件。

```ts
// 条件组的连接词，存在节点的 data.conditionLogic 上。判定只认 CONDITION_LOGIC_OR 这一个
// 字面量：缺省（存量 graph 没这个键）、"and"、以及任何畸形值（AI 生成的 true / null /
// 对象 / 数字 / 大写 "OR"）一律走 AND —— 与本功能上线前的行为逐字相同。
// 前后端共用：后端 engine.ts 的 conditionsPass 与前端 validate-flow-graph.ts 的
// findOrLogicEmptyNodeIds 必须判同一个值，否则会出现"发布拦不住但运行时按别的语义跑"。
export const CONDITION_LOGIC_OR = "or";
export const CONDITION_LOGIC_AND = "and";
```

- [ ] **Step 2: 写失败的测试** — 新建 `flow/tests/unit/conditions-pass.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { conditionsPass } from "../../src/engine";
import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

const PAYLOAD = { like_count: 100, view_count: 5, name: "alice" };
const TRUE_COND = { field: "like_count", operator: ">", value: "50" };
const FALSE_COND = { field: "like_count", operator: ">", value: "500" };
const BLANK_COND = { field: "", operator: "==", value: "" };

describe("conditionsPass — AND（默认，与本功能上线前逐字相同）", () => {
  it("0 条通过：没有过滤器 = 全部放行", () => {
    expect(conditionsPass([], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("全是空行等同于 0 条，通过", () => {
    expect(conditionsPass([BLANK_COND, BLANK_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("一真一假 → false", () => {
    expect(conditionsPass([TRUE_COND, FALSE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(false);
  });

  it("全真 → true", () => {
    expect(conditionsPass([TRUE_COND, TRUE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("空行不参与判定，不会把一条真条件拖下水", () => {
    expect(conditionsPass([TRUE_COND, BLANK_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — OR", () => {
  it("0 条拦住：OR 的恒等元是 false", () => {
    expect(conditionsPass([], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("全是空行等同于 0 条，拦住", () => {
    expect(conditionsPass([BLANK_COND, BLANK_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("一真一假 → true", () => {
    expect(conditionsPass([FALSE_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });

  it("全假 → false", () => {
    expect(conditionsPass([FALSE_COND, FALSE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("空行不参与判定：一条真条件 + 一个空行仍然通过", () => {
    expect(conditionsPass([BLANK_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — 畸形输入一律降级，绝不抛异常", () => {
  // 抛出去会逃出 executeContentActions：队列消息整条重试，这一批里已经执行过的 action
  // 全部重跑一遍（重复发帖 / 私信）。
  it.each([
    ["对象", { field: "x" } as unknown],
    ["字符串", "like_count > 50" as unknown],
    ["null", null as unknown],
    ["undefined", undefined as unknown],
    ["数字", 5 as unknown],
  ])("conditions 是%s时降级为 0 条（AND 通过）", (_label, bad) => {
    expect(conditionsPass(bad, CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("conditions 是对象时 OR 同样降级为 0 条（拦住）", () => {
    expect(conditionsPass({ field: "x" }, CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("数组里混进非对象元素时只跳过那一项", () => {
    expect(conditionsPass([null, TRUE_COND, "junk", 7], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
    expect(conditionsPass([null, FALSE_COND, "junk"], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it.each([
    ["undefined（存量 graph 没有这个键）", undefined as unknown],
    ["'and'", "and" as unknown],
    ["大写 'OR'", "OR" as unknown],
    ["true", true as unknown],
    ["null", null as unknown],
    ["数字 1", 1 as unknown],
    ["对象", {} as unknown],
  ])("logic 是%s时走 AND", (_label, badLogic) => {
    // AND 下一真一假为 false；若误判成 OR 会是 true
    expect(conditionsPass([TRUE_COND, FALSE_COND], badLogic, PAYLOAD)).toBe(false);
    // AND 下 0 条为 true；若误判成 OR 会是 false
    expect(conditionsPass([], badLogic, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — $user. 未解析引用", () => {
  // engine 的 resolveStringValue 对无法解析的 $user.x 引用会让该条件短路成 false
  // （见 engine.ts 的 missingUserRef）。OR 下它只该拉低自己那一条，不该拖垮整组。
  const USER_REF_COND = { field: "like_count", operator: ">", value: "$user.followers_count" };

  it("OR 下未解析的 user 引用不影响另一条真条件", () => {
    expect(conditionsPass([USER_REF_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });

  it("AND 下未解析的 user 引用使整组不通过", () => {
    expect(conditionsPass([USER_REF_COND, TRUE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(false);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/conditions-pass.test.ts`
Expected: FAIL — `conditionsPass is not a function` / 导入错误。

- [ ] **Step 4: 实现 `conditionsPass`**

在 `flow/src/engine.ts` 里 `evaluateCondition` 函数**之后**（约 209 行后）插入。同时把文件顶部的 import 改成：

```ts
import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, CONDITION_LOGIC_OR } from "../nodeTypeRegistry";
```

```ts
export type Condition = { field: string; operator: string; value: string };

// 三处求值点共用：executeFlow 里的 trigger、flow_pending sweep 里的 waitForEvent、
// 以及 youtubeCondition。改这里就是三处一起改，不会再漂移。
//
// 空 field 的半成品行一律不参与判定 —— UI 的 "+ Add" 会先插一个空行，用户还没选字段时
// 它不该影响结果。这个口径与前端 publish 校验的 countUsableConditions
// （validate-flow-graph.ts）必须逐字一致，否则会出现"发布拦不住但运行时当没条件"。
//
// 可用条件为 0 时结果直接落在语言的恒等元上，不需要任何特判：
//   AND → [].every() === true  （没有过滤器 = 全部放行，与本功能上线前一致）
//   OR  → [].some()  === false （OR 的恒等元就是 false；这种节点由发布期校验挡住上线）
//
// conditions / logic 都收 unknown：AI 生成或手改的 graph 会带任意形状。这里必须把它们
// 全部降级成"没有条件 / AND"，绝不许升级成异常 —— 一次抛出会逃出 executeContentActions，
// 队列消息整条重试，这一批里已经执行过的 action 全部重跑（重复发帖 / 私信）。
export function conditionsPass(
  conditions: unknown,
  logic: unknown,
  payload: Record<string, unknown>
): boolean {
  const usable = (Array.isArray(conditions) ? conditions : []).filter(
    (c) => c && typeof c === "object" && String((c as { field?: unknown }).field ?? "") !== ""
  ) as Condition[];
  const check = (c: Condition) =>
    evaluateCondition(c.field, c.operator, String(c.value), payload);
  return logic === CONDITION_LOGIC_OR ? usable.some(check) : usable.every(check);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd flow && npx vitest run tests/unit/conditions-pass.test.ts`
Expected: PASS，全部用例绿。

- [ ] **Step 6: 把 trigger 求值点换成 helper**

`flow/src/engine.ts:238-241`，把

```ts
    const conditions = (trigger.data.conditions as { field: string; operator: string; value: string }[]) || [];
    const allPass = conditions.every((c) =>
      !c.field || evaluateCondition(c.field, c.operator, String(c.value), payload)
    );
```

替换为

```ts
    const allPass = conditionsPass(trigger.data.conditions, trigger.data.conditionLogic, payload);
```

- [ ] **Step 7: 跑整个 flow 测试套件**

Run: `cd flow && npm test`
Expected: 全绿。既有 trigger 测试全部不带 `conditionLogic`，因此走 AND，行为必须与改动前逐字相同 —— 任何一条既有用例变红都说明降级逻辑写错了，**不许改测试去迁就实现**。

- [ ] **Step 8: 提交**

```bash
git add flow/nodeTypeRegistry.ts flow/src/engine.ts flow/tests/unit/conditions-pass.test.ts
git commit -m "feat(flow): 条件组 AND/OR 求值 helper，trigger 侧接入"
```

---

## Task 2: YouTube Condition 接入

**Files:**
- Modify: `flow/src/youtube-condition.ts:75-127`
- Modify: `flow/src/index.ts:889-917`
- Test: `flow/tests/unit/youtube-condition.test.ts`（追加用例）

**Interfaces:**
- Consumes: `conditionsPass(conditions, logic, payload)`、`CONDITION_LOGIC_OR`（Task 1）
- Produces: `resolveYouTubeCondition(conditions, payload, resp, logic?)` —— **新参数追加在末尾且可选**，这样 11 处既有测试调用无需改动，正好充当"默认行为不变"的回归证明。

- [ ] **Step 1: 写失败的测试** — 在 `flow/tests/unit/youtube-condition.test.ts` 末尾追加

```ts
describe("resolveYouTubeCondition — AND/OR", () => {
  const FRESH = { view_count: "100", like_count: "5" };
  const STALE = { view_count: "1", like_count: "1" };
  const HIT = { field: "view_count", operator: ">", value: "50" };
  const MISS = { field: "like_count", operator: ">", value: "500" };

  it("不传 logic 时走 AND：一真一假 → false", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH });
    expect(r.branch).toBe("false");
  });

  it("logic 为 'or' 时一真一假 → true", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH }, "or");
    expect(r.branch).toBe("true");
  });

  it("logic 为 'or' 且全假 → false", () => {
    const r = resolveYouTubeCondition([MISS, MISS], STALE, { ok: true, props: FRESH }, "or");
    expect(r.branch).toBe("false");
  });

  it("logic 为 'or' 且 0 条 → false（AND 下同样输入是 true）", () => {
    expect(resolveYouTubeCondition([], STALE, { ok: true, props: FRESH }, "or").branch).toBe("false");
    expect(resolveYouTubeCondition([], STALE, { ok: true, props: FRESH }).branch).toBe("true");
  });

  it("畸形 logic 走 AND", () => {
    const r = resolveYouTubeCondition([HIT, MISS], STALE, { ok: true, props: FRESH }, true);
    expect(r.branch).toBe("false");
  });

  it("stat_unavailable 守卫与 logic 无关：OR 下另一条已通过，仍然 failed", () => {
    // 设计决策 D6：守卫逐字不改。like_count 在新鲜数据里缺失、旧快照里有 → 整个节点 failed，
    // 即便 view_count 那条在 OR 下已经足以判 true。
    const freshMissingLike = { view_count: "100" };
    const r = resolveYouTubeCondition(
      [HIT, MISS], { view_count: "1", like_count: "1" },
      { ok: true, props: freshMissingLike }, "or"
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toContain("stat_unavailable: like_count");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/youtube-condition.test.ts`
Expected: FAIL —— 「logic 为 'or' 时一真一假」得到 `"false"`（第 4 个参数被忽略）。

- [ ] **Step 3: 改 `resolveYouTubeCondition`**

`flow/src/youtube-condition.ts` 顶部 import 改为：

```ts
import { evaluateCondition, conditionsPass } from "./engine";
```

签名改为（新参数追加在末尾，见 Interfaces）：

```ts
export function resolveYouTubeCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: VideoStatsResponse,
  // 节点的 data.conditionLogic。收 unknown：AI 生成的 graph 会带任意形状。
  // 缺省 / 畸形一律走 AND，与本功能上线前逐字相同。
  logic?: unknown
): YouTubeConditionOutcome {
```

**`stat_unavailable` 守卫那一段（当前 104-120 行）一个字都不动** —— 它先于求值执行，与 logic 无关（设计决策 D6）。

最后的 return 改为：

```ts
  // AND/OR 与空 field 跳过全部收在 conditionsPass 里（engine.ts），与 trigger 侧同一份实现。
  return { branch: conditionsPass(conditions, logic, merged) ? "true" : "false", payload: merged };
}
```

同时删掉原来 122-125 行的 `const allPass = (conditions || []).every(...)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd flow && npx vitest run tests/unit/youtube-condition.test.ts`
Expected: PASS。11 处既有调用（3 个参数）继续绿 —— 它们证明默认行为未变。

- [ ] **Step 5: 分发处把 logic 读出来传进去**

`flow/src/index.ts:893-913`。把

```ts
      const rawConditions = graph.nodes.find((n) => n.id === nodeId)?.data?.conditions;
      const conditions = (Array.isArray(rawConditions) ? rawConditions : []) as
        { field: string; operator: string; value: string }[];
```

替换为

```ts
      const conditionNode = graph.nodes.find((n) => n.id === nodeId);
      const rawConditions = conditionNode?.data?.conditions;
      const conditions = (Array.isArray(rawConditions) ? rawConditions : []) as
        { field: string; operator: string; value: string }[];
      // 与 conditions 同一份 node data 读出来，两者必须同源，否则会出现"旧条件 + 新逻辑"。
      const conditionLogic = conditionNode?.data?.conditionLogic;
```

把 `resolveYouTubeCondition` 的调用（913 行）改为：

```ts
      const outcome = resolveYouTubeCondition(conditions, payload, resp, conditionLogic);
```

日志行（916 行）的 JSON 里追加 `logic`，放在 `withAuthor` 之后：

```ts
      console.log(JSON.stringify({ event: "content_condition_youtube", contentId, flowId: flowId || null, nodeId, branch: outcome.branch, ok: resp.ok, withAuthor, logic: conditionLogic === CONDITION_LOGIC_OR ? "or" : "and", reason: outcome.failureReason || resp.reason || null }));
```

`flow/src/index.ts` 顶部从 `../nodeTypeRegistry` 的 import 里加上 `CONDITION_LOGIC_OR`。若该文件尚未 import 本模块，新增一行：

```ts
import { CONDITION_LOGIC_OR } from "../nodeTypeRegistry";
```

- [ ] **Step 6: 跑整套测试**

Run: `cd flow && npm test`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add flow/src/youtube-condition.ts flow/src/index.ts flow/tests/unit/youtube-condition.test.ts
git commit -m "feat(flow): YouTube Condition 支持 AND/OR；stat_unavailable 守卫保持不变"
```

---

## Task 3: Wait For Event —— 逻辑与条件同源快照

**Files:**
- Create: `flow/migrations/0016_flow_pending_condition_logic.sql`
- Modify: `flow/src/engine.ts:23-28`（`PendingWait` 类型）、`:440-449`（waitForEvent 分支）
- Modify: `flow/src/index.ts` —— 4 处 `INSERT INTO flow_pending ... awaiting_event`（418、1821、2158、2211）与 1 处 sweep 读取（1833-1846）
- Test: `flow/tests/unit/wait-for-event-condition-logic.test.ts`（新建）

**Interfaces:**
- Consumes: `conditionsPass(conditions, logic, payload)`（Task 1）
- Produces: `PendingWait.conditionLogic?: string`；D1 列 `flow_pending.condition_logic TEXT NOT NULL DEFAULT ''`

**背景（实现者必读）**：Wait For Event 的条件在**建 wait 时快照**进 `flow_pending.conditions`，resume 时从 D1 读，且发生在原子 claim（`index.ts:1852` 那句防重复投递的 DELETE）**之前**。如果 logic 改从 live graph 读，用户在等待期间编辑 flow 就会造成「旧条件 + 新逻辑」。所以 logic 必须跟 conditions 一起快照。

**同批修掉的既有缺陷**：4 处 INSERT 里，`index.ts:2211`（`flow_pending` sweep 里重新排期 wait 的那一处）**完全没写 `conditions` 列**。重新排期后的 waitForEvent 会被任意匹配事件唤醒，用户设的条件全部失效。既然本 task 要逐处加 `condition_logic`，只补新列而放着旧列不管是不可接受的。

- [ ] **Step 1: 建 migration**

新建 `flow/migrations/0016_flow_pending_condition_logic.sql`：

```sql
-- flow_pending.conditions 是建 wait 时的快照（不是 live graph），resume 时在原子 claim 之前
-- 读取。AND/OR 逻辑必须与条件同源快照，否则用户在等待期间编辑 flow 会造成"旧条件 + 新逻辑"。
-- 空串 = AND（与缺省、"and"、任何畸形值同义），存量行自动正确，无需数据迁移。
ALTER TABLE flow_pending ADD COLUMN condition_logic TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2: 写失败的测试** — 新建 `flow/tests/unit/wait-for-event-condition-logic.test.ts`

`collectActions` 是模块私有的，所以走 `executeFlow` 这个公开入口构造出 pendingWait 再断言。

```ts
import { describe, it, expect } from "vitest";
import { executeFlow, conditionsPass, type FlowGraph } from "../../src/engine";
import { CONDITION_LOGIC_OR } from "../../nodeTypeRegistry";

function graphWithWait(waitData: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "w1", type: "waitForEvent", data: { eventType: "tweet.liked", duration: 3, unit: "days", ...waitData }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "w1" }],
  };
}

describe("waitForEvent 把 conditionLogic 一起快照进 PendingWait", () => {
  const COND = [{ field: "like_count", operator: ">", value: "5" }];

  it("节点上是 'or' 时带进 pendingWait", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits).toHaveLength(1);
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("节点上没有这个键时为空串（= AND），不是 undefined —— D1 列 NOT NULL", () => {
    const r = executeFlow(graphWithWait({ conditions: COND }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("");
  });

  it("0 条条件时依然带上 logic —— OR + 0 条是有语义的（拦住），不能丢", () => {
    const r = executeFlow(graphWithWait({ conditions: [], conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("畸形 logic 被规整成字符串，不会把非字符串塞进 D1 bind", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: { bad: 1 } }), "follow.followed", { channel_id: "chan1" });
    expect(typeof r.pendingWaits[0].conditionLogic).toBe("string");
  });
});

describe("resume 时按快照的 logic 判定", () => {
  // sweep 侧的行为等价于这一句：conditions 与 logic 都取自 flow_pending 的快照列。
  const PAYLOAD = { like_count: 100 };
  const HIT = { field: "like_count", operator: ">", value: "50" };
  const MISS = { field: "like_count", operator: ">", value: "500" };

  it("快照 logic 为 'or' 时一真一假放行", () => {
    expect(conditionsPass([HIT, MISS], "or", PAYLOAD)).toBe(true);
  });

  it("快照 logic 为空串时走 AND，一真一假不放行", () => {
    expect(conditionsPass([HIT, MISS], "", PAYLOAD)).toBe(false);
  });

  it("快照 logic 为 'or' 且条件列为空时不放行（等到超时走 no 分支）", () => {
    expect(conditionsPass([], "or", PAYLOAD)).toBe(false);
  });

  it("快照条件列是坏 JSON 时降级成 0 条，AND 下放行", () => {
    // sweep 里 JSON.parse 必须被 try 包住：抛出去会让整条队列消息重试。
    expect(conditionsPass([], "", PAYLOAD)).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/wait-for-event-condition-logic.test.ts`
Expected: FAIL —— `pendingWaits[0].conditionLogic` 是 `undefined`。

- [ ] **Step 4: `PendingWait` 加字段**

`flow/src/engine.ts:23-28`：

```ts
export interface PendingWait {
  nodeId: string;
  durationMs: number;
  awaitingEvent?: string;
  conditions?: { field: string; operator: string; value: string }[];
  // 与 conditions 同源快照，一起写进 flow_pending。等待期间用户改了 flow 的 AND/OR，
  // 不能让已经排期的旧条件套上新逻辑。空串 = AND。
  conditionLogic?: string;
}
```

- [ ] **Step 5: waitForEvent 分支带上 logic**

`flow/src/engine.ts:440-449`，把 `pendingWaits.push({...})` 那一句替换为：

```ts
      pendingWaits.push({
        nodeId: targetNode.id,
        durationMs: durationToMs(duration, unit),
        awaitingEvent,
        conditions: conditions.length > 0 ? conditions : undefined,
        // 无条件带上：OR + 0 条是有语义的（恒不通过），丢了会让它在 resume 时被当成 AND 放行。
        // String() 规整畸形值——D1 的 bind 不接受对象。
        conditionLogic: String(targetNode.data.conditionLogic ?? ""),
      });
```

- [ ] **Step 6: 跑测试确认前半部分通过**

Run: `cd flow && npx vitest run tests/unit/wait-for-event-condition-logic.test.ts`
Expected: PASS。

- [ ] **Step 7: 4 处 INSERT 写入新列**

`flow/src/index.ts` 的 418、1821、2158 三处形状相同：SQL 的列清单末尾加 `, condition_logic`，`VALUES` 的占位符加一个 `?`，`.bind(...)` 末尾加 `wait.conditionLogic || ""`。

例（418 行那处改完后）：

```ts
        `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(), flowId || "", wait.nodeId, userId, tenantId,
        JSON.stringify(payload || {}), new Date(Date.now() + wait.durationMs).toISOString(),
        new Date().toISOString(), wait.awaitingEvent || "",
        wait.conditions ? JSON.stringify(wait.conditions) : "",
        wait.conditionLogic || ""
      ).run();
```

第 4 处（2211 行）**同时补上遗漏的 `conditions` 列**（见本 task 开头的「同批修掉的既有缺陷」）。整句替换为：

```ts
            env.FLOW_DB.prepare(
              // conditions 与 condition_logic 都必须写：此前这一处只写 awaiting_event，
              // 于是 sweep 里重新排期的 waitForEvent 会被任意匹配事件唤醒，用户设的条件
              // 全部失效。其余三处 INSERT 一直是写的，只有这里漏了。
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(), row.flow_id, wait.nodeId, row.user_id, row.tenant_id, row.payload,
              executeAt, now, wait.awaitingEvent || "",
              wait.conditions ? JSON.stringify(wait.conditions) : "",
              wait.conditionLogic || ""
            )
```

- [ ] **Step 8: sweep 读取改用 helper**

`flow/src/index.ts:1834` 的 SELECT 列清单加上 `condition_logic`，类型参数同步加 `condition_logic: string`：

```ts
        const pendingMatches = await env.FLOW_DB.prepare(
          `SELECT id, flow_id, node_id, user_id, tenant_id, payload, conditions, condition_logic FROM flow_pending
           WHERE user_id = ? AND awaiting_event = ? AND execute_at > ?`
        )
          .bind(userId, eventType, new Date().toISOString())
          .all<{ id: string; flow_id: string; node_id: string; user_id: string; tenant_id: string; payload: string; conditions: string; condition_logic: string }>();
```

1841-1846 的条件检查整段替换为：

```ts
        for (const pending of pendingMatches.results) {
          // conditions 与 logic 都取自建 wait 时的快照，不看 live graph——等待期间用户改了
          // flow，不能让旧条件套上新逻辑。
          // JSON.parse 必须被 try 包住：坏 JSON 抛出去会让整条队列消息重试，把这一批里
          // 已经执行过的 action 全部重跑。降级成"没有条件"是可接受的最坏情况，崩溃不是。
          let snapshotConditions: unknown = [];
          try {
            snapshotConditions = pending.conditions ? JSON.parse(pending.conditions) : [];
          } catch {
            snapshotConditions = [];
          }
          // 不再用 `if (pending.conditions)` 做前置守卫：OR + 0 条恒不通过是有语义的，
          // 跳过检查会把它错当成放行。conditionsPass 自己处理空集。
          if (!conditionsPass(snapshotConditions, pending.condition_logic, payload)) continue;
```

`flow/src/index.ts` 顶部第 4 行的 engine import 里加上 `conditionsPass`。

- [ ] **Step 9: 跑整套测试**

Run: `cd flow && npm test`
Expected: 全绿。

- [ ] **Step 10: 在 dev 与 prod 两个 D1 上都建列**

dev 建资源时必须同步建 prod 版本（本项目已两次因为漏 prod 翻车）。`ALTER TABLE ... ADD COLUMN` 不重建表、不动数据，prod 上执行是安全的。

```bash
cd flow
wrangler d1 migrations apply uniscrm-flow-dev --remote
wrangler d1 migrations apply uniscrm-flow --remote
```

用 `wrangler`（全局），不要 `npx wrangler`。执行后核对两边都有新列：

```bash
wrangler d1 execute uniscrm-flow-dev --remote --command "PRAGMA table_info(flow_pending)"
wrangler d1 execute uniscrm-flow --remote --command "PRAGMA table_info(flow_pending)"
```

Expected: 两次输出都含 `condition_logic`。

- [ ] **Step 11: 提交**

```bash
git add flow/migrations/0016_flow_pending_condition_logic.sql flow/src/engine.ts flow/src/index.ts flow/tests/unit/wait-for-event-condition-logic.test.ts
git commit -m "feat(flow): Wait For Event 的 AND/OR 与条件同源快照；补回 sweep 重排期时丢失的 conditions 列"
```

---

## Task 4: 前端纯函数 + 节点卡片摘要

**Files:**
- Create: `flow/frontend/lib/condition-logic.ts`
- Modify: `flow/frontend/nodes/XTriggerNode.tsx:9-10,44-45`
- Modify: `flow/frontend/nodes/XContentTriggerNode.tsx:8-9,31-32`
- Modify: `flow/frontend/nodes/YouTubeContentTriggerNode.tsx:8-9,28-29`
- Modify: `flow/frontend/nodes/YouTubeConditionNode.tsx:8-9,24`
- Modify: `flow/frontend/nodes/WaitForEventNode.tsx:17-20`
- Test: `flow/tests/unit/condition-logic.test.ts`（新建）

**Interfaces:**
- Consumes: `CONDITION_LOGIC_OR`、`CONDITION_LOGIC_AND`（Task 1，`flow/nodeTypeRegistry.ts`）
- Produces: `conditionSummary(count: number, logic: unknown): string`、`nextConditionLogic(current: unknown, clicked: string): string | null`（`flow/frontend/lib/condition-logic.ts`）—— Task 5 会用 `nextConditionLogic`

- [ ] **Step 1: 写失败的测试** — 新建 `flow/tests/unit/condition-logic.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { conditionSummary, nextConditionLogic } from "../../frontend/lib/condition-logic";
import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

describe("conditionSummary", () => {
  it("单数不加 s", () => {
    expect(conditionSummary(1, CONDITION_LOGIC_AND)).toBe("1 condition");
  });

  it("复数加 s", () => {
    expect(conditionSummary(2, CONDITION_LOGIC_AND)).toBe("2 conditions");
  });

  it("OR 且 ≥2 条时标出 · any", () => {
    expect(conditionSummary(2, CONDITION_LOGIC_OR)).toBe("2 conditions · any");
    expect(conditionSummary(5, CONDITION_LOGIC_OR)).toBe("5 conditions · any");
  });

  it("OR 但只有 1 条时不标 —— 此时 AND/OR 结果完全相同，标出来只是噪音", () => {
    expect(conditionSummary(1, CONDITION_LOGIC_OR)).toBe("1 condition");
  });

  it("logic 缺省 / 畸形一律不标", () => {
    expect(conditionSummary(3, undefined)).toBe("3 conditions");
    expect(conditionSummary(3, "OR")).toBe("3 conditions");
    expect(conditionSummary(3, true)).toBe("3 conditions");
  });
});

describe("nextConditionLogic", () => {
  it("点已生效的那一段返回 null —— 不该产生一次没有实质改动的 Unsaved", () => {
    // 否则用户点一下当前高亮项就被标脏，按 Back 时被问"要不要保存"，而他什么都没改。
    expect(nextConditionLogic(CONDITION_LOGIC_OR, CONDITION_LOGIC_OR)).toBeNull();
    expect(nextConditionLogic(CONDITION_LOGIC_AND, CONDITION_LOGIC_AND)).toBeNull();
  });

  it("缺省态（存量 graph 没这个键）视同 AND，点 AND 返回 null", () => {
    expect(nextConditionLogic(undefined, CONDITION_LOGIC_AND)).toBeNull();
  });

  it("缺省态点 OR 返回 'or'", () => {
    expect(nextConditionLogic(undefined, CONDITION_LOGIC_OR)).toBe("or");
  });

  it("OR 点 AND 返回 'and'", () => {
    expect(nextConditionLogic(CONDITION_LOGIC_OR, CONDITION_LOGIC_AND)).toBe("and");
  });

  it("畸形 current 视同 AND", () => {
    expect(nextConditionLogic(true, CONDITION_LOGIC_AND)).toBeNull();
    expect(nextConditionLogic("OR", CONDITION_LOGIC_OR)).toBe("or");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/condition-logic.test.ts`
Expected: FAIL —— 模块 `frontend/lib/condition-logic` 不存在。

- [ ] **Step 3: 建 `flow/frontend/lib/condition-logic.ts`**

```ts
import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

// 节点卡片上的条件摘要。卡片常是画布上唯一可见的信息，不标出 OR 等于藏了一半语义。
// 只在 ≥2 条时标：1 条时 AND 与 OR 结果完全相同，标出来只是噪音；0 条时卡片本来就不显示这一行。
export function conditionSummary(count: number, logic: unknown): string {
  const base = `${count} condition${count > 1 ? "s" : ""}`;
  return logic === CONDITION_LOGIC_OR && count >= 2 ? `${base} · any` : base;
}

// 分段控件被点击时该写入什么。返回 null 表示不写 —— 点的是当前已生效的那一段，
// 没有实质改动。不这样做的话，点一下当前高亮项就会 updateNodeData 把 flow 标成 Unsaved，
// 用户按 Back 时被问"要不要保存"，而他什么都没改。
// current 收 unknown：存量 graph 没有这个键，AI 生成的 graph 可能是任意形状。
export function nextConditionLogic(current: unknown, clicked: string): string | null {
  const normalized = current === CONDITION_LOGIC_OR ? CONDITION_LOGIC_OR : CONDITION_LOGIC_AND;
  return clicked === normalized ? null : clicked;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd flow && npx vitest run tests/unit/condition-logic.test.ts`
Expected: PASS。

- [ ] **Step 5: 四个卡片接入**

`XTriggerNode.tsx`、`XContentTriggerNode.tsx`、`YouTubeContentTriggerNode.tsx` 三个文件：顶部加

```tsx
import { conditionSummary } from "../lib/condition-logic";
```

把渲染那一行（分别是 45 / 32 / 29 行）里的

```tsx
{condCount} condition{condCount > 1 ? "s" : ""}
```

替换为

```tsx
{conditionSummary(condCount, data.conditionLogic)}
```

`YouTubeConditionNode.tsx` 第 24 行同样：

```tsx
{condCount === 0 ? "No conditions" : conditionSummary(condCount, data.conditionLogic)}
```

- [ ] **Step 6: `WaitForEventNode` 对齐口径并接入**

`flow/frontend/nodes/WaitForEventNode.tsx:17-19`。它此前按 `conditions.length` 原始长度计数，没像另外四个卡片那样过滤 `!c.field` 的空行 —— 一个刚点了「+ Add」还没选字段的空行会被算进去，且 `(any)` 的显示门槛（可用条件 ≥2）会与它显示的数字对不上。顺带把 "filters" 的措辞统一成 "conditions"。

顶部加 `import { conditionSummary } from "../lib/condition-logic";`，然后：

```tsx
  const conditions = (data.conditions as unknown[]) || [];
  // 与另外四个卡片同一口径：空 field 的半成品行不计数（"+ Add" 会先插一个空行）。
  const condCount = conditions.filter((c: any) => c?.field).length;
  const timeStr = duration ? ` within ${duration} ${unit}` : "";
  const condStr = condCount > 0 ? ` (${conditionSummary(condCount, data.conditionLogic)})` : "";
```

- [ ] **Step 7: 类型检查 + 跑整套测试**

Run: `cd flow && npx tsc --noEmit && npm test`
Expected: 无类型错误，测试全绿。

- [ ] **Step 8: 提交**

```bash
git add flow/frontend/lib/condition-logic.ts flow/frontend/nodes/XTriggerNode.tsx flow/frontend/nodes/XContentTriggerNode.tsx flow/frontend/nodes/YouTubeContentTriggerNode.tsx flow/frontend/nodes/YouTubeConditionNode.tsx flow/frontend/nodes/WaitForEventNode.tsx flow/tests/unit/condition-logic.test.ts
git commit -m "feat(flow): 节点卡片标出 OR 语义；WaitForEvent 卡片对齐条件计数口径"
```

---

## Task 5: `ConditionsEditor` —— 删 label、加分段控件、5 个调用点统一

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`（`ConditionsEditor` 定义 82-189；调用点 263、361、441、535、982）

**Interfaces:**
- Consumes: `nextConditionLogic(current, clicked)`（Task 4）、`CONDITION_LOGIC_OR` / `CONDITION_LOGIC_AND`（Task 1）
- Produces: `ConditionsEditor` 新签名 —— **不再接受 `label`**，新增 `logic: unknown` 与 `onLogicChange: (logic: string) => void`

**注意**：本 task 没有单元测试 —— 全仓库没有 `@testing-library/react`，测试跑在 workerd 里没有 `document`（见 Global Constraints）。可测的判定逻辑已在 Task 4 抽成纯函数并测过。本 task 靠 `tsc --noEmit` 与 Task 7 的浏览器实测验证。**不许为了测它去装 DOM 依赖。**

- [ ] **Step 1: 加 import**

`flow/frontend/components/Inspector.tsx` 顶部：

```tsx
import { Toggle } from "../../../shared/frontend/ui/toggle";
import { nextConditionLogic } from "../lib/condition-logic";
```

并在既有的 `../../nodeTypeRegistry` import 里加上 `CONDITION_LOGIC_OR, CONDITION_LOGIC_AND`。

- [ ] **Step 2: 新增分段控件组件**

插在 `ConditionsEditor`（82 行）**之前**：

```tsx
// 分段控件而不是 shadcn 的 Switch：Switch 是个无字圆胶囊，看不出哪边是 AND。两个选项都
// 可见、当前生效项高亮，不存在"这个字是当前状态还是点了会变成的状态"的经典歧义。
// 始终显示，不因条件数 <2 隐藏——隐藏会造成陷阱：设了 OR → 删到 0 条 → 开关消失 →
// 卡在恒不通过且无法改回。
function ConditionLogicToggle({
  logic,
  onChange,
}: {
  logic: unknown;
  onChange: (logic: string) => void;
}) {
  const isOr = logic === CONDITION_LOGIC_OR;
  const click = (clicked: string) => {
    const next = nextConditionLogic(logic, clicked);
    if (next !== null) onChange(next);
  };
  return (
    <TooltipProvider>
      <div className="inline-flex rounded border border-input overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={!isOr}
              onPressedChange={() => click(CONDITION_LOGIC_AND)}
              className="h-6 px-1.5 text-[10px] rounded-none"
            >
              AND
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>所有条件都满足才通过</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              pressed={isOr}
              onPressedChange={() => click(CONDITION_LOGIC_OR)}
              className="h-6 px-1.5 text-[10px] rounded-none"
            >
              OR
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>任一条件满足即通过</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
```

- [ ] **Step 3: 改 `ConditionsEditor` 签名与 header**

82-96 行的签名改为（**`label` 整个删掉**）：

```tsx
function ConditionsEditor({
  conditions,
  fields,
  onChange,
  logic,
  onLogicChange,
  systemFilters,
}: {
  conditions: Condition[];
  fields: TriggerFieldDefinition[];
  onChange: (conditions: Condition[]) => void;
  // 节点的 data.conditionLogic。收 unknown：存量 graph 没这个键。
  logic: unknown;
  onLogicChange: (logic: string) => void;
  // 系统级 contentPropsFilter（metadata 声明、link 端入队前强制执行）。这里只做展示——
  // 不进 data.conditions（避免 graph_json 快照过期阈值、污染用户可编辑数组），值实时读 metadata。
  systemFilters?: PropFilter[];
}) {
```

107-110 行的 header 替换为：

```tsx
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs">Condition</Label>
        <div className="flex items-center gap-2">
          <ConditionLogicToggle logic={logic} onChange={onLogicChange} />
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={addCondition}>+ Add</Button>
        </div>
      </div>
```

- [ ] **Step 4: 系统级 filter 与用户条件之间插一行 `and`**

`systemFilters` 由 link 在入队前强制执行，flow 引擎根本看不到它，结构上不可能被 AND/OR 开关影响。但开关在 header、🔒 行在它正下方，看着像归它管。在 `systemFilters?.map(...)` 那个块（111-136 行）**之后**、`conditions.length === 0` 那个空态提示（137 行）**之前**插入：

```tsx
      {systemFilters?.length && conditions.length > 0 ? (
        // 🔒 行由 link 在入队前强制执行，永远是无条件的与关系，不受上面那个 AND/OR 开关影响。
        <p className="text-[10px] text-muted-foreground mb-2">and</p>
      ) : null}
```

- [ ] **Step 5: 5 个调用点统一**

每一处都**删掉 `label={...}`**，并加上两个新 prop。5 处的 `nodeId` 变量名在各自 Inspector 里已存在。

263 行（X Trigger，原 `label="Event Props"`）、361 行（X Content Trigger，原 `label="Condition"`）、441 行（YouTube Content Trigger，原 `label="Condition"`）、535 行（Wait For Event，原无 label）、982 行（YouTube Condition，原 `label="Condition"`）—— 全部加：

```tsx
            logic={data.conditionLogic}
            onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
```

若某个 Inspector 里承载节点 data 的变量不叫 `data`，用它自己的那个名字读 `.conditionLogic`；`updateNodeData` 在 5 个 Inspector 里均已可用。

- [ ] **Step 6: 确认再没有别的地方传 label**

Run: `cd flow && grep -n "label=" frontend/components/Inspector.tsx | grep -i "props\|condition"`
Expected: 无输出（`label` prop 已彻底移除）。

Run: `cd flow && grep -rn "Event Props\|Content Props" frontend/`
Expected: 无输出。

- [ ] **Step 7: 类型检查 + 构建 + 跑测试**

Run: `cd flow && npx tsc --noEmit && npx vite build --mode development && npm test`
Expected: 无类型错误，构建成功，测试全绿。

- [ ] **Step 8: 提交**

```bash
git add flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): ConditionsEditor 统一为 Condition 并内置 AND|OR 分段控件"
```

---

## Task 6: Publish 校验

**Files:**
- Modify: `flow/frontend/lib/validate-flow-graph.ts`
- Modify: `flow/frontend/pages/EditorPage.tsx:106-128`
- Test: `flow/tests/unit/validate-flow-graph.test.ts`（追加用例；既有严格 `toEqual` 断言需补新键）

**Interfaces:**
- Consumes: `CONDITION_LOGIC_OR`（Task 1）；既有的 `countUsableConditions`（同文件 63 行，私有）
- Produces: `findOrLogicEmptyNodeIds(nodes): string[]`；`validateFlowGraph` 返回值新增 `orLogicEmptyNodeIds: string[]`

- [ ] **Step 1: 写失败的测试** — 在 `flow/tests/unit/validate-flow-graph.test.ts` 末尾追加

```ts
import { findOrLogicEmptyNodeIds } from "../../frontend/lib/validate-flow-graph";
import { CONDITION_LOGIC_OR } from "../../nodeTypeRegistry";

describe("findOrLogicEmptyNodeIds", () => {
  const OR = CONDITION_LOGIC_OR;
  const REAL = [{ field: "view_count", operator: ">", value: "10" }];
  const BLANK = [{ field: "", operator: "==", value: "" }];

  it("OR + 空数组 → 命中", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "xContentTrigger", data: { conditions: [], conditionLogic: OR } },
    ])).toEqual(["n1"]);
  });

  it("OR + 全是空行 → 命中（与运行时口径一致）", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "waitForEvent", data: { conditions: BLANK, conditionLogic: OR } },
    ])).toEqual(["n1"]);
  });

  it("OR + 非数组 conditions → 命中", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "youtubeCondition", data: { conditions: { bad: 1 }, conditionLogic: OR } },
    ])).toEqual(["n1"]);
  });

  it("OR + 有真条件 → 不命中", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "xTrigger", data: { conditions: REAL, conditionLogic: OR } },
    ])).toEqual([]);
  });

  it("AND + 空条件 → 不命中：AND 的 0 条恒通过，是合法常态", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "xTrigger", data: { conditions: [] } },
      { id: "n2", type: "xTrigger", data: { conditions: [], conditionLogic: "and" } },
    ])).toEqual([]);
  });

  it("非 condition 节点即使带了这两个字段也不命中", () => {
    expect(findOrLogicEmptyNodeIds([
      { id: "n1", type: "action", data: { conditions: [], conditionLogic: OR } },
      { id: "n2", type: "abSplit", data: { conditions: [], conditionLogic: OR } },
    ])).toEqual([]);
  });

  it("5 种 condition 节点全覆盖", () => {
    const types = ["xTrigger", "xContentTrigger", "youtubeContentTrigger", "waitForEvent", "youtubeCondition"];
    const nodes = types.map((t, i) => ({ id: `n${i}`, type: t, data: { conditions: [], conditionLogic: OR } }));
    expect(findOrLogicEmptyNodeIds(nodes)).toEqual(types.map((_, i) => `n${i}`));
  });

  it("没有 data 的节点不炸", () => {
    expect(findOrLogicEmptyNodeIds([{ id: "n1", type: "xTrigger" }])).toEqual([]);
  });
});

describe("validateFlowGraph 返回第 4 类", () => {
  it("OR 空条件节点使 valid 为 false 并出现在 orLogicEmptyNodeIds", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger", data: { conditions: [], conditionLogic: CONDITION_LOGIC_OR } },
    ];
    const r = validateFlowGraph(nodes, []);
    expect(r.valid).toBe(false);
    expect(r.orLogicEmptyNodeIds).toEqual(["t1"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: FAIL —— `findOrLogicEmptyNodeIds is not a function`；另有既有的严格 `toEqual` 用例因返回对象多了一个键而红。

- [ ] **Step 3: 实现校验**

`flow/frontend/lib/validate-flow-graph.ts` 顶部加：

```ts
import { CONDITION_LOGIC_OR } from "../../nodeTypeRegistry";
```

在 `countUsableConditions`（63-68 行）**之后**插入：

```ts
// 带 props condition 的 5 种节点，与 Inspector 里用 ConditionsEditor 的 5 个调用点一一对应。
// userPropsCondition / abSplit 也有 data.conditions，但它们既不用 ConditionsEditor、引擎里
// 也从未被求值（engine.ts 只把它们 push 成 action，没有消费者），加进来只会挡住一个本就无效
// 的节点。
const CONDITION_NODE_TYPES = [
  "xTrigger",
  "xContentTrigger",
  "youtubeContentTrigger",
  "waitForEvent",
  "youtubeCondition",
];

// OR 且一条可用条件都没有 = 恒不通过（[].some() === false），整条 flow 静默死掉，而画布上
// 完全看不出异常——AND 的 0 条恒通过是合法常态，两者在 UI 上只差一个小开关。所以挡在上线之前。
export function findOrLogicEmptyNodeIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => CONDITION_NODE_TYPES.includes(n.type ?? ""))
    .filter((n) => n.data?.conditionLogic === CONDITION_LOGIC_OR)
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}
```

`validateFlowGraph`（70-91 行）改为：

```ts
export function validateFlowGraph(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[],
  edges: { source: string; target: string }[]
): {
  valid: boolean;
  orphanNodeIds: string[];
  misplacedNodeIds: string[];
  emptyConditionNodeIds: string[];
  orLogicEmptyNodeIds: string[];
} {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  const emptyConditionNodeIds = findEmptyYouTubeConditionIds(nodes);
  const orLogicEmptyNodeIds = findOrLogicEmptyNodeIds(nodes);
  return {
    valid:
      orphanNodeIds.length === 0 &&
      misplacedNodeIds.length === 0 &&
      emptyConditionNodeIds.length === 0 &&
      orLogicEmptyNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
    emptyConditionNodeIds,
    orLogicEmptyNodeIds,
  };
}
```

- [ ] **Step 4: 修既有的严格断言**

`flow/tests/unit/validate-flow-graph.test.ts` 里用 `toEqual` 整对象比较 `validateFlowGraph` 返回值的既有用例，补上 `orLogicEmptyNodeIds: []`。**只补键，不放宽断言**——这些用例各自在测自己的意图，不许改成 `toMatchObject` 蒙混过关。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: PASS。

- [ ] **Step 6: EditorPage 第 4 类文案**

`flow/frontend/pages/EditorPage.tsx:106-128`。解构与高亮：

```tsx
          const { valid, orphanNodeIds, misplacedNodeIds, emptyConditionNodeIds, orLogicEmptyNodeIds } =
            validateFlowGraph(nodes, edges);
          // Always resolve against the current graph first, so a second Publish click
          // after a partial fix doesn't compound a stale highlight from the first click.
          useFlowEditor
            .getState()
            .setErrorNodeIds([...orphanNodeIds, ...misplacedNodeIds, ...emptyConditionNodeIds, ...orLogicEmptyNodeIds]);
```

文案选择改为（在既有三类之上插第 3 优先级）：

```tsx
            // 四类错误的修法完全不同（连线 / 填条件 / 改回 AND / 换 trigger），文案必须分开，
            // 否则用户会对着一个连得好好的节点找"哪里没连上"。孤儿优先——它更常见也更基础。
            // 「换 trigger」的文案不能说成"需要 YouTube Trigger"：这一条在"图里有两个
            // trigger、其中一个正是 YouTube Trigger"时也会触发，那样会把人打发去找一个
            // 明明已经在那儿的节点。
            const title =
              orphanNodeIds.length > 0
                ? `${orphanNodeIds.length} 个节点未连接，无法发布`
                : emptyConditionNodeIds.length > 0
                  ? `YouTube Condition 没有设置条件，无法发布`
                  : orLogicEmptyNodeIds.length > 0
                    ? `${orLogicEmptyNodeIds.length} 个节点选了 OR 但没有条件，无法发布`
                    : `YouTube Condition 只能用在唯一 trigger 是 YouTube Trigger 的流程里，无法发布`;
```

- [ ] **Step 7: 类型检查 + 构建 + 跑整套测试**

Run: `cd flow && npx tsc --noEmit && npx vite build --mode development && npm test`
Expected: 无类型错误，构建成功，测试全绿。

- [ ] **Step 8: 提交**

```bash
git add flow/frontend/lib/validate-flow-graph.ts flow/frontend/pages/EditorPage.tsx flow/tests/unit/validate-flow-graph.test.ts
git commit -m "feat(flow): 选了 OR 却没有条件的节点阻止发布"
```

---

## Task 7: 部署 dev 并在浏览器实测

**Files:** 无（仅部署与验证）

localhost 的验证不算完成 —— 必须在 `flow-dev.uni-scrm.com` 上跑通。

- [ ] **Step 1: 跑完整测试套件**

Run: `cd flow && npm test`
Expected: 全绿。记下总用例数。

- [ ] **Step 2: 部署到 dev**

Run: `cd flow && npm run deploy:dev`

必须走这个 script（它先 `vite build --mode development` 再 `wrangler deploy --env dev`）。手工敲 `wrangler deploy --env dev` 会跳过前端构建、发一个旧前端上去；不带 `--env dev` 会打到 PROD 并剥掉 bindings。

Expected: 输出 Version ID，记录下来。

- [ ] **Step 3: 确认 D1 新列已在 dev 生效**

Run: `wrangler d1 execute uniscrm-flow-dev --remote --command "PRAGMA table_info(flow_pending)"`
Expected: 输出含 `condition_logic`。（Task 3 Step 10 已建；这里是部署后复核。）

- [ ] **Step 4: 浏览器验证 —— 复用已登录的真实 session**

先 `tabs_context_mcp` 拿到用户现有标签页，复用已登录的 Chrome session；不要凭空造 e2e 账号。若 `*-dev` 登录页显示 session 过期，直接点 "Continue with Google"（用户已授权）。

打开 `https://flow-dev.uni-scrm.com/`，逐条确认：

1. **label 已统一**：打开一条 user flow，点 X Trigger 节点 —— Inspector 里条件区标题是 `Condition`，不再是 `Event Props`。点 Wait For Event 节点 —— 同样是 `Condition`，不再是 `Conditions`。
2. **控件在位**：`Condition` 标题右侧依次是 `[AND|OR]` 分段控件和 `+ Add`；默认 `AND` 高亮。悬停两段分别显示 tooltip「所有条件都满足才通过」「任一条件满足即通过」。
3. **点当前段不脏**：在一条**已保存**的 flow 上点当前高亮的 `AND` —— 顶栏**不出现** `Unsaved`。
4. **切换标脏**：点 `OR` —— `OR` 高亮，顶栏出现 `Unsaved`。
5. **卡片摘要**：给该节点加 2 条真条件并选 OR，画布上卡片显示 `2 conditions · any`；切回 AND 显示 `2 conditions`。
6. **publish 校验**：新建一条 content flow，拖入 YouTube Trigger，把它的条件清空并选 OR，点 Publish —— 节点描红、**不跳转**、toast 显示「1 个节点选了 OR 但没有条件，无法发布」。

toast 淡出比工具往返快，用 `browser_batch` 把点击与截图放在同一次调用里捕获。

- [ ] **Step 5: 确认被拦下的 publish 没有落库**

Run:
```bash
wrangler d1 execute uniscrm-flow-dev --remote --command "SELECT COUNT(*) AS n FROM flows WHERE name='Untitled Flow' AND created_at > '2026-07-31T00:00:00Z'"
```
Expected: `n: 0`（校验拦下时不该创建 flow）。

- [ ] **Step 6: 确认工作区干净**

Run: `git status --short`
Expected: 只剩其他 session 的文件，本计划涉及的文件全部已提交。

---

## Self-Review

**Spec 覆盖**：D1（作用范围 5 个）→ Task 5；D2（删 label 统一 Condition）→ Task 5 Step 3/5/6；D3（`data.conditionLogic` 判定口径）→ Task 1 Step 1/4；D4（OR + 0 条拦住 + publish 校验）→ Task 1 Step 4（语义）+ Task 6（校验）；D5（分段控件、始终显示、tooltip）→ Task 5 Step 2；D6（`stat_unavailable` 不变）→ Task 2 Step 3 明确禁止改动 + 一条断言它的测试；D7（AI 生成不教）→ 无任务，计划中不触碰 `generate-prompt.ts` / `promptFragment`。3.1 helper → Task 1；3.2 三个调用点 → Task 1 Step 6、Task 2 Step 5、Task 3 Step 8；3.3 migration → Task 3；3.4 前端 → Task 4、5；3.5 publish 校验 → Task 6；第四节测试 → 各 task 内；第五节部署 → Task 7。无缺口。

**计划外增补（已在 Task 3 显式说明理由）**：`index.ts:2211` 丢失 `conditions` 列的既有缺陷，在同一批 INSERT 语句里一并修掉。

**类型一致性**：`conditionsPass(conditions, logic, payload)` 三处调用参数序一致；`resolveYouTubeCondition` 新参数追加在末尾且可选，11 处既有测试调用无需改；`conditionSummary(count, logic)` / `nextConditionLogic(current, clicked)` 在 Task 4 定义、Task 4 Step 5-6 与 Task 5 Step 2 消费，名称一致；`CONDITION_LOGIC_OR` / `CONDITION_LOGIC_AND` 单一来源 `flow/nodeTypeRegistry.ts`，被 `engine.ts`、`index.ts`、`condition-logic.ts`、`validate-flow-graph.ts`、`Inspector.tsx` 与各测试 import。
