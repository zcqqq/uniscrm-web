# Content Flow 条件支持 User Props — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 content flow 的条件除内容字段外还能判断**内容作者**的字段，从而写出 `like_count > $user.followers_count * 0.01` 这类相对指标。

**Architecture:** 作者数据跟着内容一起进 flow payload（X 走零成本的 `expansions`，YouTube 走 `channels.list`），键统一加 `user.` 前缀构成真命名空间，避开 `like_count`/`view_count` 在内容侧与作者侧的必然撞名。求值层 `$user.x` **严格**解析 `payload["user.x"]`、绝不降级到裸键；存量 user flow 靠 payload 双写保持兼容。判定逻辑（`evaluateCondition`/`evaluateExpr`）一行不改。

**Tech Stack:** TypeScript / Cloudflare Workers / Hono / vitest（`@cloudflare/vitest-pool-workers`）/ React

**Spec:** `docs/superpowers/specs/2026-07-29-content-flow-user-props-design.md`

## Global Constraints

- 数据准确性 > 系统稳定性 > 功能 > UI界面。以稳定、安全、少改动为主，不要贪快。
- **`user.` 前缀严格解析，任何情况下都不得降级到裸键。** 降级会在作者数据缺失时静默命中内容侧的同名字段（`$user.view_count` → 视频自己的播放量），给出看似合理的错误答案。
- **绝不用缺失/过期的数据猜 `true`/`false`。** 取不到一律走 `failed`（有分支的节点）或 fail-closed 不通过（无分支的 trigger）。
- **调用外部 API 返回的 payload 全量数据不要存在数据库中，存在日志中即可。** `failureReason` 会一路写进 `content_flow_log` 这张分析表，必须有界（只含端点名 + HTTP 状态码）。
- 元数据驱动：字段映射只写在 `/metadata/`，代码里不得按 trigger 类型硬判断"哪个源有作者字段"。
- 命名空间前缀常量 `USER_PROP_PREFIX = "user."` 定义在 `metadata/dataTypes.ts`，link / flow / 前端一律 import，不得各写各的字面量。
- 前端不用 inline CSS，全部组件化；所有 icons 都要加上 tooltip 文字。
- 只有明确说 push to main 时才提交到 main branch；dev 环境用本地 wrangler cli 部署测试。
- 部署只用 `npm run deploy:dev`（裸 `wrangler deploy` 会打到 PROD 并剥掉 bindings；手跑 `--env dev` 会跳过 vite build 发出过期前端）。
- **禁止 `git add -A` / `git add .`**：工作树里有其它 session 未提交的文件（`shared/frontend/Sidebar.tsx`、`shared/frontend/sidebar-state.ts`、`web/tests/unit/sidebar-state.test.ts`）。每次 commit 只 `git add` 本任务列出的文件。禁止 `git stash`。
- 不用 worktree。

## 不做（明确排除）

- `is_follow` / `is_followed`（需回查我们自己的库，另立项）。
- X `own:get-posts`、TikTok 的作者字段；`fetchPostsPage` 不动。
- user flow 的**字段列表**改动（只改 payload 双写）。
- trigger 级的失败日志形态。
- payload 嵌套命名空间。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `metadata/dataTypes.ts` | `ContentMetadata.userProps` 类型 + `USER_PROP_PREFIX` 常量 | 2 |
| `metadata/x-byok.ts` | `get-list-posts` 的作者字段映射 | 2 |
| `metadata/youtube.ts` | `watch:get-videos` 的作者字段映射 | 2 |
| `flow/src/engine.ts` | `$ref` 解析规则：`user.` 严格、`event.` 剥离 | 1 |
| `link/src/webhook.ts` | user flow payload 双写（裸键 + `user.` 键） | 1 |
| `link/src/services/pollers/resolve-props.ts` | `resolveAuthorProps`：加前缀的唯一一处 | 2 |
| `flow/frontend/config/trigger-fields.ts` | 条件字段列表追加作者字段（限定 id） | 3 |
| `shared/frontend/components/SelectPropsValue.tsx` | 插入表达式时不重复拼前缀 | 3 |
| `link/src/services/x-posts-api.ts` | list posts 请求加 `expansions`，按 id 索引作者 | 4 |
| `link/src/services/pollers/x-list-posts.ts` | 按 `author_id` 匹配作者并并入 payload | 4 |
| `link/src/services/youtube-api.ts` | `fetchChannelDetails` | 5 |
| `link/src/services/pollers/youtube-content.ts` | 暴露 `authorChannelId`；`fetchYouTubeAuthorProps`；ingest 并入 | 5 |
| `link/src/routes-internal.ts` | `/youtube/video-stats` 的 `withAuthor`；`boundedYouTubeReason` | 6 |
| `flow/src/youtube-condition.ts` | `conditionsNeedAuthor`；请求带 `withAuthor` | 7 |
| `flow/src/index.ts` | 派发时计算 `withAuthor` | 7 |

---

## Task 1: 求值层 `user.` 严格解析 + user flow payload 双写

**为什么合成一个任务：** 单独改 `engine.ts` 会立刻打断存量 user flow 里所有 `$user.x` 写法；双写是它的必要配套，评审时也不可能只批准其中一半。

**Files:**
- Modify: `flow/src/engine.ts:52-63`（`resolveValue`）、`flow/src/engine.ts:115-122`（`resolveStringValue`）
- Modify: `link/src/webhook.ts:71-87`（`flattenUserPayload`）
- Create: `flow/tests/unit/prop-ref-resolution.test.ts`
- Modify: `link/tests/webhook.test.ts`（新增一个 case）

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `flow/src/engine.ts` 内部常量 `PROP_REF_RE = /\$((?:event\.|user\.)?\w+)/g` 与 `lookupPropRef(ref: string, payload: Record<string, unknown>): unknown`（不导出，仅本文件内两处共用）
  - 解析契约：`$event.x` → 查 `payload["x"]`；`$user.x` → 查 `payload["user.x"]`；`$x` → 查 `payload["x"]`。后续任务全部依赖这个契约。
  - user flow 的 FLOW_QUEUE payload 同时含裸键与 `user.` 键。

- [ ] **Step 1: 写失败测试**

创建 `flow/tests/unit/prop-ref-resolution.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../../src/engine";

describe("$ref 解析：event. 剥离 / user. 严格", () => {
  it("$event.x 仍按裸键解析（存量 user flow 写法）", () => {
    const payload = { followers_count: 500, following_count: 100 };
    expect(evaluateCondition("followers_count", ">", "$event.following_count", payload)).toBe(true);
  });

  it("$x 按裸键解析", () => {
    const payload = { followers_count: 500, following_count: 100 };
    expect(evaluateCondition("followers_count", ">", "$following_count", payload)).toBe(true);
  });

  it("$user.x 命中 user. 键（双写后的 user flow payload）", () => {
    const payload = { followers_count: 500, "user.followers_count": 500, like_count: 10 };
    expect(evaluateCondition("like_count", "<", "$user.followers_count", payload)).toBe(true);
  });

  it("payload 没有 user. 键时，$user.x 不得降级命中同名裸键", () => {
    // 这是 D6 的坑：content flow 里作者数据抓取失败（配额耗尽/作者被封）时 payload
    // 不带 user.*，若降级，$user.view_count 会命中这个视频自己的播放量，条件照常
    // 求值并给出一个看似合理的错误答案。
    const payload = { like_count: 100, view_count: 5000 };
    expect(evaluateCondition("like_count", ">", "$user.view_count * 0.01", payload)).toBe(false);
  });

  it("撞名：内容侧与作者侧的 like_count 各取各的", () => {
    const payload = { like_count: 10, "user.like_count": 90000 };
    expect(evaluateCondition("like_count", ">", "100", payload)).toBe(false);
    expect(evaluateCondition("user.like_count", ">", "100", payload)).toBe(true);
  });

  it("目标表达式：点赞数 > 作者粉丝数的 1%", () => {
    const hit = { like_count: 150, "user.followers_count": 10000 };
    const miss = { like_count: 50, "user.followers_count": 10000 };
    expect(evaluateCondition("like_count", ">", "$user.followers_count * 0.01", hit)).toBe(true);
    expect(evaluateCondition("like_count", ">", "$user.followers_count * 0.01", miss)).toBe(false);
  });

  it("字符串算子同样走新规则", () => {
    const payload = { content_text: "hello mkbhd", "user.name": "mkbhd", name: "someone else" };
    expect(evaluateCondition("content_text", "contains", "$user.name", payload)).toBe(true);
  });
});
```

在 `link/tests/webhook.test.ts` 的 `describe("webhookRoutes POST /webhook — follow events / resolveEventConsumedPaths")` 块内追加：

```ts
  it("发给 FLOW_QUEUE 的 payload 同时含裸键与 user. 键", async () => {
    const env = baseEnv();
    const app = buildApp();

    await post(app, {
      data: {
        event_type: "follow.follow",
        filter: { user_id: "x-user-1" },
        payload: {
          source: { data: { id: "x-user-1" } },
          target: {
            data: {
              id: "target-1", name: "Target", username: "target_h",
              public_metrics: { followers_count: 10, following_count: 2 },
              verified_type: "blue",
            },
          },
        },
      },
    }, env);

    expect(env.FLOW_QUEUE.send).toHaveBeenCalledTimes(1);
    const [msg] = (env.FLOW_QUEUE.send as any).mock.calls[0];
    // 裸键：存量条件的 cond.field 写的是裸 propId
    expect(msg.payload.followers_count).toBe(10);
    // user. 键：存量条件的值里写的是 $user.followers_count，flow 侧现在严格解析
    expect(msg.payload["user.followers_count"]).toBe(10);
    expect(msg.payload["user.name"]).toBe("Target");
  });
```

> 实现者注意：`FLOW_QUEUE.send` 在 `webhook.ts:237` 被 `if (tenantId)` 门住，而 `tenantId` 来自频道查询。若该文件的 `baseEnv()` 没让频道查询返回 `tenant_id`，这个 case 会因为 `send` 从未被调用而失败 —— 那是 harness 缺配置，不是实现问题：给频道查询补上 `tenant_id`，不要改被测代码。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test -- tests/unit/prop-ref-resolution.test.ts
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test -- tests/webhook.test.ts
```

预期：flow 的「$user.x 命中 user. 键」「不得降级」「撞名」「目标表达式」「字符串算子」失败（`user.` 被剥离后查裸键）；link 的新 case 失败（`user.followers_count` 是 `undefined`）。

- [ ] **Step 3: 改 `flow/src/engine.ts`**

在 `resolveValue` 上方新增共用的正则与查键函数：

```ts
// `$event.x` / `$user.x` / `$x` 三种引用形式。
//
// event. 是纯装饰前缀：剥掉后查裸键。它没有任何带点号的对应键，剥了无害，也让存量
// user flow 的写法继续有效。
//
// user. 则是**真命名空间**：content flow 的 payload 里作者字段的键就是
// "user.<propId>"（link 的 resolveAuthorProps 统一加的），与内容侧同名的
// like_count / view_count 靠它区分——两侧含义完全不同（推文被点赞数 vs 作者点过多少赞；
// 视频播放量 vs 频道历史总播放量）。
//
// 所以 user. **严格**解析，绝不降级到裸键：作者数据取不到时（配额耗尽、作者被封）
// payload 不带 user.*，一降级 $user.view_count 就会命中这个视频自己的播放量，条件照常
// 求值并给出一个看似合理的错误答案。严格解析下它取到 undefined，按 fail-closed 不通过。
// user flow 的 payload 由 link 的 flattenUserPayload 双写裸键与 user. 键，所以存量
// $user.x 写法在那边照常命中。
const PROP_REF_RE = /\$((?:event\.|user\.)?\w+)/g;

function lookupPropRef(ref: string, payload: Record<string, unknown>): unknown {
  const key = ref.startsWith("event.") ? ref.slice("event.".length) : ref;
  return payload[key];
}
```

把 `resolveValue` 的替换体改为：

```ts
  const expr = value.replace(PROP_REF_RE, (_, ref: string) => {
    const v = lookupPropRef(ref, payload);
    if (v === undefined || v === null) return "NaN";
    return String(Number(v));
  });
```

把 `resolveStringValue` 的替换体改为：

```ts
  return value.replace(PROP_REF_RE, (_, ref: string) => {
    const v = lookupPropRef(ref, payload);
    if (v === undefined || v === null) return "";
    return String(v);
  });
```

两个函数的其余部分（`if (!value.includes("$")) return ...`、`if (expr.includes("NaN")) return null;`、`return evaluateExpr(expr);`）逐字不动。

- [ ] **Step 4: 改 `link/src/webhook.ts` 的 `flattenUserPayload`**

```ts
function flattenUserPayload(userData?: Record<string, unknown>): Record<string, unknown> {
  if (!userData) return {};
  const pm = userData.public_metrics as Record<string, unknown> | undefined;
  const bare: Record<string, unknown> = {
    name: String(userData.name || ""),
    username: String(userData.username || ""),
    verified_type: String(userData.verified_type || (userData.verified ? "blue" : "none")),
    followers_count: Number(pm?.followers_count || 0),
    following_count: Number(pm?.following_count || 0),
    // propId is post_count; tweet_count is X's name for the same field. Flow evaluates
    // conditions by propId, so emitting X's name here made "Posts" conditions never match.
    post_count: Number(pm?.tweet_count || 0),
    listed_count: Number(pm?.listed_count || 0),
    like_count: Number(pm?.like_count || 0),
    media_count: Number(pm?.media_count || 0),
  };
  // 裸键 + "user." 键双写。flow 的 evaluateCondition 现在对 $user.x 严格查 "user.x"、
  // 不再降级到裸键（见 flow/src/engine.ts 的 PROP_REF_RE 注释）。存量已发布 user flow
  // 的条件字段写的是裸名、值里写的是 $user.名，两种写法都必须继续命中，所以两份都发。
  // 调用方在本函数返回后追加的键（如 DM 的 message_text）是 eventProp、不是 userProp，
  // 不需要 user. 孪生键。
  const out: Record<string, unknown> = { ...bare };
  for (const [k, v] of Object.entries(bare)) out[`user.${k}`] = v;
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
```

预期：两个模块全绿。特别确认 `flow/tests/unit/engine.test.ts` 与 `link/tests/webhook.test.ts` 的既有 case 无回归。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add flow/src/engine.ts flow/tests/unit/prop-ref-resolution.test.ts link/src/webhook.ts link/tests/webhook.test.ts
git commit -m "feat(flow): \$user. 前缀改为真命名空间，严格解析不降级

内容侧与作者侧有 like_count/view_count 等同名 propId，扁平共用一个 key 空间
会让条件静默取到错的那个。user. 严格查 payload[\"user.x\"]；降级到裸键会在
作者数据缺失时命中内容侧同名字段，给出看似合理的错误答案。event. 仍剥离。
user flow payload 双写裸键与 user. 键以保存量条件两种写法都命中。"
```

---

## Task 2: metadata 声明作者字段 + `resolveAuthorProps`

**Files:**
- Modify: `metadata/dataTypes.ts`（`ContentMetadata` 加 `userProps?`；新增 `USER_PROP_PREFIX`）
- Modify: `metadata/index.ts`（导出 `USER_PROP_PREFIX`）
- Modify: `metadata/x-byok.ts`（`get-list-posts` 加 `userProps`）
- Modify: `metadata/youtube.ts`（`watch:get-videos` 加 `userProps`）
- Modify: `link/src/services/pollers/resolve-props.ts`（新增 `resolveAuthorProps`）
- Create: `link/tests/services/pollers/resolve-author-props.test.ts`

**Interfaces:**
- Consumes: Task 1 的解析契约（`user.` 键即 `$user.x` 的查找目标）
- Produces:
  - `metadata/dataTypes.ts`：`export const USER_PROP_PREFIX = "user.";`
  - `ContentMetadata.userProps?: PropMapping[]`
  - `link/src/services/pollers/resolve-props.ts`：`export function resolveAuthorProps(author: Record<string, unknown>, userProps: PropMapping[]): Record<string, unknown>`
  - `ContentMetadata_X` 的 `get-list-posts`、`ContentMetadata_YouTube` 的 `watch:get-videos` 各带一份 `userProps`；其余条目**不带**。

- [ ] **Step 1: 写失败测试**

创建 `link/tests/services/pollers/resolve-author-props.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolveAuthorProps } from "../../../src/services/pollers/resolve-props";
import { ContentMetadata_X } from "../../../../metadata/x-byok";
import { ContentMetadata_YouTube } from "../../../../metadata/youtube";

const X_LIST = ContentMetadata_X.find((m) => m.sourceContentType === "get-list-posts")!;
const YT = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

describe("resolveAuthorProps", () => {
  it("每个键都加上 user. 前缀", () => {
    const author = {
      id: "author-1", name: "MKBHD", username: "mkbhd",
      description: "tech", profile_image_url: "https://x/img", verified_type: "blue",
      public_metrics: { followers_count: 10000, following_count: 5, tweet_count: 300, listed_count: 20, like_count: 90000, media_count: 40 },
    };
    const props = resolveAuthorProps(author, X_LIST.userProps!);
    expect(props["user.source_user_id"]).toBe("author-1");
    expect(props["user.followers_count"]).toBe(10000);
    expect(props["user.post_count"]).toBe(300);
    expect(props["user.like_count"]).toBe(90000);
    // 裸键一个都不能有——否则会覆盖内容侧的同名字段
    expect(Object.keys(props).every((k) => k.startsWith("user."))).toBe(true);
  });

  it("API 没返回的字段不写占位键", () => {
    const props = resolveAuthorProps({ id: "a1" }, X_LIST.userProps!);
    expect(props["user.source_user_id"]).toBe("a1");
    expect("user.followers_count" in props).toBe(false);
  });

  it("YouTube 频道对象映射到同一批 propId", () => {
    const channel = {
      id: "UC123",
      snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t" } } },
      statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
    };
    const props = resolveAuthorProps(channel, YT.userProps!);
    expect(props["user.source_user_id"]).toBe("UC123");
    expect(props["user.name"]).toBe("Chan");
    expect(props["user.followers_count"]).toBe("1000000");
    expect(props["user.post_count"]).toBe("700");
    expect(props["user.view_count"]).toBe("5000000000");
  });
});

describe("ContentMetadata.userProps 的声明范围", () => {
  it("只有 get-list-posts 和 watch:get-videos 声明作者字段", () => {
    const withAuthor = [...ContentMetadata_X, ...ContentMetadata_YouTube]
      .filter((m) => m.userProps && m.userProps.length > 0)
      .map((m) => m.sourceContentType)
      .sort();
    expect(withAuthor).toEqual(["get-list-posts", "watch:get-videos"]);
  });

  it("X 的作者字段不含 is_followed", () => {
    // UserMetadata_X 里它是写死的 { value: 1 }（那份 metadata 是给「拉自己的粉丝列表」
    // 用的），照抄会让每个列表作者恒等于"我的粉丝"，静默且恒真。
    expect(X_LIST.userProps!.some((p) => p.propId === "is_followed")).toBe(false);
  });

  it("作者字段全部只有 dataId、没有写死的 value", () => {
    for (const m of [X_LIST, YT]) {
      for (const p of m.userProps!) {
        expect(p.value, `${m.sourceContentType}/${p.propId}`).toBeUndefined();
        expect(p.dataId, `${m.sourceContentType}/${p.propId}`).toBeTruthy();
      }
    }
  });

  it("作者字段的 dataId 不使用 {linkPrefix}", () => {
    // userProps 的 dataId 相对「作者对象」本身，与 contentProps 的 linkPrefix 无关。
    for (const m of [X_LIST, YT]) {
      for (const p of m.userProps!) {
        expect(p.dataId!.includes("{linkPrefix}"), `${m.sourceContentType}/${p.propId}`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test -- tests/services/pollers/resolve-author-props.test.ts
```

预期：`resolveAuthorProps` 不存在，导入即失败。

- [ ] **Step 3: 改 `metadata/dataTypes.ts`**

在文件顶部（`PropDataType` 定义之后）新增：

```ts
// 作者字段在 flow payload 里的命名空间前缀。内容侧的键是裸 propId，作者侧是
// "user.<propId>"——两边有 like_count / view_count 等同名 propId 且含义完全不同
// （推文被点赞数 vs 作者点过多少赞；视频播放量 vs 频道历史总播放量），扁平共用一个
// key 空间会让条件静默取到错的那个。
// 前缀只在 link 的 resolveAuthorProps 一处施加，metadata 里的 propId 保持干净。
// flow 侧 evaluateCondition 对 $user.x 严格查这个键，不降级（flow/src/engine.ts）。
export const USER_PROP_PREFIX = "user.";
```

`ContentMetadata` 接口末尾新增字段：

```ts
export interface ContentMetadata {
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  sourceContentType: string;
  flowType?: string; //trigger or action or content
  price?: number; //价格/官方费用
  label?: LocalizedString;
  description?: LocalizedString;
  contentProps: PropMapping[];
  contentPropsFilter?: PropFilter[]; // 全部通过才发content trigger事件（link端入队前评估，被拦内容不计flow entered）
  // 内容**作者**的字段。dataId 相对「作者对象」本身，**不走 contentProps 的 linkPrefix**
  // ——作者对象来自另一个响应：X 要按 item.author_id 从 includes.users[] 数组里匹配
  // （不是一条路径能表达的），YouTube 干脆来自另一次 channels.list 调用。由调用方先取出
  // 作者对象，再交给 resolveAuthorProps（它统一加 USER_PROP_PREFIX 前缀）。
  // 不声明 = 该内容源的条件里没有作者字段，前端字段列表与 payload 逐字不变。
  userProps?: PropMapping[];
}
```

- [ ] **Step 4: 改 `metadata/index.ts` 导出常量**

在已有的 `export type { ... } from "./dataTypes";` 之后新增一行值导出：

```ts
export { USER_PROP_PREFIX } from "./dataTypes";
```

- [ ] **Step 5: 改 `metadata/x-byok.ts`**

在 `ContentMetadata_X` 的 `get-list-posts` 条目里，`contentProps` 数组之后新增：

```ts
    // 作者字段：X API v2 的 expansions 不额外计费也不额外消耗调用配额，作者对象与推文在
    // 同一个响应的 includes.users[] 里（见 x-posts-api.ts 的 fetchListPostsPage）。
    // dataId 相对作者对象本身，不带 {linkPrefix}。
    // 不含 is_followed：UserMetadata_X 里它是写死的 { value: 1 }（那份 metadata 是给
    // 「拉自己的粉丝列表」用的，拉到的当然都是粉丝），照抄会让每个列表作者恒等于"我的
    // 粉丝"。X 的 user 对象里也没有这个信息——"你有没有关注他"只存在于我们自己的库里。
    userProps: [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
      { propId: "description", dataId: "description" },
      { propId: "profile_image_url", dataId: "profile_image_url" },
      { propId: "verified_type", dataId: "verified_type" },
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "post_count", dataId: "public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "public_metrics.listed_count" },
      { propId: "like_count", dataId: "public_metrics.like_count" },
      { propId: "media_count", dataId: "public_metrics.media_count" },
    ],
```

- [ ] **Step 6: 改 `metadata/youtube.ts`**

在 `ContentMetadata_YouTube` 的 `watch:get-videos` 条目里，`contentPropsFilter` 之后新增：

```ts
    // 作者（频道）字段：来自 channels.list?part=snippet,statistics 的一条 item
    // （videos.list 的 snippet 只白送 channelId/channelTitle，订阅数必须另打一次，
    // 1 unit）。dataId 相对那条 item 本身，不带 {linkPrefix}。
    // view_count 是频道历史总播放量，与内容侧 view_count（这个视频的播放量）同名但含义
    // 不同——靠 USER_PROP_PREFIX 命名空间区分，同一次请求白送，故声明。
    userProps: [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "snippet.title" },
      { propId: "username", dataId: "snippet.customUrl" },
      { propId: "description", dataId: "snippet.description" },
      { propId: "profile_image_url", dataId: "snippet.thumbnails.default.url" },
      { propId: "followers_count", dataId: "statistics.subscriberCount" },
      { propId: "post_count", dataId: "statistics.videoCount" },
      { propId: "view_count", dataId: "statistics.viewCount" },
    ],
```

- [ ] **Step 7: 改 `link/src/services/pollers/resolve-props.ts`**

在 `resolveProps` 之后新增（并把 `USER_PROP_PREFIX` 加进顶部 import）：

```ts
import { USER_PROP_PREFIX } from "../../../../metadata/dataTypes";
```

```ts
// 作者对象 → flow payload 用的作者字段，键统一加 USER_PROP_PREFIX。
// **加前缀的唯一一处**：内容侧与作者侧有 like_count / view_count 等同名 propId，含义
// 完全不同，扁平共用一个 key 空间会让条件静默取到错的那个。metadata 里的 propId 保持
// 干净，前缀是在这里施加的命名空间规则（不是逐字段改名——那才是「propId ≠ field name」
// 那条教训禁止的东西）。
// `author` 是调用方已经取出来的作者对象本身（X：includes.users[] 里按 author_id 匹配到
// 的那条；YouTube：channels.list 的一条 item），所以不传 linkPrefix。
export function resolveAuthorProps(
  author: Record<string, unknown>,
  userProps: PropMapping[]
): Record<string, unknown> {
  const resolved = resolveProps(author, userProps);
  const out: Record<string, unknown> = {};
  for (const [propId, value] of Object.entries(resolved)) {
    out[USER_PROP_PREFIX + propId] = value;
  }
  return out;
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test
```

预期：两个模块全绿。flow 侧特别确认 `tests/unit/content-trigger-fields.test.ts` 与 `tests/unit/trigger-fields.test.ts` 无回归（本任务还没改字段列表，`userProps` 只是多了一个未被读取的可选字段）。

- [ ] **Step 9: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add metadata/dataTypes.ts metadata/index.ts metadata/x-byok.ts metadata/youtube.ts \
        link/src/services/pollers/resolve-props.ts \
        link/tests/services/pollers/resolve-author-props.test.ts
git commit -m "feat(metadata): ContentMetadata 增加 userProps + resolveAuthorProps

只有 get-list-posts 与 watch:get-videos 声明作者字段；其余内容源不声明，行为
逐字不变。userProps 的 dataId 相对作者对象本身、不走 linkPrefix——作者对象来自
另一个响应（X 的 includes.users[] 需按 author_id 匹配，YouTube 来自另一次调用）。
resolveAuthorProps 是加 user. 前缀的唯一一处。X 侧不含 is_followed（那是写死的
value:1，照抄会让每个列表作者恒等于我的粉丝）。"
```

---

## Task 3: 前端条件字段列表追加作者字段

**Files:**
- Modify: `flow/frontend/config/trigger-fields.ts:120-130`（`getContentTriggerFields`）
- Modify: `shared/frontend/components/SelectPropsValue.tsx:87`（插入前缀）
- Modify: `flow/tests/unit/content-trigger-fields.test.ts`（新增 case）

**Interfaces:**
- Consumes: Task 2 的 `USER_PROP_PREFIX`、`ContentMetadata.userProps`
- Produces: `getContentTriggerFields` 返回的作者字段 `id` 为限定名 `"user.<propId>"`、`group` 为 `"user"`；`label` 仍是 prop 自己的标签。后续无任务依赖。

- [ ] **Step 1: 写失败测试**

在 `flow/tests/unit/content-trigger-fields.test.ts` 末尾追加：

```ts
describe("getContentTriggerFields — 作者字段", () => {
  it("X List Posts 的作者字段 id 是限定名、group 是 user", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const followers = fields.find((f) => f.id === "user.followers_count");
    expect(followers).toBeDefined();
    expect(followers!.group).toBe("user");
    // label 保持 prop 自己的标签，靠 SelectPropsValue 的分组标题区分
    expect(followers!.label).not.toContain("user.");
    expect(followers!.dataType).toBe("number");
  });

  it("内容侧与作者侧的 like_count 是两个不同的选项", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    expect(fields.filter((f) => f.id === "like_count" && f.group === "content")).toHaveLength(1);
    expect(fields.filter((f) => f.id === "user.like_count" && f.group === "user")).toHaveLength(1);
  });

  it("YouTube 订阅视频同时有 view_count 与 user.view_count", () => {
    const fields = getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos");
    expect(fields.some((f) => f.id === "view_count" && f.group === "content")).toBe(true);
    expect(fields.some((f) => f.id === "user.view_count" && f.group === "user")).toBe(true);
  });

  it("没声明 userProps 的内容源一个 user 分组字段都没有", () => {
    const own = getContentTriggerFields(ContentMetadata_X, "own:get-posts", "en");
    expect(own.some((f) => f.group === "user")).toBe(false);
    expect(own.every((f) => !f.id.startsWith("user."))).toBe(true);
  });

  it("作者字段排在内容字段之后", () => {
    const fields = getContentTriggerFields(ContentMetadata_X, "get-list-posts", "en");
    const firstUser = fields.findIndex((f) => f.group === "user");
    const lastContent = fields.map((f) => f.group).lastIndexOf("content");
    expect(firstUser).toBeGreaterThan(lastContent);
  });
});
```

文件顶部若尚未导入 `ContentMetadata_YouTube`，补上（该文件已有 `getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")` 的 case，通常已导入；没有则加）。

新建 `flow/tests/unit/select-props-value-prefix.test.tsx`：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SelectPropsValue from "../../../shared/frontend/components/SelectPropsValue";

describe("SelectPropsValue insert 变体的 $ 前缀", () => {
  it("已限定的 id 只加 $，不重复拼分组前缀", () => {
    // 拼成 $user.user.followers_count 的话 engine 的 PROP_REF_RE 会匹配出
    // "user.user.followers_count"，payload 里没有这个键 → 条件静默恒不通过。
    const onChange = vi.fn();
    render(
      <SelectPropsValue
        variant="insert"
        value=""
        open
        onChange={onChange}
        options={[{ id: "user.followers_count", label: "Followers", group: "user" }]}
      />
    );
    fireEvent.click(screen.getByText("Followers"));
    expect(onChange).toHaveBeenCalledWith("$user.followers_count");
  });

  it("未限定的 user 分组 id 仍补装饰性前缀（user flow）", () => {
    const onChange = vi.fn();
    render(
      <SelectPropsValue
        variant="insert"
        value=""
        open
        onChange={onChange}
        options={[{ id: "followers_count", label: "Followers", group: "user" }]}
      />
    );
    fireEvent.click(screen.getByText("Followers"));
    expect(onChange).toHaveBeenCalledWith("$user.followers_count");
  });

  it("content 分组的裸 id 只加 $", () => {
    const onChange = vi.fn();
    render(
      <SelectPropsValue
        variant="insert"
        value=""
        open
        onChange={onChange}
        options={[{ id: "like_count", label: "Likes", group: "content" }]}
      />
    );
    fireEvent.click(screen.getByText("Likes"));
    expect(onChange).toHaveBeenCalledWith("$like_count");
  });
});
```

> 实现者注意：该文件是 `.tsx` 且用 `@testing-library/react`，与仓库里已有的 `flow/tests/unit/flows-page-node-icon.test.tsx` 同一套设施。若 `SelectPropsValue` 不是 default export，按其实际导出方式调整 import。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test -- tests/unit/content-trigger-fields.test.ts tests/unit/select-props-value-prefix.test.tsx
```

预期：作者字段的 case 全部失败（字段列表里没有 `user.*`）；`select-props-value-prefix` 的第一个 case 失败（拼出 `$user.user.followers_count`）。

- [ ] **Step 3: 改 `flow/frontend/config/trigger-fields.ts`**

顶部 import 补上常量：

```ts
import { EventMetadata_X, PROPS, t, USER_PROP_PREFIX } from "../../../metadata";
```

把 `getContentTriggerFields` 的函数体改为：

```ts
export function getContentTriggerFields(
  metadata: ContentMetadata[],
  sourceContentType: string,
  locale: Locale = "en"
): TriggerFieldDefinition[] {
  const meta = metadata.find((m) => m.sourceContentType === sourceContentType);
  if (!meta) return [];
  const content = meta.contentProps
    .map((p) => propToField(p.propId, locale, "content"))
    .filter(Boolean) as TriggerFieldDefinition[];
  // 作者字段的 id 是**限定名** USER_PROP_PREFIX + propId，与 payload 里的键逐字相同——
  // ConditionsEditor 把 id 直接存进 cond.field，evaluateCondition 用 payload[field] 取值，
  // 两边必须一致。label 仍是 prop 自己的标签（"Views"/"Likes"），靠 SelectPropsValue 的
  // USER PROPS 分组标题与内容侧的同名项区分。
  // 没声明 userProps 的内容源在这里得到空数组，返回值与改动前逐字相同。
  const author = (meta.userProps || [])
    .map((p) => {
      const field = propToField(p.propId, locale, "user");
      return field ? { ...field, id: USER_PROP_PREFIX + field.id } : null;
    })
    .filter(Boolean) as TriggerFieldDefinition[];
  return [...content, ...author];
}
```

文档注释（`:110-119`）末尾补一句：

```
 * userProps（可选，只有声明了的内容源才有）以 group:"user" 追加在内容字段之后，id 为
 * USER_PROP_PREFIX 限定名——见 metadata/dataTypes.ts 的 USER_PROP_PREFIX 注释。
```

- [ ] **Step 4: 改 `shared/frontend/components/SelectPropsValue.tsx`**

把 `handleSelect` 里的 prefix 计算改为：

```ts
    if (isInsert) {
      // Content field values are resolved by engine.ts's resolveStringValue, whose regex only
      // recognizes an optional event./user. prefix — a $content. prefix would not be stripped
      // and the field would fail to resolve, so content refs are inserted bare ($field).
      //
      // opt.id 可能**已经是限定名**（content flow 的作者字段是 "user.<propId>"，与 payload
      // 键逐字相同）。那种 id 只加 "$"，再拼一次分组前缀会变成 $user.user.x —— engine 的
      // PROP_REF_RE 会把它整段当成引用名，payload 里没有这个键，条件静默恒不通过。
      const qualified = opt.id.includes(".");
      const prefix = qualified
        ? "$"
        : opt.group === "event" ? "$event." : opt.group === "user" ? "$user." : "$";
      onChange(prefix + opt.id);
    } else {
      onChange(opt.id);
    }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test
cd /Users/zc/Documents/UniSCRM/uniscrm-web/web && npm test
```

预期：flow 全绿；`web` 模块（也引用 shared 组件）无回归。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add flow/frontend/config/trigger-fields.ts flow/tests/unit/content-trigger-fields.test.ts \
        flow/tests/unit/select-props-value-prefix.test.tsx \
        shared/frontend/components/SelectPropsValue.tsx
git commit -m "feat(flow): 条件字段列表追加作者字段，id 用 user. 限定名

id 必须与 payload 键逐字相同（cond.field 直接进 payload[field]）。SelectPropsValue
对已限定的 id 只加 \$，否则会拼出 \$user.user.x 而静默恒不通过。没声明 userProps
的内容源返回值逐字不变。"
```

---

## Task 4: X List Posts 带回作者对象

**Files:**
- Modify: `link/src/services/x-posts-api.ts:32-35`（`XPostsPage`）、`:105-136`（`fetchListPostsPage`）
- Modify: `link/src/services/pollers/x-list-posts.ts:64-88`（`upsertPage`）、`:107`、`:132`（两个调用点）
- Modify: `link/tests/services/pollers/x-list-posts.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveAuthorProps`、`ContentMetadata_X` 的 `get-list-posts.userProps`
- Produces: `XPostsPage.authors?: Record<string, Record<string, unknown>>` —— `includes.users[]` 按 `id` 索引好的作者对象。只有 `fetchListPostsPage` 会填。

- [ ] **Step 1: 写失败测试**

在 `link/tests/services/pollers/x-list-posts.test.ts` 的 `describe("runListPostsPoller")` 块内追加（沿用该文件既有的 `createMockLinkDb` / `createMockEntityState` / `baseCtx` / `jsonResponse` / `fetchMock`）：

```ts
  it("请求带上 expansions=author_id 与 user.fields", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [], meta: {} }));

    await runListPostsPoller(baseCtx(linkDb, entityState));

    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain("expansions=author_id");
    expect(url).toContain("public_metrics");
  });

  it("按 author_id 从 includes.users[] 匹配作者，user.* 与内容字段一起发给 flow", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({
      data: [{ id: "t1", text: "hello", author_id: "a1", public_metrics: { like_count: 12 } }],
      includes: {
        users: [{
          id: "a1", name: "MKBHD", username: "mkbhd", description: "tech",
          profile_image_url: "https://x/img", verified_type: "blue",
          public_metrics: { followers_count: 10000, following_count: 5, tweet_count: 300, listed_count: 20, like_count: 90000, media_count: 40 },
        }],
      },
      meta: {},
    }));

    await runListPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

    const { payload } = flowQueue.send.mock.calls[0][0];
    // 两个 like_count 各是各的——这是整个 user. 命名空间存在的理由
    expect(payload.like_count).toBe(12);          // 这条推文被点赞数
    expect(payload["user.like_count"]).toBe(90000); // 作者一共点过多少赞
    expect(payload["user.followers_count"]).toBe(10000);
    expect(payload["user.source_user_id"]).toBe("a1");
    // is_followed 是 UserMetadata_X 里写死的 value:1，不得被照抄进来
    expect(payload["user.is_followed"]).toBeUndefined();
  });

  it("includes.users[] 里没有这个作者时照常发内容，只是不带 user.*", async () => {
    // 作者被封/受保护时 X 会省略。整条跳过是错的：内容照发，引用作者字段的条件按
    // fail-closed 不通过，没配作者条件的 flow 完全不受影响。
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    fetchMock.mockImplementationOnce(() => jsonResponse({
      data: [{ id: "t1", text: "hello", author_id: "a-missing", public_metrics: { like_count: 12 } }],
      includes: { users: [] },
      meta: {},
    }));

    await runListPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    const { payload } = flowQueue.send.mock.calls[0][0];
    expect(payload.like_count).toBe(12);
    expect(Object.keys(payload).some((k) => k.startsWith("user."))).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test -- tests/services/pollers/x-list-posts.test.ts
```

预期：三个新 case 失败。

- [ ] **Step 3: 改 `link/src/services/x-posts-api.ts`**

`XPostsPage` 增加字段：

```ts
export interface XPostsPage {
  data: Record<string, unknown>[];
  nextToken?: string;
  // includes.users[] 按 id 索引好的作者对象。只有请求了 expansions=author_id 的端点会填
  // （目前只有 fetchListPostsPage）。调用方按 tweet.author_id 查；查不到是正常情况
  // （作者被封/受保护时 X 会省略），不是错误。
  authors?: Record<string, Record<string, unknown>>;
}
```

在 `TWEET_FIELDS` 之后新增：

```ts
// 作者字段：与 ContentMetadata_X 的 get-list-posts.userProps 的 dataId 一一对应。
// X API v2 的 expansions 不额外计费、不额外消耗调用配额——作者对象与推文在同一个响应里。
const AUTHOR_USER_FIELDS = "id,name,username,description,profile_image_url,verified_type,public_metrics";
```

`fetchListPostsPage` 内，在 `url.searchParams.set("tweet.fields", TWEET_FIELDS);` 之后加两行：

```ts
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", AUTHOR_USER_FIELDS);
```

把结尾的解析改为：

```ts
  const body = (await res.json()) as {
    data?: Record<string, unknown>[];
    meta?: { next_token?: string };
    includes?: { users?: Record<string, unknown>[] };
  };
  const authors: Record<string, Record<string, unknown>> = {};
  for (const u of body.includes?.users || []) {
    if (typeof u.id === "string") authors[u.id] = u;
  }
  return { page: { data: body.data || [], nextToken: body.meta?.next_token, authors }, rateLimited: false };
```

**不动** `fetchPostsPage`：`own:get-posts` 的作者恒为自己，多要一份 expansions 没有任何用处。

- [ ] **Step 4: 改 `link/src/services/pollers/x-list-posts.ts`**

顶部 import 补上：

```ts
import { resolveProps, resolveAuthorProps } from "./resolve-props";
```

`upsertPage` 签名加一个参数、循环体内并入作者字段：

```ts
async function upsertPage(
  contentService: ContentService,
  items: Record<string, unknown>[],
  authors: Record<string, Record<string, unknown>> | undefined,
  channelId: string,
  listId: string,
  emitFlowEvent: boolean
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveProps(item, LIST_POSTS_METADATA.contentProps, LIST_POSTS_METADATA.linkPrefix);
    if (item.article) {
      props.content_type = "ARTICLE";
    }
    // X's tweet.fields has no permalink field; x.com/i/status/{id} is the official,
    // username-independent status URL format.
    props.content_url = `https://x.com/i/status/${props.source_content_id}`;
    // 作者字段（user.* 命名空间）与内容字段一起进 flow payload。作者对象就在同一个响应的
    // includes.users[] 里，零额外配额。匹配不到（作者被封/受保护，X 会省略）就不带
    // user.*——照常发内容，引用作者字段的条件按 fail-closed 不通过，没配作者条件的 flow
    // 完全不受影响。整条跳过是错的：recordTriggerContentSeen 已经把它记成"见过"。
    const authorId = typeof item.author_id === "string" ? item.author_id : "";
    const author = authorId ? authors?.[authorId] : undefined;
    const authorProps = author && LIST_POSTS_METADATA.userProps
      ? resolveAuthorProps(author, LIST_POSTS_METADATA.userProps)
      : {};
    const sourceContentId = String(props.source_content_id ?? "");
    // ALWAYS record, including during the seed phase (emitFlowEvent=false) — the dedup table
    // is the only place "already seen" state lives now, so skipping the record during seed
    // would make the first incremental poll see the whole seeded backlog as new and flood the
    // flow with duplicate triggers.
    const isNew = await contentService.recordTriggerContentSeen(channelId, listId, sourceContentId);
    if (isNew) newCount++;
    if (isNew && emitFlowEvent) {
      await contentService.emitContentTriggerEvent(channelId, "X", "listId", listId, { ...props, ...authorProps });
    }
  }
  return newCount;
}
```

两个调用点（`seedFromLatestPage` 与 `runIncrementalPoll`）各加一个实参：

```ts
  await upsertPage(contentService, page.data, page.authors, ctx.channelId, ctx.listId, false);
```

```ts
  const newCount = await upsertPage(contentService, page.data, page.authors, ctx.channelId, ctx.listId, true);
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
```

预期：全绿，特别确认 `tests/services/pollers/x-list-posts.test.ts` 与 `tests/services/pollers/poll-channel.test.ts` 的既有 case 无回归。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/x-posts-api.ts link/src/services/pollers/x-list-posts.ts \
        link/tests/services/pollers/x-list-posts.test.ts
git commit -m "feat(link): X List Posts 带回作者对象并进 flow payload

expansions=author_id 不额外计费也不额外消耗配额，作者对象与推文在同一个响应里。
匹配不到就不带 user.*（作者被封/受保护时 X 会省略）——照常发内容，引用作者字段
的条件 fail-closed 不通过。不动 fetchPostsPage：own:get-posts 的作者恒为自己。"
```

---

## Task 5: YouTube 取作者（频道）字段

**Files:**
- Modify: `link/src/services/youtube-api.ts:19-29`（`fetchVideoDetails` 之后新增 `fetchChannelDetails`）
- Modify: `link/src/services/pollers/youtube-content.ts:31-77`
- Modify: `link/tests/services/pollers/youtube-content.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveAuthorProps`、`ContentMetadata_YouTube` 的 `watch:get-videos.userProps`
- Produces:
  - `link/src/services/youtube-api.ts`：`export async function fetchChannelDetails(apiKey: string, channelId: string): Promise<Record<string, unknown> | null>`，失败抛 `Error("YouTube channels.list failed: <status> <body>")`
  - `link/src/services/pollers/youtube-content.ts`：
    - `export interface YouTubeVideoProps { props: Record<string, unknown>; authorChannelId: string }`
    - `fetchYouTubeVideoProps(apiKey, videoId): Promise<YouTubeVideoProps | null>` —— **返回类型变了**（原来直接返回 props 对象）
    - `export async function fetchYouTubeAuthorProps(apiKey: string, channelId: string): Promise<Record<string, unknown>>` —— 取不到返回 `{}`，API 错误**向上抛**（Task 6 的路由要把它映射成 failed 分支）

- [ ] **Step 1: 写失败测试**

在 `link/tests/services/pollers/youtube-content.test.ts` 追加（沿用该文件既有的 `vi.spyOn(youtubeApi, ...)` + `baseCtx` 写法；顶部 import 补 `fetchYouTubeVideoProps, fetchYouTubeAuthorProps`）：

```ts
const VIDEO_ITEM = {
  id: "vid1",
  snippet: {
    title: "Cool Video",
    description: "desc",
    publishedAt: "2026-07-18T00:00:00Z",
    channelId: "UC123",
    thumbnails: { default: { url: "https://img/thumb.jpg" } },
  },
  contentDetails: { duration: "PT4M13S" },
  statistics: { viewCount: "100", likeCount: "10" },
};

const CHANNEL_ITEM = {
  id: "UC123",
  snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t.jpg" } } },
  statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
};

describe("fetchYouTubeVideoProps — 作者频道 id", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("从 snippet.channelId 带出 authorChannelId，且不额外发起调用", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    const channelSpy = vi.spyOn(youtubeApi, "fetchChannelDetails");

    const out = await fetchYouTubeVideoProps("key", "vid1");

    expect(out!.authorChannelId).toBe("UC123");
    expect(out!.props.source_content_id).toBe("vid1");
    expect(out!.props.duration).toBe(253);
    expect(channelSpy).not.toHaveBeenCalled();
  });
});

describe("fetchYouTubeAuthorProps", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("channels.list 的 item 映射成 user.* 字段", async () => {
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);
    const props = await fetchYouTubeAuthorProps("key", "UC123");
    expect(props["user.followers_count"]).toBe("1000000");
    expect(props["user.post_count"]).toBe("700");
    expect(props["user.view_count"]).toBe("5000000000");
    expect(props["user.name"]).toBe("Chan");
    // 裸键一个都不能有——否则会覆盖内容侧的同名字段
    expect(Object.keys(props).every((k) => k.startsWith("user."))).toBe(true);
  });

  it("channels.list 返回空时返回 {}（频道已删/已封）", async () => {
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(null);
    expect(await fetchYouTubeAuthorProps("key", "UC123")).toEqual({});
  });

  it("channelId 为空串时直接返回 {} 且不发起请求", async () => {
    const spy = vi.spyOn(youtubeApi, "fetchChannelDetails");
    expect(await fetchYouTubeAuthorProps("key", "")).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("channels.list 出错时向上抛，由调用方决定语义", async () => {
    // ingest 路径吞掉、照常发内容；condition 节点则必须走 failed 分支。
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockRejectedValue(
      new Error("YouTube channels.list failed: 403 quota exceeded")
    );
    await expect(fetchYouTubeAuthorProps("key", "UC123")).rejects.toThrow("channels.list failed: 403");
  });
});

describe("ingestYouTubeVideo — 作者字段", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("作者字段与内容字段一起发给 flow，两个 view_count 各是各的", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockResolvedValue(CHANNEL_ITEM);
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ flowQueue }) as any, "vid1");

    const { payload } = flowQueue.send.mock.calls[0][0];
    expect(payload.view_count).toBe("100");                 // 这个视频的播放量
    expect(payload["user.view_count"]).toBe("5000000000");  // 频道历史总播放量
    expect(payload["user.followers_count"]).toBe("1000000");
  });

  it("channels.list 失败时照常发内容，只是不带 user.*", async () => {
    // 整条跳过是错的：recordTriggerContentSeen 已经把它记成"见过"，WebSub 只推一次，
    // 配额恢复也不会补——这个视频会永久丢失。
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue(VIDEO_ITEM);
    vi.spyOn(youtubeApi, "fetchChannelDetails").mockRejectedValue(
      new Error("YouTube channels.list failed: 403 quota exceeded")
    );
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

    await ingestYouTubeVideo(baseCtx({ flowQueue }) as any, "vid1");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    const { payload } = flowQueue.send.mock.calls[0][0];
    expect(payload.view_count).toBe("100");
    expect(Object.keys(payload).some((k) => k.startsWith("user."))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test -- tests/services/pollers/youtube-content.test.ts
```

- [ ] **Step 3: 改 `link/src/services/youtube-api.ts`**

在 `fetchVideoDetails` 之后新增：

```ts
// 频道（= 视频作者）的 snippet + statistics。videos.list 的 snippet 只白送
// channelId/channelTitle，订阅数/视频数/频道总播放量必须来自这里，1 unit/次。
// 返回 null = channels.list 没返回这个频道（已删、已封、id 不存在）——不是错误，是"没有"。
// 抛错格式与 fetchVideoDetails 一致（`YouTube <endpoint> failed: <status> <body>`）：
// routes-internal.ts 的 boundedYouTubeReason 按这个格式提取端点名与状态码，全量错误体
// 只进 console.log。
export async function fetchChannelDetails(apiKey: string, channelId: string): Promise<Record<string, unknown> | null> {
  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet,statistics");
  apiUrl.searchParams.set("id", channelId);
  apiUrl.searchParams.set("key", apiKey);

  const res = await fetch(apiUrl.toString());
  if (!res.ok) throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: Record<string, unknown>[] };
  return body.items?.[0] ?? null;
}
```

- [ ] **Step 4: 改 `link/src/services/pollers/youtube-content.ts`**

顶部 import 改为：

```ts
import { fetchVideoDetails, fetchChannelDetails, parseISO8601Duration } from "../youtube-api";
import { resolveProps, resolveAuthorProps } from "./resolve-props";
```

`fetchYouTubeVideoProps` 改为返回结构体：

```ts
export interface YouTubeVideoProps {
  props: Record<string, unknown>;
  // videos.list 的 snippet 白送的作者频道 id。调用方拿它去打 channels.list 取作者字段。
  // 空串 = 响应里没有（不该发生，但不假设它一定在）。
  authorChannelId: string;
}

// videos.list 的一条 item → 已按 metadata 映射好的 contentProps + 作者频道 id。ingest
// 路径与 flow 的 youtubeCondition 节点（经 /internal/youtube/video-stats）共用这一份
// 实现：字段怎么映射只能有一个答案，否则 metadata 改一次得记得改两处。
// 返回 null = videos.list 没返回这个视频（已删除、转私密、id 不存在）——不是错误，是"没有"。
export async function fetchYouTubeVideoProps(
  apiKey: string,
  videoId: string
): Promise<YouTubeVideoProps | null> {
  const item = await fetchVideoDetails(apiKey, videoId);
  if (!item) return null;

  const props = resolveProps(item, YOUTUBE_METADATA.contentProps, YOUTUBE_METADATA.linkPrefix);
  // YouTube's videos.list response has no permalink field; youtube.com/watch?v={id} is the
  // official, stable watch URL format, no username/channel handle required.
  props.content_url = `https://www.youtube.com/watch?v=${props.source_content_id}`;

  const snippet = item.snippet as Record<string, unknown> | undefined;
  const contentDetails = item.contentDetails as Record<string, unknown> | undefined;
  const durationIso = contentDetails?.duration as string | undefined;
  // Leave props.duration unset (not a fake 0) when we can't parse it — e.g. live/upcoming
  // broadcasts ("P0D") or videos over 24h. passesPropsFilter fails closed on a missing prop.
  const parsedDuration = durationIso ? parseISO8601Duration(durationIso) : null;
  if (parsedDuration !== null) {
    props.duration = parsedDuration;
  }
  return {
    props,
    authorChannelId: typeof snippet?.channelId === "string" ? snippet.channelId : "",
  };
}

// 作者（频道）字段，键已加 user. 前缀。
// 返回 {} = 拿不到（channelId 为空、频道已删/已封）。API 错误**向上抛**——调用方对
// 「拿不到」有两种完全不同的处理：ingest 路径吞掉、照常发内容（跳过等于永久丢失这个
// 视频），condition 节点则必须走 failed 分支（绝不用缺失的作者数据去猜 true/false）。
export async function fetchYouTubeAuthorProps(
  apiKey: string,
  channelId: string
): Promise<Record<string, unknown>> {
  if (!channelId || !YOUTUBE_METADATA.userProps) return {};
  const channel = await fetchChannelDetails(apiKey, channelId);
  if (!channel) return {};
  return resolveAuthorProps(channel, YOUTUBE_METADATA.userProps);
}
```

`ingestYouTubeVideo` 改为：

```ts
export async function ingestYouTubeVideo(ctx: YouTubeIngestContext, videoId: string): Promise<void> {
  const video = await fetchYouTubeVideoProps(ctx.apiKey, videoId);
  if (!video) {
    console.log(JSON.stringify({ event: "youtube_video_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId }));
    return;
  }
  const props = video.props;

  // 作者（频道）字段：与内容字段一起进 flow payload。多打一次 channels.list（1 unit）。
  // 失败不阻断——整条跳过等于永久丢失这个视频（recordTriggerContentSeen 下面就把它记成
  // "见过"，WebSub 只推一次，配额恢复也不会补）。拿不到就不带 user.*：引用作者字段的
  // 条件按 fail-closed 不通过，没配作者条件的 flow 完全不受影响。
  let authorProps: Record<string, unknown> = {};
  try {
    authorProps = await fetchYouTubeAuthorProps(ctx.apiKey, video.authorChannelId);
  } catch (e) {
    console.log(JSON.stringify({ event: "youtube_author_fetch_failed", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, author_channel_id: video.authorChannelId, error: String(e) }));
  }
  if (Object.keys(authorProps).length === 0) {
    console.log(JSON.stringify({ event: "youtube_author_fetch_empty", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, author_channel_id: video.authorChannelId }));
  }

  const contentService = new ContentService(ctx.tenantDb, ctx.vectorize, ctx.ai, ctx.tenantId, ctx.pipelineContent, ctx.flowQueue, ctx.entityState);
  const sourceContentId = String(props.source_content_id ?? "");
  const isNew = await contentService.recordTriggerContentSeen(ctx.accountChannelId, ctx.subscriptionChannelId, sourceContentId);
  if (isNew) {
    // contentPropsFilter 只判内容字段（duration <= 600），作者字段不参与——它是 metadata
    // 声明的系统级限制，与用户在节点上配的条件是两回事。
    if (passesPropsFilter(YOUTUBE_METADATA.contentPropsFilter, props)) {
      await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, { ...props, ...authorProps });
    } else {
      console.log(JSON.stringify({ event: "youtube_content_skipped_filter", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, duration: props.duration }));
    }
  }
  console.log(JSON.stringify({ event: "youtube_video_ingested", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, isNew }));
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
```

`fetchYouTubeVideoProps` 的返回类型变了，`link/tests/routes-internal-youtube-video-stats.test.ts` 与 `link/src/routes-internal.ts` 会编译失败 —— **这是预期的**，Task 6 修。本步只要求 `tests/services/pollers/youtube-content.test.ts` 全绿；若 vitest 因 `routes-internal.ts` 的类型错误整体跑不起来，先在 Task 6 的 Step 3 里同步改完再一起跑。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/youtube-api.ts link/src/services/pollers/youtube-content.ts \
        link/tests/services/pollers/youtube-content.test.ts
git commit -m "feat(link): YouTube 取作者频道字段并进 flow payload

videos.list 的 snippet 白送 channelId，订阅数要另打 channels.list（1 unit）。
fetchYouTubeVideoProps 改为返回 { props, authorChannelId }。摄取时取不到作者
不阻断——整条跳过等于永久丢失这个视频（dedup 已记成见过，WebSub 只推一次）。
fetchYouTubeAuthorProps 的 API 错误向上抛，由调用方决定语义。"
```

---

## Task 6: `/internal/youtube/video-stats` 支持 `withAuthor`

**Files:**
- Modify: `link/src/routes-internal.ts:110-121`（`boundedVideoStatsReason` → `boundedYouTubeReason`）、`:511-539`（video-stats 路由）
- Modify: `link/tests/routes-internal-youtube-video-stats.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `YouTubeVideoProps`、`fetchYouTubeAuthorProps`
- Produces:
  - `export function boundedYouTubeReason(e: unknown): string`（原 `boundedVideoStatsReason` 重命名 + 泛化）
  - `POST /internal/youtube/video-stats` 接受可选 `withAuthor: boolean`；为 true 时返回的 `props` 是 videos.list 与 channels.list 的**合并**结果

- [ ] **Step 1: 写失败测试**

在 `link/tests/routes-internal-youtube-video-stats.test.ts` 追加（并把既有 case 里对 `boundedVideoStatsReason` 的引用改成新名字）：

```ts
function channelsListResponse(item: Record<string, unknown> | null) {
  return new Response(JSON.stringify({ items: item ? [item] : [] }), { status: 200 });
}

const SAMPLE_CHANNEL = {
  id: "UC123",
  snippet: { title: "Chan", customUrl: "@chan", description: "d", thumbnails: { default: { url: "https://y/t.jpg" } } },
  statistics: { subscriberCount: "1000000", videoCount: "700", viewCount: "5000000000" },
};

// SAMPLE_ITEM 的 snippet 原本没有 channelId（作者频道 id 之前没人用）。
const ITEM_WITH_CHANNEL = { ...SAMPLE_ITEM, snippet: { ...SAMPLE_ITEM.snippet, channelId: "UC123" } };

// 一个 stub 同时服务两个端点：按 URL 分流，比按调用次序分流稳——次序一变测试就假绿。
function twoEndpointFetch(channelsResponder: () => Response) {
  return vi.fn(async (input: any) =>
    String(input).includes("/channels") ? channelsResponder() : videosListResponse(ITEM_WITH_CHANNEL)
  );
}

describe("POST /internal/youtube/video-stats — withAuthor", () => {
  it("withAuthor 缺省时不调用 channels.list", async () => {
    const f = vi.fn(async () => videosListResponse(ITEM_WITH_CHANNEL));
    vi.stubGlobal("fetch", f);
    const body = await (await app()({ videoId: "vid123" })).json() as { ok: boolean; props: Record<string, unknown> };
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain("/videos");
    expect(Object.keys(body.props).some((k) => k.startsWith("user."))).toBe(false);
  });

  it("withAuthor=true 时返回合并后的 props，两个 view_count 各是各的", async () => {
    vi.stubGlobal("fetch", twoEndpointFetch(() => channelsListResponse(SAMPLE_CHANNEL)));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json() as { ok: boolean; props: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.props.view_count).toBe("12000");                 // 这个视频的播放量
    expect(body.props["user.view_count"]).toBe("5000000000");    // 频道历史总播放量
    expect(body.props["user.followers_count"]).toBe("1000000");
  });

  it("channels.list 返回空 items → ok:false, reason channel_unavailable", async () => {
    // 频道已删/已封。与 video_unavailable 对称：绝不用缺失的作者数据去猜 true/false。
    vi.stubGlobal("fetch", twoEndpointFetch(() => channelsListResponse(null)));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json();
    expect(body).toEqual({ ok: false, reason: "channel_unavailable" });
  });

  it("channels.list HTTP 403 → 有界的 youtube_quota_exceeded，5000 字符错误体不进 reason", async () => {
    // reason 会一路写进 content_flow_log 这张分析表，长度不可控的外部返回体不能入库。
    vi.stubGlobal("fetch", twoEndpointFetch(() => new Response("x".repeat(5000), { status: 403 })));
    const body = await (await app()({ videoId: "vid123", withAuthor: true })).json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("youtube_quota_exceeded: channels.list HTTP 403");
    expect(body.reason.length).toBeLessThan(80);
  });
});

describe("boundedYouTubeReason", () => {
  it("按端点名与状态码产出有界字符串", () => {
    expect(boundedYouTubeReason(new Error("YouTube videos.list failed: 403 " + "x".repeat(5000))))
      .toBe("youtube_quota_exceeded: videos.list HTTP 403");
    expect(boundedYouTubeReason(new Error("YouTube channels.list failed: 403 body")))
      .toBe("youtube_quota_exceeded: channels.list HTTP 403");
    expect(boundedYouTubeReason(new Error("YouTube channels.list failed: 500 body")))
      .toBe("youtube_api_error: channels.list HTTP 500");
    expect(boundedYouTubeReason(new Error("something else entirely")))
      .toBe("youtube_api_error: request failed");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test -- tests/routes-internal-youtube-video-stats.test.ts
```

- [ ] **Step 3: 改 `link/src/routes-internal.ts`**

把 `boundedVideoStatsReason` 替换为：

```ts
// fetchVideoDetails / fetchChannelDetails 抛的是 `YouTube <endpoint> failed: <status> <body>`
// —— 里面带着 Google 返回的完整错误体。那个字符串会一路变成 flow 的 failureReason 并写进
// content_flow_log，违反"外部 API 全量 payload 不入库"。这里只留端点名与 HTTP 状态码，
// 明细留在对应的 console.log 里。
// 403 单独给一个码：这两个调用对配额耗尽都不重试、直接走 failed（设计已定），reason 是
// 这个状态唯一可诊断的地方。
export function boundedYouTubeReason(e: unknown): string {
  const m = /YouTube ([\w.]+) failed: (\d{3})\b/.exec(String(e instanceof Error ? e.message : e));
  if (!m) return "youtube_api_error: request failed";
  const [, endpoint, status] = m;
  if (status === "403") return `youtube_quota_exceeded: ${endpoint} HTTP 403`;
  return `youtube_api_error: ${endpoint} HTTP ${status}`;
}
```

顶部 import 补上 `fetchYouTubeAuthorProps` 与类型 `YouTubeVideoProps`（与既有的 `fetchYouTubeVideoProps` 同一处）。

把 video-stats 路由体改为：

```ts
  router.post("/youtube/video-stats", async (c) => {
    const { videoId, contentId, flowId, withAuthor } = await c.req
      .json<{ videoId?: string; contentId?: string; flowId?: string | null; withAuthor?: boolean }>()
      .catch(() => ({ videoId: undefined, contentId: undefined, flowId: undefined, withAuthor: undefined }));
    // 与其它出口同形（HTTP 200/400 都是 { ok: false, reason }）：flow 把任何非 2xx 都
    // 记成 "youtube_api_error: link returned 400"，会把"payload 里根本没有视频 id"
    // 误报成 API 出错。
    if (!videoId) return c.json({ ok: false, reason: "video_unavailable: no videoId in payload" }, 400);

    let video: YouTubeVideoProps | null;
    try {
      video = await fetchYouTubeVideoProps(c.env.YOUTUBE_API_KEY, videoId);
    } catch (e) {
      // 全量 API 错误体只进日志，不进 reason —— reason 会一路写进 content_flow_log
      // 这张分析表（flow/src/index.ts 的 emitContentNodeLogs），外部返回体长度不可控。
      console.log(JSON.stringify({ event: "youtube_video_stats_error", videoId, contentId: contentId || null, flowId: flowId || null, error: String(e) }));
      return c.json({ ok: false, reason: boundedYouTubeReason(e) });
    }
    if (!video) {
      console.log(JSON.stringify({ event: "youtube_video_stats_empty", videoId, contentId: contentId || null, flowId: flowId || null }));
      return c.json({ ok: false, reason: "video_unavailable: video not found or private" });
    }

    let props = video.props;
    // withAuthor 由 flow 侧按"这个节点的条件是否引用了 user.*"决定（flow/src/youtube-condition.ts
    // 的 conditionsNeedAuthor）。不引用就不打这一次 channels.list —— YOUTUBE_API_KEY 是全平台
    // 共享的 10000 units/天免费配额，condition 节点的调用量随 flow 数量线性增长。
    if (withAuthor) {
      let authorProps: Record<string, unknown>;
      try {
        authorProps = await fetchYouTubeAuthorProps(c.env.YOUTUBE_API_KEY, video.authorChannelId);
      } catch (e) {
        console.log(JSON.stringify({ event: "youtube_channel_stats_error", videoId, authorChannelId: video.authorChannelId, contentId: contentId || null, flowId: flowId || null, error: String(e) }));
        return c.json({ ok: false, reason: boundedYouTubeReason(e) });
      }
      // 空 = channels.list 返回了但没有这个频道（已删/已封）。与视频没了对称：一律
      // ok:false，绝不把缺了作者字段的 props 交给 flow 去判 true/false。
      if (Object.keys(authorProps).length === 0) {
        console.log(JSON.stringify({ event: "youtube_channel_stats_empty", videoId, authorChannelId: video.authorChannelId, contentId: contentId || null, flowId: flowId || null }));
        return c.json({ ok: false, reason: "channel_unavailable" });
      }
      // 合并成**同一份**"新鲜 props"：flow 的 stat_unavailable 守卫按"条件引用的字段在
      // 新数据里有没有"判断，两次调用的结果必须在这里合完再回去，否则每个 user.* 条件都
      // 会被误判成 stat_unavailable 而走 failed。
      props = { ...props, ...authorProps };
    }

    console.log(JSON.stringify({ event: "youtube_video_stats", videoId, contentId: contentId || null, flowId: flowId || null, withAuthor: !!withAuthor, view_count: props.view_count, like_count: props.like_count }));
    return c.json({ ok: true, props });
  });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
```

预期：link 全绿（含 Task 5 遗留的编译错误已消除）。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/routes-internal.ts link/tests/routes-internal-youtube-video-stats.test.ts
git commit -m "feat(link): video-stats 支持 withAuthor，合并两次抓取的新鲜 props

withAuthor 由 flow 按条件是否引用 user.* 决定，不引用就不打 channels.list。
两次结果在 link 侧合成同一份 props 再回去——flow 的 stat_unavailable 守卫按
\"条件引用的字段在新数据里有没有\"判断，分开回会让每个作者条件误判成 failed。
频道已删/已封 → channel_unavailable，与 video_unavailable 对称。
boundedVideoStatsReason 泛化为 boundedYouTubeReason（按端点名提取）。"
```

---

## Task 7: YouTube Condition 按需取作者字段

**Files:**
- Modify: `flow/src/youtube-condition.ts`
- Modify: `flow/src/index.ts:885-931`（`youtubeCondition` 派发分支）
- Modify: `flow/tests/unit/youtube-condition.test.ts`
- Modify: `flow/tests/unit/youtube-condition-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `USER_PROP_PREFIX`；Task 6 的 `withAuthor` 请求字段与合并后的 `props`
- Produces:
  - `export function conditionsNeedAuthor(conditions: { field: string; operator: string; value: string }[]): boolean`
  - `youtubeConditionRequest` 的参数对象**新增必填** `withAuthor: boolean`

- [ ] **Step 1: 写失败测试**

在 `flow/tests/unit/youtube-condition.test.ts` 追加：

```ts
import { conditionsNeedAuthor, youtubeConditionRequest, resolveYouTubeCondition } from "../../src/youtube-condition";

describe("conditionsNeedAuthor", () => {
  it("字段侧引用作者字段 → true", () => {
    expect(conditionsNeedAuthor([{ field: "user.followers_count", operator: ">", value: "1000" }])).toBe(true);
  });

  it("值侧表达式引用作者字段 → true", () => {
    // like_count > $user.followers_count * 0.01 —— 字段侧是内容字段，只有值里有作者引用
    expect(conditionsNeedAuthor([{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }])).toBe(true);
  });

  it("只有内容字段 → false", () => {
    expect(conditionsNeedAuthor([
      { field: "view_count", operator: ">", value: "1000" },
      { field: "like_count", operator: ">", value: "$view_count * 0.01" },
    ])).toBe(false);
  });

  it("空条件 / 半成品条目 → false", () => {
    expect(conditionsNeedAuthor([])).toBe(false);
    expect(conditionsNeedAuthor([{ field: "", operator: "==", value: "" }])).toBe(false);
  });
});

describe("youtubeConditionRequest — withAuthor", () => {
  it("withAuthor 进请求体", () => {
    const { body } = youtubeConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { source_content_id: "v1" },
      withAuthor: true,
    });
    expect(JSON.parse(body)).toEqual({ videoId: "v1", contentId: "c1", flowId: "f1", withAuthor: true });
  });
});

describe("resolveYouTubeCondition — 作者字段", () => {
  it("合并后的新鲜 props 里作者字段可参与判定", () => {
    const payload = { source_content_id: "v1", like_count: 10, "user.followers_count": 10000 };
    const resp = { ok: true, props: { like_count: 150, "user.followers_count": 10000 } };
    const out = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }],
      payload,
      resp
    );
    expect(out.branch).toBe("true");
    expect(out.payload.like_count).toBe(150);
  });

  it("频道隐藏了订阅数（新数据缺 user.followers_count，旧 payload 有）→ failed", () => {
    // YouTube 允许频道隐藏订阅数（hiddenSubscriberCount），此时 statistics.subscriberCount
    // 不返回。浅合并会把 trigger 时的旧值补回来，条件判的是一个已经不存在的数。
    const payload = { source_content_id: "v1", like_count: 10, "user.followers_count": 10000 };
    const resp = { ok: true, props: { like_count: 150 } };
    const out = resolveYouTubeCondition(
      [{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }],
      payload,
      resp
    );
    expect(out.branch).toBe("failed");
    expect(out.failureReason).toContain("stat_unavailable");
    expect(out.failureReason).toContain("user.followers_count");
  });

  it("channel_unavailable 走 failed 分支并原样带上 reason", () => {
    const out = resolveYouTubeCondition(
      [{ field: "user.followers_count", operator: ">", value: "100" }],
      { source_content_id: "v1" },
      { ok: false, reason: "channel_unavailable" }
    );
    expect(out.branch).toBe("failed");
    expect(out.failureReason).toBe("channel_unavailable");
  });
});
```

在 `flow/tests/unit/youtube-condition-dispatch.test.ts` 的 `describe("executeContentActions: youtubeCondition dispatch")` 块内追加（沿用该文件既有的 `runCondition` / `graphWithConditions` helper）：

```ts
  it("条件只用内容字段时，请求体的 withAuthor 为 false", async () => {
    // 不引用作者字段就不该让 link 多打一次 channels.list——YOUTUBE_API_KEY 是全平台
    // 共享的日配额。
    const { fetchMock } = await runCondition(
      graphWithConditions([{ field: "view_count", operator: ">", value: "1000" }]),
      () => new Response(JSON.stringify({ ok: true, props: { view_count: "12000" } }), { status: 200 }),
      "content-yt-author-1"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).withAuthor).toBe(false);
  });

  it("值里引用 $user.x 时，请求体的 withAuthor 为 true", async () => {
    // like_count > $user.followers_count * 0.01 —— 字段侧完全是内容字段，只有值里有
    // 作者引用。只扫 c.field 会漏掉这个形态，而它正是本功能的目标场景。
    const { fetchMock, outcome } = await runCondition(
      graphWithConditions([{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }]),
      () => new Response(
        JSON.stringify({ ok: true, props: { like_count: "150", "user.followers_count": "10000" } }),
        { status: 200 }
      ),
      "content-yt-author-2"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).withAuthor).toBe(true);
    expect(outcome).toBe("true"); // 150 > 10000 * 0.01
  });

  it("字段侧引用作者字段时，请求体的 withAuthor 为 true", async () => {
    const { fetchMock } = await runCondition(
      graphWithConditions([{ field: "user.followers_count", operator: ">", value: "1000" }]),
      () => new Response(JSON.stringify({ ok: true, props: { "user.followers_count": "10000" } }), { status: 200 }),
      "content-yt-author-3"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).withAuthor).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test -- tests/unit/youtube-condition.test.ts tests/unit/youtube-condition-dispatch.test.ts
```

- [ ] **Step 3: 改 `flow/src/youtube-condition.ts`**

顶部 import 补上：

```ts
import { USER_PROP_PREFIX } from "../../metadata/dataTypes";
```

新增：

```ts
// 这个节点的条件是否引用了作者字段——引用了才让 link 追加一次 channels.list（1 unit）。
// YOUTUBE_API_KEY 是全平台共享的 10000 units/天免费配额，而 condition 节点的调用量随
// flow 数量线性增长，绝大多数条件只看 view_count/like_count，白打就是白烧。
// 两种引用形式都要覆盖：字段侧 cond.field 直接是限定名；值侧写在表达式里
// （like_count > $user.followers_count * 0.01 —— 字段侧完全是内容字段）。
export function conditionsNeedAuthor(
  conditions: { field: string; operator: string; value: string }[]
): boolean {
  return (conditions || []).some(
    (c) => c.field?.startsWith(USER_PROP_PREFIX) || /\$user\./.test(String(c.value ?? ""))
  );
}
```

`youtubeConditionRequest` 加参数：

```ts
export function youtubeConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
  // 由 conditionsNeedAuthor 算出来。link 侧据此决定要不要追加 channels.list。
  withAuthor: boolean;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload, withAuthor } = args;
  return {
    url: `${env.LINK_URL}/internal/youtube/video-stats`,
    body: JSON.stringify({
      videoId: String(payload?.source_content_id ?? ""),
      contentId,
      flowId: flowId ?? null,
      withAuthor,
    }),
  };
}
```

把 `stat_unavailable` 的文案从 `videos.list` 改为端点无关的说法（作者字段来自 channels.list，说"videos.list 没返回"是错的）：

```ts
        failureReason: `stat_unavailable: ${c.field} not returned by YouTube`,
```

并在该守卫的注释里补一句：

```
  // withAuthor 为 true 时 resp.props 是 videos.list 与 channels.list 合并后的**同一份**
  // 新鲜数据（link 侧合的），所以 user.* 字段同样受这个守卫保护——例：频道打开了
  // hiddenSubscriberCount，channels.list 不再返回 statistics.subscriberCount，旧的
  // user.followers_count 被还原，比例条件就会拿一个已经不存在的分母去判定。
```

- [ ] **Step 4: 改 `flow/src/index.ts` 的派发分支**

把该分支里构造请求的那一行改为两行（其余逐字不动）：

```ts
      const withAuthor = conditionsNeedAuthor(conditions);
      const { url, body } = youtubeConditionRequest({ env, contentId, flowId, payload, withAuthor });
```

顶部 import 补上 `conditionsNeedAuthor`（与既有的 `youtubeConditionRequest`/`resolveYouTubeCondition` 同一处）。

`content_condition_youtube` 那行日志加上 `withAuthor`：

```ts
      console.log(JSON.stringify({ event: "content_condition_youtube", contentId, flowId: flowId || null, nodeId, branch: outcome.branch, ok: resp.ok, withAuthor, reason: outcome.failureReason || resp.reason || null }));
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test
```

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add flow/src/youtube-condition.ts flow/src/index.ts \
        flow/tests/unit/youtube-condition.test.ts flow/tests/unit/youtube-condition-dispatch.test.ts
git commit -m "feat(flow): YouTube Condition 按需取作者字段

conditionsNeedAuthor 同时看字段侧的限定名与值侧的 \$user. 引用——
like_count > \$user.followers_count * 0.01 的字段侧完全是内容字段。
不引用就不打 channels.list（共享配额，condition 调用量随 flow 数线性增长）。
stat_unavailable 文案改为端点无关：作者字段来自 channels.list。"
```

---

## Task 8: 全量回归与 dev 自测

**Files:** 无代码改动（除非发现缺陷）

- [ ] **Step 1: 全模块测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm test
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm test
cd /Users/zc/Documents/UniSCRM/uniscrm-web/web && npm test
```

预期：全绿。`flow/tests/unit/scheduled-content.test.ts` 与 `emit-node-logs.test.ts` 偶发 5 秒 testTimeout 是**既有**的 miniflare pool 资源竞争（约 1/12），与本分支无关；判定方法是重跑该文件单独通过即可，**不要**当成本次改动的缺陷去改代码。

- [ ] **Step 2: 租户隔离审计**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web && node scripts/tenant-scope-audit.mjs
```

预期：0 unexempted。

- [ ] **Step 3: 部署 dev**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm run deploy:dev
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npm run deploy:dev
```

- [ ] **Step 4: 端点自测**

用 `curl -i` 打 dev 上的内部端点（`INTERNAL_SECRET` 从 `link/.dev.vars` 或已部署 secret 取），验证三件事：

1. `withAuthor` 缺省 → 返回的 `props` 只有内容字段，无 `user.*`。
2. `withAuthor: true` → 返回的 `props` 同时含 `view_count` 与 `user.view_count`，两者不同值，且 `user.followers_count` 存在。
3. 不存在的 videoId → `{"ok":false,"reason":"video_unavailable: ..."}`。

```bash
curl -i -X POST https://link-dev.uni-scrm.com/internal/youtube/video-stats \
  -H "Content-Type: application/json" -H "X-Internal-Secret: $SECRET" \
  -d '{"videoId":"dQw4w9WgXcQ","contentId":"selftest","withAuthor":true}'
```

- [ ] **Step 5: 浏览器自测**

在已登录的真实会话里（不要新建测试账号）打开 `https://flow-dev.uni-scrm.com`，新建一条 content flow：

1. 拖一个 **X Content Trigger**，mode 选 **List Posts** → 条件字段下拉里应出现 **USER PROPS** 分组，含 Followers / Following / Posts / Listed / Likes / Media / Verified Type 等。
2. 内容分组与作者分组各有一个 **Likes** —— 选内容侧的那个，operator `>`，值输入框点 `$` 插入按钮选作者侧的 **Followers**，手动补 ` * 0.01`，最终值应为 `$user.followers_count * 0.01`（**不是** `$user.user.followers_count`）。
3. 把 mode 改成 **Own Posts** → USER PROPS 分组应整个消失。
4. 拖一个 **YouTube Content Trigger** + **Wait** + **YouTube Condition**，确认 YouTube Condition 的字段列表同样有 USER PROPS 分组，且同时存在两个 **Views**。
5. 保存并发布，确认无报错。

- [ ] **Step 6: 记录自测结果**

把上述每一步的实际观察（而不是"应该通过"）写进任务报告。任何一步与预期不符，回到对应 Task 修复而不是绕过。

---

## Self-Review 记录

**Spec 覆盖对照**

| Spec 条目 | 任务 |
|---|---|
| D1 user = 作者 | 2（metadata 声明）、4、5 |
| D2 数据跟着内容来、不查库 | 4（expansions）、5（channels.list） |
| D3 YouTube 两边都支持 | 5（trigger）、6+7（condition） |
| D4 condition 按需 | 7（`conditionsNeedAuthor`）、6（`withAuthor` 分支） |
| D5 `user.` 真命名空间 | 1（解析）、2（前缀）、3（字段 id） |
| D6 严格解析 + 双写 | 1 |
| D7 取不到照发不带 `user.*` | 4、5 |
| D8 Condition 失败语义 | 6（`channel_unavailable`、`boundedYouTubeReason`） |
| D9 字段集 | 2 |
| `stat_unavailable` 守卫合并 | 6（link 侧合并）、7（文案与注释） |
| 测试：存量兼容 / 撞名 / fail-closed / 按需 / 端到端 | 1、3、7、8 |
