# YouTube 订阅频道写入 user 实体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 YouTube 账号订阅的频道写成 per-tenant D1 `user` 表的行（`is_follow = 1`，`subscriberCount → followers_count`，`videoCount → post_count`），每天刷新一次，取消订阅置 `is_follow = 0`；同时删掉 `channels.config.subscriptions` 快照，flow 的订阅选择器改为实时拉取。

**Architecture:** 新增一个 daily poller，先 `subscriptions.list` 全量分页拿被订阅频道的 UC id，再按 50 一批 `channels.list?part=snippet,statistics` 拿统计数字，经 `UserMetadata_YouTube` 映射后走**现有**的 `persistUser` 写入路径（tenant D1 `user` + `entity_state` follow 镜像 + R2 `user` 分析副本）。承载这段写入逻辑的 `XUsersService` 重命名为平台中立的 `UsersService`，metadata 由调用方传入。

**Tech Stack:** TypeScript / Cloudflare Workers（Hono 路由、D1、Pipelines）、vitest + `@cloudflare/vitest-pool-workers`、YouTube Data API v3。

## Global Constraints

以下逐条来自 spec `docs/superpowers/specs/2026-07-29-youtube-subscriptions-as-users-design.md` 与仓库 CLAUDE.md，每个 task 的要求都隐含包含本节：

- 优先级：**数据准确性 > 系统稳定性 > 功能 > UI 界面**。永远不要为了兼容脏数据而增加复杂功能。
- 以稳定、安全、少改动为主，不要贪快。重要的被关联数据用**逻辑删除**。
- 元数据驱动：propId → payload 路径的映射**只能**来自 `metadata/`，绝不能靠 propId 名字或字符串启发式推断（`followers_count ← statistics.subscriberCount`）。
- 调用外部 API 返回的 payload 全量数据不要存数据库，未被映射消费的字段进 `raw_data`，全量进日志。
- poll 间隔 **23 小时**（`23 * 60 * 60 * 1000` ms）。YouTube 的 10,000 units/天配额是整个 Google Cloud 项目共享的，不是每租户。
- **半份订阅列表绝不做 diff**：`completeWalk === false` 时跳过取消订阅的判定。被打断的走查会把仍在订阅的频道误置 `is_follow = 0`。
- `hiddenSubscriberCount = true` 的频道，`followers_count` 写 **null 而不是 0**（不知道 ≠ 是零）。
- 写 `channels.config` 一律用 SQLite `json_set` 只改目标 key，**绝不读改写整个 config**——`YouTubeTokenService` 刷 token 时会整体重写 config，读改写会互相覆盖。
- 前端不用 inline CSS，全部组件化（本计划不新增前端组件）。
- `channel_type` 值：被订阅频道的 user 行写 `"YOUTUBE"`；账号行本身是 `"YOUTUBE_ACCOUNT"`。两者都已在 `link/src/types.ts:76` 的 `ChannelType` 联合类型中。
- 不加 `view_count` 到 user 实体；不改 WebSub 订阅/续期逻辑；不动 X / TikTok 的任何 poller 行为。
- 测试命令一律 `cd link && npm test -- <path>`；类型检查 `cd link && npm run typecheck`。
- git：**不要** `git add -A` / `git stash` / `git checkout .` / `git reset --hard`——并发 session 持有未提交文件（当前已知：`shared/frontend/Sidebar.tsx`、`shared/frontend/sidebar-state.ts`、`web/tests/unit/sidebar-state.test.ts`）。每次 commit 只 `git add` 本 task 明确列出的文件。**不要 push**。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `metadata/youtube.ts` | YouTube 的 content/user 元数据定义 | 修改：新增 `UserMetadata_YouTube` |
| `metadata/index.ts` | metadata 包的导出面 | 修改：导出 `UserMetadata_YouTube` |
| `link/src/services/users.ts` | 平台中立的 user 写入（D1 truth + entity_state 镜像 + R2 副本） | **由 `x-users.ts` 重命名**并泛化 |
| `link/src/services/youtube-quota.ts` | YouTube 配额计数与阈值告警 | 修改：函数改名 `recordYouTubeWriteQuota` → `recordYouTubeQuota` |
| `link/src/services/youtube-subscriptions-api.ts` | 只负责调 YouTube 的两个只读端点并分页/分批 | **新建** |
| `link/src/services/pollers/youtube-subscriptions.ts` | 一个账号一轮完整同步的编排（拉取→映射→upsert→diff） | **新建** |
| `link/src/services/tenant-db.ts` | 由 tenant_id 解析出 `TenantDataDB`（未 provision 返 null） | **新建**（从 `poll-channel.ts` 抽出私有实现） |
| `link/src/services/youtube-account.ts` | YouTube 账号级别的同步入口（OAuth 与 cron 共用） | 重写：`syncYouTubeSubscriptions` → `syncYouTubeSubscriptionUsers` |
| `link/src/services/pollers/poll-channel.ts` | 单频道 poll 调度 | 修改：`shouldPoll` 加间隔参数、新增 YouTube 分支 |
| `link/src/cron.ts` | 定时任务入口 | 修改：`handlePolling` 的候选频道 SELECT |
| `link/src/oauth.ts` | OAuth 回调 | 修改：`waitUntil` 调用新入口 |
| `link/src/routes-channels.ts` | 渠道相关的用户面路由 | 修改：`GET /youtube/subscriptions` 实时拉取、`GET /youtube/status` 计数改查 D1 |
| `link/src/webhook.ts` | X 入站 webhook | 修改：`UsersService` 改名带来的调用点更新 |
| `link/src/services/pollers/x-followers.ts` | X followers poller | 修改：同上 + 传 metadata 参数 |

`link/src/services/youtube-api.ts` 的 `fetchAllSubscriptions`（返回 `{channelId, channelName, thumbnailUrl}[]`）**保留不动**——Task 7 的选择器路由继续用它，它的返回形状正是前端要的。

---

## Task 1: `UserMetadata_YouTube` 元数据定义

**Files:**
- Modify: `metadata/youtube.ts`
- Modify: `metadata/index.ts:8`
- Test: `link/tests/metadata/youtube-user-metadata.test.ts`（新建）

**Interfaces:**
- Consumes: `metadata/dataTypes.ts` 的 `UserMetadata` 类型；`link/src/services/pollers/resolve-props.ts` 的 `resolveProps(item, props, linkPrefix?)` 与 `consumedPaths(props, linkPrefix?, allowedPropIds?)`
- Produces: `UserMetadata_YouTube: UserMetadata[]`，唯一条目 `sourceUserType === "own:get-subscriptions"`，由 Task 4 引用

**背景（实现者必读）：** `resolveProps` 遍历 `userProps`，对有 `value` 的直接取值，对有 `dataId` 的按点分路径从 item 里取。`linkPrefix` 缺省时 `dataId` 原样当路径用（见 `resolve-props.ts:16-18`）。本条目喂进去的 item 是 `channels.list` 响应里 `items[]` 的**单条**，所以不设 `linkPrefix`。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/metadata/youtube-user-metadata.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { UserMetadata_YouTube } from "../../../metadata/youtube";
import { resolveProps, consumedPaths } from "../../src/services/pollers/resolve-props";

const META = UserMetadata_YouTube.find((m) => m.sourceUserType === "own:get-subscriptions")!;

// 一条真实形状的 channels.list item（part=snippet,statistics）。
// 注意 statistics 的数字字段 YouTube 返回的是字符串。
const CHANNEL_ITEM = {
  kind: "youtube#channel",
  id: "UCBJycsmduvYEL83R_U4JriQ",
  snippet: {
    title: "Marques Brownlee",
    description: "MKBHD: Quality Tech Videos",
    customUrl: "@mkbhd",
    publishedAt: "2008-03-21T15:25:54Z",
    thumbnails: {
      default: { url: "https://yt3.ggpht.com/default.jpg", width: 88, height: 88 },
      high: { url: "https://yt3.ggpht.com/high.jpg", width: 800, height: 800 },
    },
    country: "US",
  },
  statistics: {
    viewCount: "4321000000",
    subscriberCount: "19500000",
    hiddenSubscriberCount: false,
    videoCount: "1680",
  },
};

describe("UserMetadata_YouTube own:get-subscriptions", () => {
  it("没有 linkPrefix —— 喂进来的是 channels.list 的单条 item", () => {
    expect(META.linkPrefix).toBeUndefined();
  });

  it("把 channels.list 的字段映射到 user 的 propId 上", () => {
    const props = resolveProps(CHANNEL_ITEM, META.userProps, META.linkPrefix);
    expect(props).toEqual({
      source_user_id: "UCBJycsmduvYEL83R_U4JriQ",
      name: "Marques Brownlee",
      username: "@mkbhd",
      description: "MKBHD: Quality Tech Videos",
      profile_image_url: "https://yt3.ggpht.com/default.jpg",
      followers_count: "19500000",
      post_count: "1680",
      is_follow: 1,
    });
  });

  // 这是整个映射最容易搞错的一条：propId 不等于 payload 字段名。
  // followers_count 来自 subscriberCount，post_count 来自 videoCount。
  it("followers_count 来自 subscriberCount，post_count 来自 videoCount", () => {
    const byId = Object.fromEntries(META.userProps.map((p) => [p.propId, p.dataId]));
    expect(byId.followers_count).toBe("statistics.subscriberCount");
    expect(byId.post_count).toBe("statistics.videoCount");
  });

  // hiddenSubscriberCount 为 true 时 API 不返回 subscriberCount 字段。
  // resolveProps 对缺失路径不写入 key —— 下游据此保持 null 而不是写 0。
  it("subscriberCount 缺席时不产出 followers_count", () => {
    const hidden = { ...CHANNEL_ITEM, statistics: { viewCount: "1000", hiddenSubscriberCount: true, videoCount: "12" } };
    const props = resolveProps(hidden, META.userProps, META.linkPrefix);
    expect("followers_count" in props).toBe(false);
    expect(props.post_count).toBe("12");
  });

  // viewCount / hiddenSubscriberCount / publishedAt / country 都不映射，
  // 因此不在 consumedPaths 里 —— 它们会留在 raw_data 中。
  it("未映射字段不出现在 consumedPaths 里", () => {
    const paths = consumedPaths(META.userProps, META.linkPrefix);
    expect(paths).toContain("statistics.subscriberCount");
    expect(paths).not.toContain("statistics.viewCount");
    expect(paths).not.toContain("snippet.country");
    // is_follow 是固定 value，不消费 payload 任何路径
    expect(paths.some((p) => p.includes("is_follow"))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/metadata/youtube-user-metadata.test.ts
```

Expected: FAIL —— `UserMetadata_YouTube` 未从 `metadata/youtube.ts` 导出。

- [ ] **Step 3: 实现**

`metadata/youtube.ts` 顶部的 import 改为：

```ts
import type { ContentMetadata, UserMetadata } from "./dataTypes";
```

在文件末尾（`ContentMetadata_YouTube` 数组之后）追加：

```ts
// 订阅的频道 = user 实体，对齐 X 的 follow user（我订阅他们 → is_follow = 1）。
// 数据来自 channels.list?part=snippet,statistics 的单条 item，不是 subscriptions.list ——
// subscriptions.list 任何 part 都不含被订阅频道的订阅数（已核对官方文档）。
// 无 linkPrefix：调用方逐条喂 item，不是整个响应体。
export const UserMetadata_YouTube: UserMetadata[] = [
  {
    sourceUserType: "own:get-subscriptions", // https://developers.google.com/youtube/v3/docs/channels/list
    userProps: [
      { propId: "source_user_id", dataId: "id" }, // UC... 频道 ID
      { propId: "name", dataId: "snippet.title" },
      { propId: "username", dataId: "snippet.customUrl" }, // 形如 @mkbhd
      { propId: "description", dataId: "snippet.description" },
      { propId: "profile_image_url", dataId: "snippet.thumbnails.default.url" },
      // subscriberCount 官方四舍五入到 3 位有效数字；这是唯一能拿到的数。
      // hiddenSubscriberCount = true 时该字段缺席，下游保持 null 而不是写 0。
      { propId: "followers_count", dataId: "statistics.subscriberCount" },
      { propId: "post_count", dataId: "statistics.videoCount" },
      { propId: "is_follow", value: 1 },
    ],
  },
];
```

`metadata/index.ts` 第 8 行改为：

```ts
export { ContentMetadata_YouTube, UserMetadata_YouTube } from "./youtube";
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test -- tests/metadata/youtube-user-metadata.test.ts && npm run typecheck
```

Expected: 5 passed；typecheck 无错。

- [ ] **Step 5: Commit**

```bash
git add metadata/youtube.ts metadata/index.ts link/tests/metadata/youtube-user-metadata.test.ts
git commit -m "feat(metadata): add UserMetadata_YouTube for subscribed channels"
```

---

## Task 2: `XUsersService` → `UsersService`（泛化 + 新增 `setFollowState`）

**Files:**
- Rename: `link/src/services/x-users.ts` → `link/src/services/users.ts`
- Modify: `link/src/webhook.ts:4,188,208,226,252,285,313,338,425`
- Modify: `link/src/services/pollers/x-followers.ts:4,45,64`
- Modify: `link/src/services/x-followers-api.ts:6`（仅注释里的类名）
- Rename: `link/tests/services/x-users.test.ts` → `link/tests/services/users.test.ts`
- Modify: `link/tests/webhook.test.ts`、`link/tests/services/x-followers.test.ts`、`link/tests/services/x-posts.test.ts`（注释/mock 里的类名）

**Interfaces:**
- Consumes: Task 1 的 `UserMetadata_YouTube`（仅测试用到）；`metadata/dataTypes.ts` 的 `UserMetadata`
- Produces:
  ```ts
  export class UsersService {
    constructor(tenantDb: TenantDataDB | null, opts?: {
      queue?: Queue; pipelineEvent?: Pipeline; pipelineUser?: Pipeline;
      tenantId?: number; entityState?: EntityStateStore;
    });
    upsertXWebhookUser(user: XUserData, channelId: string, channelType: string,
                       follow?: { is_follow?: 0 | 1; is_followed?: 0 | 1 }): Promise<string>;
    upsertUserFromMetadata(rawItem: Record<string, unknown>, resolvedProps: Record<string, unknown>,
                           channelId: string, channelType: string, meta: UserMetadata): Promise<boolean>;
    setFollowState(channelId: string, channelType: string, sourceUserId: string,
                   follow: { is_follow?: 0 | 1; is_followed?: 0 | 1 }): Promise<void>;
    insertEvents(events: Array<{...}>): Promise<void>;
  }
  export const EVENT_VALUE_COLUMNS: string[];
  export type { XUserData };
  ```
  Task 4 依赖 `upsertUserFromMetadata` 的第 5 个参数与 `setFollowState`。

**背景（实现者必读）：** 这是**纯重构 + 一个新方法**，不改任何现有行为。`persistUser`（probe → merge → upsert ... RETURNING → `entity_state` 镜像 → R2 副本）是这份代码里最难写对的一段，必须原样保留、绝不复制第二份。原文件里真正 X 专有的只有两处：模块级常量 `X_USER_META` / `X_USER_MAPPINGS`，和 `upsertUser(XUserData, ...)` 这条 webhook 路径。

- [ ] **Step 1: 写失败的测试**

在（尚未改名的）`link/tests/services/x-users.test.ts` 末尾追加两个 describe。它们引用新文件路径 `../../src/services/users`，所以在改名前必然失败：

```ts
import { UsersService } from "../../src/services/users";
import { UserMetadata_YouTube } from "../../../metadata/youtube";
import { UserMetadata_X } from "../../../metadata/x-byok";

describe("UsersService.upsertUserFromMetadata 用调用方传入的 metadata 剥离 raw_data", () => {
  // 剥离必须按 dataId 路径走，不能按 propId 名字 —— propId ≠ payload 字段名
  // （followers_count ← statistics.subscriberCount）。传错 metadata 会导致
  // 已入列的值同时留在 raw_data 里（重复存储），或未入列的值被误删（永久丢失）。
  it("YouTube 的 metadata 剥掉 statistics.subscriberCount，留下 statistics.viewCount", async () => {
    const tenantDb = createMockTenantDb();
    const service = new UsersService(tenantDb as any, { tenantId: 42, entityState: createMockEntityState() as any });
    const item = {
      id: "UC1",
      snippet: { title: "N", customUrl: "@n", description: "d", thumbnails: { default: { url: "u" } }, country: "US" },
      statistics: { subscriberCount: "100", videoCount: "5", viewCount: "9999", hiddenSubscriberCount: false },
    };
    const resolved = { source_user_id: "UC1", name: "N", username: "@n", followers_count: "100", post_count: "5", is_follow: 1 };

    await service.upsertUserFromMetadata(item, resolved, "chan-1", "YOUTUBE", UserMetadata_YouTube[0]);

    const insert = tenantDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO user"))!;
    const cols = String(insert[0]).slice(String(insert[0]).indexOf("(") + 1, String(insert[0]).indexOf(")")).split(",").map((s) => s.trim());
    const rawData = JSON.parse(String((insert[1] as unknown[])[cols.indexOf("raw_data")]));
    expect(rawData.statistics.viewCount).toBe("9999");
    expect(rawData.statistics.subscriberCount).toBeUndefined();
    expect(rawData.snippet.country).toBe("US");
    expect(rawData.snippet.title).toBeUndefined();
  });

  it("X 的 metadata 仍剥掉 public_metrics.followers_count", async () => {
    const tenantDb = createMockTenantDb();
    const service = new UsersService(tenantDb as any, { tenantId: 42, entityState: createMockEntityState() as any });
    const item = { id: "9", name: "A", public_metrics: { followers_count: 3, tweet_count: 7 }, location: "SF" };
    const resolved = { source_user_id: "9", name: "A", followers_count: 3, post_count: 7, is_followed: 1 };

    await service.upsertUserFromMetadata(item, resolved, "chan-x", "X", UserMetadata_X[0]);

    const insert = tenantDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO user"))!;
    const cols = String(insert[0]).slice(String(insert[0]).indexOf("(") + 1, String(insert[0]).indexOf(")")).split(",").map((s) => s.trim());
    const rawData = JSON.parse(String((insert[1] as unknown[])[cols.indexOf("raw_data")]));
    expect(rawData.location).toBe("SF");
    expect(rawData.public_metrics.followers_count).toBeUndefined();
  });
});

describe("UsersService.setFollowState", () => {
  // 取消订阅用的方法：只动 follow 位，不碰任何资料列，且必须强制推一条 R2 副本 ——
  // R2 是 append-only 且无列级更新，不 forceSend 的话分析侧永远看不到这次变化。
  it("把已知用户的 is_follow 置 0，且不写任何资料列", async () => {
    const prior = knownFollower("UC1", { id: "stored-UC1", is_follow: 1, is_followed: 0, name: "N" });
    const tenantDb = createMockTenantDb({ UC1: prior });
    const sent: unknown[][] = [];
    const service = new UsersService(tenantDb as any, {
      tenantId: 42,
      entityState: createMockEntityState() as any,
      pipelineUser: { send: async (r: unknown[]) => { sent.push(r); } } as any,
    });

    await service.setFollowState("chan-1", "YOUTUBE", "UC1", { is_follow: 0 });

    const insert = tenantDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO user"))!;
    const sql = String(insert[0]);
    expect(sql).toContain("is_follow = excluded.is_follow");
    expect(sql).not.toContain("name = excluded.name");
    expect(sql).not.toContain("followers_count = excluded.followers_count");
    expect(sent).toHaveLength(1);
    expect((sent[0][0] as Record<string, unknown>).is_follow).toBe(0);
    // 行本身保留（逻辑删除语义）：没有任何 DELETE
    expect(tenantDb.query.mock.calls.every((c: any[]) => !String(c[0]).includes("DELETE"))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/x-users.test.ts
```

Expected: FAIL —— 无法解析 `../../src/services/users`。

- [ ] **Step 3: 实现重命名与泛化**

3a. 文件改名（保留 git 历史）：

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git mv link/src/services/x-users.ts link/src/services/users.ts
git mv link/tests/services/x-users.test.ts link/tests/services/users.test.ts
```

3b. `link/src/services/users.ts` 内的改动：

- 顶部 import 增加 `UserMetadata` 类型：
  ```ts
  import type { UserMetadata } from "../../../metadata/dataTypes";
  ```
- `export class XUsersService` → `export class UsersService`
- `requireDb` 里的错误信息 `XUsersService.${method}` → `UsersService.${method}`
- `upsertUser(...)` 改名 `upsertXWebhookUser(...)`，方法体与签名其余部分**完全不变**（它内部继续用模块级 `X_USER_MAPPINGS` / `X_USER_META`，注释保留）
- `upsertUserFromMetadata` 增加第 5 个**必填**参数，并把 `consumedPaths` 的两个实参换成它：

  ```ts
  async upsertUserFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: string,
    // 调用方持有的 metadata 条目。只用于算 consumedPaths（raw_data 剥离），
    // resolvedProps 已经由调用方自己 resolveProps 好了。必填而非默认 X ——
    // 传错平台的 metadata 会把该留的字段剥掉、该剥的留下，两种都是静默的数据损坏。
    meta: UserMetadata
  ): Promise<boolean> {
    // ... 前面的 sourceUserId / columnValues / followValues 三段完全不变 ...

    const paths = consumedPaths(meta.userProps, meta.linkPrefix, MAPPED_USER_PROP_IDS);
    const rawData = JSON.stringify(stripConsumedPaths(rawItem, paths));

    // ... persistUser 调用与 return 完全不变 ...
  }
  ```

- 在 `upsertUserFromMetadata` 之后新增 `setFollowState`：

  ```ts
  // 只改 follow 位，不碰任何资料列。取消订阅/取关时用：调用方已经确认这个
  // (channelId, sourceUserId) 在 D1 里存在（它就是从 D1 查出来的），所以这里
  // 不再重复探测。forceSend: true 是必须的 —— follow 位变了但资料列一个字没动时，
  // persistUser 的 unchanged 比对虽然会因 follow 列而判定为「变了」，但 R2 无列级
  // 更新，只有推一条完整新行分析侧才看得到。
  async setFollowState(
    channelId: string,
    channelType: string,
    sourceUserId: string,
    follow: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<void> {
    await this.persistUser({
      channelId,
      channelType,
      sourceUserId,
      columnValues: {},
      followValues: follow,
      // json_patch(user.raw_data, '{}') 是无操作合并：这条写入不带任何新的原始字段。
      rawData: "{}",
      forceSend: true,
    });
  }
  ```

3c. 调用点更新：

- `link/src/webhook.ts:4`：
  ```ts
  import { UsersService, EVENT_VALUE_COLUMNS, type XUserData } from "./services/users";
  ```
  第 188、425 行 `new XUsersService(` → `new UsersService(`；第 208 行参数类型 `usersService: XUsersService` → `usersService: UsersService`；第 226、252、285、313、338 行 `usersService.upsertUser(` → `usersService.upsertXWebhookUser(`。

- `link/src/services/pollers/x-followers.ts`：
  - 第 4 行 `import { XUsersService } from "../x-users";` → `import { UsersService } from "../users";`
  - 第 45 行 `new XUsersService(` → `new UsersService(`
  - `upsertPage` 的参数类型 `usersService: XUsersService` → `UsersService`，第 64 行调用补第 5 个实参：
    ```ts
    const isNew = await usersService.upsertUserFromMetadata(item, props, channelId, "X", FOLLOWERS_METADATA);
    ```
  - 第 70、109 行两个函数签名里的 `usersService: XUsersService` 同样改为 `UsersService`

- `link/src/services/x-followers-api.ts:6`：注释中的 `XUsersService.upsertUserFromMetadata` → `UsersService.upsertUserFromMetadata`

3d. 测试文件更新（纯文本替换，不改断言语义）：

- `link/tests/services/users.test.ts`：`from "../../src/services/x-users"` → `from "../../src/services/users"`；全部 `XUsersService` → `UsersService`；全部 `.upsertUser(` → `.upsertXWebhookUser(`；全部 `upsertUserFromMetadata(a, b, c, d)` 调用补第 5 个实参 `UserMetadata_X[0]`（文件顶部 `import { UserMetadata_X } from "../../../metadata/x-byok";`）
- `link/tests/webhook.test.ts`：mock 工厂里的 `XUsersService: class {` → `UsersService: class {`，以及 mock 路径 `"../src/services/x-users"` → `"../src/services/users"`；mock 类里的 `upsertUser` 方法名 → `upsertXWebhookUser`
- `link/tests/services/x-followers.test.ts`、`link/tests/services/x-posts.test.ts`：注释里的 `XUsersService` → `UsersService`

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test && npm run typecheck
```

Expected: 全套通过（本次改动前的基线 + Task 1 的 5 个 + 本 task 新增的 3 个）。任何一个既有断言失败都说明重构改变了行为，必须查明而不是改断言。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/users.ts link/src/webhook.ts link/src/services/pollers/x-followers.ts \
        link/src/services/x-followers-api.ts link/tests/services/users.test.ts \
        link/tests/webhook.test.ts link/tests/services/x-followers.test.ts link/tests/services/x-posts.test.ts
git commit -m "refactor(link): XUsersService -> platform-neutral UsersService

metadata now arrives per call instead of being hardcoded to X, and
setFollowState lands the follow-bit-only write the YouTube unsubscribe
diff needs. No behaviour change to the X paths."
```

---

## Task 3: YouTube 只读 API 封装 + 配额函数改名

**Files:**
- Create: `link/src/services/youtube-subscriptions-api.ts`
- Modify: `link/src/services/youtube-quota.ts:11`
- Modify: `link/src/routes-internal.ts:16,467,504`（`recordYouTubeWriteQuota` 的全部生产调用点）
- Modify: `link/tests/services/youtube-quota.test.ts:2,23,33,36`、`link/tests/services/youtube-internal-endpoints.test.ts:11-12`（改名 + 显式传 units）
- Test: `link/tests/services/youtube-subscriptions-api.test.ts`（新建）

**Interfaces:**
- Consumes: 无（只依赖 `fetch` 与 `Env`）
- Produces:
  ```ts
  export interface YouTubeChannelItem {
    id: string;
    snippet?: { title?: string; description?: string; customUrl?: string;
                thumbnails?: { default?: { url?: string } }; [k: string]: unknown };
    statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string;
                   hiddenSubscriberCount?: boolean; [k: string]: unknown };
    [k: string]: unknown;
  }
  export const CHANNELS_BATCH_SIZE = 50;
  export async function fetchSubscribedChannelIds(accessToken: string, deadline: number):
    Promise<{ ids: string[]; complete: boolean; calls: number }>;
  export async function fetchChannelDetails(accessToken: string, channelIds: string[]):
    Promise<YouTubeChannelItem[]>;
  // youtube-quota.ts
  export async function recordYouTubeQuota(env: Env, units: number): Promise<void>;
  ```
  Task 4 全部依赖。

**背景（实现者必读）：** `recordYouTubeWriteQuota` 的生产调用点只有两处，都在 `link/src/routes-internal.ts`（第 467、504 行，`save-to-playlist` 与 `rate-like` 两个写操作），都是 `await recordYouTubeWriteQuota(c.env)` 吃默认值 50。改名后必须显式写成 `await recordYouTubeQuota(c.env, 50)`。取消默认值是**故意的**：默认 50 用在只花 1 unit 的读调用上会把配额记账放大 50 倍，静默地把阈值告警变成噪音。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/services/youtube-subscriptions-api.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSubscribedChannelIds, fetchChannelDetails, CHANNELS_BATCH_SIZE } from "../../src/services/youtube-subscriptions-api";

function subsPage(ids: string[], nextPageToken?: string) {
  return new Response(JSON.stringify({
    items: ids.map((id) => ({ snippet: { resourceId: { channelId: id }, title: `t-${id}` } })),
    nextPageToken,
  }), { status: 200 });
}

describe("fetchSubscribedChannelIds", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("翻完所有页，complete = true", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1", "UC2"], "p2"))
      .mockResolvedValueOnce(subsPage(["UC3"]));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);

    expect(r.ids).toEqual(["UC1", "UC2", "UC3"]);
    expect(r.complete).toBe(true);
    expect(r.calls).toBe(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("mine=true");
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=p2");
  });

  // 半份列表绝不能被当成完整列表 —— 下游据此跳过 diff，否则仍在订阅的频道会被误置 is_follow=0。
  it("中途某页失败时 complete = false，但已拿到的 id 照常返回", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1"], "p2"))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);

    expect(r.ids).toEqual(["UC1"]);
    expect(r.complete).toBe(false);
  });

  it("撞 deadline 时 complete = false", async () => {
    fetchMock.mockResolvedValue(subsPage(["UC1"], "p2"));

    const r = await fetchSubscribedChannelIds("tok", Date.now() - 1);

    expect(r.complete).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("跳过没有 resourceId.channelId 的条目", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ snippet: { title: "broken" } }, { snippet: { resourceId: { channelId: "UC9" } } }],
    }), { status: 200 }));

    const r = await fetchSubscribedChannelIds("tok", Date.now() + 60_000);
    expect(r.ids).toEqual(["UC9"]);
  });
});

describe("fetchChannelDetails", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("一次请求带上全部 id，并要 snippet + statistics", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ id: "UC1", snippet: { title: "A" }, statistics: { subscriberCount: "10" } }],
    }), { status: 200 }));

    const items = await fetchChannelDetails("tok", ["UC1", "UC2"]);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("id=UC1%2CUC2");
    expect(url).toContain("part=snippet%2Cstatistics");
    expect(items).toHaveLength(1);
    expect(items[0].statistics?.subscriberCount).toBe("10");
  });

  it("超过 50 个 id 直接抛错 —— 分批是调用方的责任", async () => {
    const ids = Array.from({ length: CHANNELS_BATCH_SIZE + 1 }, (_, i) => `UC${i}`);
    await expect(fetchChannelDetails("tok", ids)).rejects.toThrow(/50/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("非 2xx 抛错，错误信息带状态码", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    await expect(fetchChannelDetails("tok", ["UC1"])).rejects.toThrow(/403/);
  });

  it("空数组不发请求", async () => {
    expect(await fetchChannelDetails("tok", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/youtube-subscriptions-api.test.ts
```

Expected: FAIL —— 模块 `../../src/services/youtube-subscriptions-api` 不存在。

- [ ] **Step 3: 实现**

新建 `link/src/services/youtube-subscriptions-api.ts`：

```ts
const DATA_API_BASE = "https://www.googleapis.com/youtube/v3";

// channels.list 的 id 参数单次最多 50 个（官方文档）。分批是调用方的责任 ——
// 由调用方分批，才能在某一批失败时精确地知道「哪些频道本轮没更新」。
export const CHANNELS_BATCH_SIZE = 50;

// channels.list 的一条 item，原样交给 resolveProps。结构不在这里收窄：
// 未映射字段要完整留给 raw_data。
export interface YouTubeChannelItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string } };
    [k: string]: unknown;
  };
  statistics?: {
    subscriberCount?: string; // API 返回字符串
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// 全量分页拉「我订阅了谁」。complete = false 表示走查被中断（分页失败或撞 deadline），
// 调用方据此**必须**跳过取消订阅的 diff —— 半份列表做 diff 会把仍在订阅的频道
// 误判成已取消。calls 是实际发出的请求数，供配额记账（1 unit/次）。
export async function fetchSubscribedChannelIds(
  accessToken: string,
  deadline: number
): Promise<{ ids: string[]; complete: boolean; calls: number }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  let calls = 0;

  do {
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({ event: "youtube_subscriptions_walk_deadline", calls, collected: ids.length }));
      return { ids, complete: false, calls };
    }

    const apiUrl = new URL(`${DATA_API_BASE}/subscriptions`);
    apiUrl.searchParams.set("part", "snippet");
    apiUrl.searchParams.set("mine", "true");
    apiUrl.searchParams.set("maxResults", "50");
    if (pageToken) apiUrl.searchParams.set("pageToken", pageToken);

    const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    calls++;
    if (!res.ok) {
      console.error(JSON.stringify({
        event: "youtube_subscriptions_walk_error",
        status: res.status, body: await res.text().catch(() => ""), collected: ids.length,
      }));
      return { ids, complete: false, calls };
    }

    const body = (await res.json()) as {
      items?: { snippet?: { resourceId?: { channelId?: string } } }[];
      nextPageToken?: string;
    };
    for (const item of body.items || []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (channelId) ids.push(channelId);
    }
    pageToken = body.nextPageToken;
  } while (pageToken);

  return { ids, complete: true, calls };
}

// 一批（≤50）频道的 snippet + statistics。失败直接抛，由调用方决定是跳过这一批
// 还是中止整轮 —— 这里没有足够上下文做那个决定。
export async function fetchChannelDetails(
  accessToken: string,
  channelIds: string[]
): Promise<YouTubeChannelItem[]> {
  if (channelIds.length === 0) return [];
  if (channelIds.length > CHANNELS_BATCH_SIZE) {
    throw new Error(`fetchChannelDetails: at most ${CHANNELS_BATCH_SIZE} ids per call, got ${channelIds.length}`);
  }

  const apiUrl = new URL(`${DATA_API_BASE}/channels`);
  apiUrl.searchParams.set("part", "snippet,statistics");
  apiUrl.searchParams.set("id", channelIds.join(","));
  apiUrl.searchParams.set("maxResults", String(CHANNELS_BATCH_SIZE));

  const res = await fetch(apiUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`YouTube channels.list failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { items?: YouTubeChannelItem[] };
  return body.items || [];
}
```

`link/src/services/youtube-quota.ts`：把

```ts
export async function recordYouTubeWriteQuota(env: Env, units = 50): Promise<void> {
```

改为（函数体一字不动）：

```ts
// units 必填、无默认值：读调用是 1 unit，写调用是 50。一个 50 的默认值用在读调用上
// 会把记账放大 50 倍，静默地把阈值告警变成噪音。
export async function recordYouTubeQuota(env: Env, units: number): Promise<void> {
```

然后：

- `link/src/routes-internal.ts` 第 16 行 import 改名；第 467、504 行 `await recordYouTubeWriteQuota(c.env)` → `await recordYouTubeQuota(c.env, 50)`
- `link/tests/services/youtube-quota.test.ts` 第 2 行 import 改名；第 23、33、36 行的三次调用补上 `, 50`（断言的阈值跨越行为不变）
- `link/tests/services/youtube-internal-endpoints.test.ts` 第 11-12 行的 mock 名改为 `recordYouTubeQuota`

改完 `grep -rn "recordYouTubeWriteQuota" link/` 应无输出。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test && npm run typecheck
```

Expected: 新增 9 个通过；既有测试全绿（`youtube-actions` 相关测试若断言了配额函数名需同步改名）。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/youtube-subscriptions-api.ts link/src/services/youtube-quota.ts \
        link/src/routes-internal.ts link/tests/services/youtube-subscriptions-api.test.ts \
        link/tests/services/youtube-quota.test.ts link/tests/services/youtube-internal-endpoints.test.ts
git commit -m "feat(link): YouTube subscriptions/channels read API + explicit quota units"
```

---

## Task 4: `runYouTubeSubscriptionsPoller` —— 一轮完整同步

**Files:**
- Create: `link/src/services/pollers/youtube-subscriptions.ts`
- Test: `link/tests/services/pollers/youtube-subscriptions.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `UserMetadata_YouTube`；Task 2 的 `UsersService.upsertUserFromMetadata(..., meta)` 与 `setFollowState`；Task 3 的 `fetchSubscribedChannelIds` / `fetchChannelDetails` / `CHANNELS_BATCH_SIZE` / `recordYouTubeQuota`
- Produces:
  ```ts
  export interface YouTubeSubscriptionsPollerContext {
    env: Env;
    accountChannelId: string;
    accessToken: string;
    linkDb: D1Database;
    tenantDb: TenantDataDB;
    entityState: EntityStateStore;
    tenantId: number;
    pipelineUser?: Pipeline;
    deadline: number;
  }
  export async function runYouTubeSubscriptionsPoller(ctx: YouTubeSubscriptionsPollerContext): Promise<void>;
  ```
  Task 5 依赖。

**背景（实现者必读）：**
- `channel_poll_state` 表结构：`(channel_id, poller_name)` 主键 + `cursor` / `backfill_complete` / `last_polled_at` / `updated_at`（`link/migrations/0004_create_channel_poll_state.sql`）。本 poller 只用 `last_polled_at`，不用 cursor / backfill_complete。
- X 的 poller 语义是「没有 state 行 = 未授权，直接跳过」。**YouTube 不采用这个语义**：授权凭证就在 `channels` 行的 config 里，state 行只是节流用的时间戳。因此本 poller 第一件事就是 `INSERT OR IGNORE` 自播种，省掉一整类播种时序 bug，也省掉给存量频道补行的运维脚本。
- `channel_type` 写 `"YOUTUBE"`（被订阅的频道），不是 `"YOUTUBE_ACCOUNT"`（账号本身）。
- `resolveProps` 对 metadata 里 `value` 固定值直接取值，对 `dataId` 按点分路径取；路径不存在则不写入该 key。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/services/pollers/youtube-subscriptions.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runYouTubeSubscriptionsPoller } from "../../../src/services/pollers/youtube-subscriptions";

function createMockLinkDb() {
  const runs: { sql: string; params: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => { runs.push({ sql, params }); return { success: true }; }),
    })),
  }));
  return { prepare, _runs: runs };
}

// 与 x-followers.test.ts 的 mock 同构：INSERT INTO user 回一行（模拟 RETURNING），
// 其余 SELECT 按 existingBySourceId 返回既有行。
function createMockTenantDb(
  existingBySourceId: Record<string, Record<string, unknown>> = {},
  followRows: { source_user_id: string }[] = []
) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO user")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      const prior = existingBySourceId[String(row.source_user_id)];
      return [{
        id: prior ? prior.id : row.id,
        created_at: prior ? prior.created_at : row.created_at,
        is_follow: row.is_follow ?? prior?.is_follow ?? 0,
        is_followed: row.is_followed ?? prior?.is_followed ?? 0,
      }];
    }
    // 取消订阅 diff 用的那条查询
    if (sql.includes("is_follow = 1")) return followRows;
    const prior = existingBySourceId[String(params[1])];
    return prior ? [prior] : [];
  });
  return { query, run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };
}

function createMockEntityState() {
  return { ensureEntity: vi.fn().mockResolvedValue(undefined), setFollow: vi.fn().mockResolvedValue(undefined) };
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    env: { KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) } } as any,
    accountChannelId: "acct-1",
    accessToken: "tok",
    linkDb: createMockLinkDb() as any,
    tenantDb: createMockTenantDb() as any,
    entityState: createMockEntityState() as any,
    tenantId: 42,
    pipelineUser: undefined,
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

function subsPage(ids: string[], nextPageToken?: string) {
  return new Response(JSON.stringify({
    items: ids.map((id) => ({ snippet: { resourceId: { channelId: id } } })),
    nextPageToken,
  }), { status: 200 });
}

function channelsPage(items: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

const MKBHD = {
  id: "UC1",
  snippet: { title: "Marques Brownlee", customUrl: "@mkbhd", description: "tech",
             thumbnails: { default: { url: "https://img/1.jpg" } }, country: "US" },
  statistics: { subscriberCount: "19500000", videoCount: "1680", viewCount: "4321000000", hiddenSubscriberCount: false },
};

describe("runYouTubeSubscriptionsPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  function insertOf(tenantDb: any) {
    const call = tenantDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO user"))!;
    const sql = String(call[0]);
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s: string) => s.trim());
    const params = call[1] as unknown[];
    return { sql, get: (col: string) => params[cols.indexOf(col)] };
  }

  it("把订阅频道写成 channel_type=YOUTUBE 的 user 行，字段按 metadata 映射", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.get("source_user_id")).toBe("UC1");
    expect(ins.get("channel_type")).toBe("YOUTUBE");
    expect(ins.get("name")).toBe("Marques Brownlee");
    expect(ins.get("username")).toBe("@mkbhd");
    expect(ins.get("profile_image_url")).toBe("https://img/1.jpg");
    expect(ins.get("is_follow")).toBe(1);
  });

  // subscriberCount / videoCount 是 API 返回的字符串，D1 列是 INT。
  it("followers_count / post_count 存为数值而不是字符串", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.get("followers_count")).toBe(19500000);
    expect(ins.get("post_count")).toBe(1680);
  });

  // 不知道 ≠ 是零。
  it("hiddenSubscriberCount 的频道不写 followers_count（保持 null，不写 0）", async () => {
    const hidden = { ...MKBHD, statistics: { videoCount: "12", viewCount: "1", hiddenSubscriberCount: true } };
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([hidden]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.sql).not.toContain("followers_count");
    expect(ins.get("post_count")).toBe(12);
  });

  it("未映射的 viewCount / country 落进 raw_data，已映射的不重复存", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const raw = JSON.parse(String(insertOf(tenantDb).get("raw_data")));
    expect(raw.statistics.viewCount).toBe("4321000000");
    expect(raw.snippet.country).toBe("US");
    expect(raw.statistics.subscriberCount).toBeUndefined();
    expect(raw.snippet.title).toBeUndefined();
  });

  it("120 个订阅分成 3 批 channels.list", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `UC${i}`);
    fetchMock
      .mockResolvedValueOnce(subsPage(ids))
      .mockResolvedValueOnce(channelsPage([]))
      .mockResolvedValueOnce(channelsPage([]))
      .mockResolvedValueOnce(channelsPage([]));

    await runYouTubeSubscriptionsPoller(baseCtx() as any);

    const channelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"));
    expect(channelCalls).toHaveLength(3);
    expect(String(channelCalls[0][0]).split("id=")[1].split("&")[0].split("%2C")).toHaveLength(50);
    expect(String(channelCalls[2][0]).split("id=")[1].split("&")[0].split("%2C")).toHaveLength(20);
  });

  it("没有 channel_poll_state 行时自播种，并更新 last_polled_at", async () => {
    fetchMock.mockResolvedValueOnce(subsPage([])).mockResolvedValue(channelsPage([]));
    const linkDb = createMockLinkDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ linkDb }) as any);

    expect(linkDb._runs.some((r) => r.sql.includes("INSERT OR IGNORE INTO channel_poll_state"))).toBe(true);
    expect(linkDb._runs.some((r) => r.sql.includes("last_polled_at = datetime('now')"))).toBe(true);
  });

  it("消失的频道置 is_follow = 0，行不删除", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb(
      { UC_GONE: { id: "stored-gone", created_at: "2026-07-01T00:00:00.000Z", is_follow: 1, is_followed: 0 } },
      [{ source_user_id: "UC1" }, { source_user_id: "UC_GONE" }]
    );

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const unfollow = tenantDb.query.mock.calls.find(
      (c: any[]) => String(c[0]).includes("INSERT INTO user") && (c[1] as unknown[]).includes("UC_GONE")
    );
    expect(unfollow).toBeTruthy();
    const sql = String(unfollow![0]);
    expect(sql).toContain("is_follow = excluded.is_follow");
    expect(sql).not.toContain("name = excluded.name");
    expect(tenantDb.query.mock.calls.every((c: any[]) => !String(c[0]).includes("DELETE"))).toBe(true);
  });

  // 本 plan 里最重要的一条：半份列表做 diff 会把仍在订阅的频道误置 is_follow = 0。
  it("subscriptions.list 中途失败时不做 diff", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1"], "p2"))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC1" }, { source_user_id: "UC_GONE" }]);

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const touchedGone = tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"));
    expect(touchedGone).toBe(false);
  });

  it("channels.list 某一批失败时跳过该批且不做 diff", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `UC${i}`);
    fetchMock
      .mockResolvedValueOnce(subsPage(ids))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC_GONE" }]);

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    // 第二批成功了，所以 UC1 被写入；但整轮不完整，UC_GONE 不能被置 0
    expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC1"))).toBe(true);
    expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
  });

  it("按实际调用次数记配额（读调用 1 unit）", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { KV: { get: vi.fn().mockResolvedValue("0"), put } } as any;

    await runYouTubeSubscriptionsPoller(baseCtx({ env }) as any);

    // 1 次 subscriptions.list + 1 次 channels.list = 2 units，绝不是 50 的倍数
    const written = put.mock.calls.filter((c) => String(c[0]).startsWith("yt_quota:")).map((c) => Number(c[1]));
    expect(Math.max(...written)).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/pollers/youtube-subscriptions.test.ts
```

Expected: FAIL —— 模块 `../../../src/services/pollers/youtube-subscriptions` 不存在。

- [ ] **Step 3: 实现**

新建 `link/src/services/pollers/youtube-subscriptions.ts`：

```ts
import type { Env, Pipeline } from "../../types";
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { EntityStateStore } from "../entity-state";
import { UsersService } from "../users";
import { resolveProps } from "./resolve-props";
import { recordYouTubeQuota } from "../youtube-quota";
import {
  fetchSubscribedChannelIds,
  fetchChannelDetails,
  CHANNELS_BATCH_SIZE,
  type YouTubeChannelItem,
} from "../youtube-subscriptions-api";
import { UserMetadata_YouTube } from "../../../../metadata/youtube";

const YT_USER_META = UserMetadata_YouTube.find((m) => m.sourceUserType === "own:get-subscriptions")!;

// 被订阅的频道写成 user 行时的 channel_type。账号行本身是 YOUTUBE_ACCOUNT ——
// 两者不是一回事，写混了会让 Users 列表把账号自己也算成一个被关注的人。
const SUBSCRIBED_CHANNEL_TYPE = "YOUTUBE";

export interface YouTubeSubscriptionsPollerContext {
  env: Env;
  accountChannelId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  entityState: EntityStateStore;
  tenantId: number;
  pipelineUser?: Pipeline;
  deadline: number;
}

// D1 的 INT 列：API 返回的是字符串（"19500000"）。空串/非数字一律返回 undefined，
// 让 persistUser 跳过该列而不是写 0 —— 不知道 ≠ 是零。
function toInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export async function runYouTubeSubscriptionsPoller(ctx: YouTubeSubscriptionsPollerContext): Promise<void> {
  // 自播种。X 的 poller 语义是「没有 state 行 = 未授权」，YouTube 不同：授权凭证
  // 就在 channels 行的 config 里，这张表在这里只承担节流时间戳的职责。自播种消掉
  // 了播种时序这一整类 bug，也不需要给存量频道补行的运维脚本。
  await ctx.linkDb
    .prepare("INSERT OR IGNORE INTO channel_poll_state (channel_id, poller_name) VALUES (?, 'subscriptions')")
    .bind(ctx.accountChannelId)
    .run();

  const walk = await fetchSubscribedChannelIds(ctx.accessToken, ctx.deadline);
  if (walk.calls > 0) await recordYouTubeQuota(ctx.env, walk.calls);
  let completeWalk = walk.complete;

  console.log(JSON.stringify({
    event: "youtube_subscriptions_poll_started",
    account_channel_id: ctx.accountChannelId,
    subscribed: walk.ids.length,
    completeWalk,
  }));

  const usersService = new UsersService(ctx.tenantDb, {
    pipelineUser: ctx.pipelineUser,
    tenantId: ctx.tenantId,
    entityState: ctx.entityState,
  });

  const seen = new Set<string>();
  for (let i = 0; i < walk.ids.length; i += CHANNELS_BATCH_SIZE) {
    if (Date.now() >= ctx.deadline) {
      // 还有批次没跑完 —— 本轮的「订阅列表」是残缺的，不能拿来判定取消订阅。
      completeWalk = false;
      console.log(JSON.stringify({
        event: "youtube_subscriptions_poll_deadline",
        account_channel_id: ctx.accountChannelId, processed: seen.size,
      }));
      break;
    }

    const batch = walk.ids.slice(i, i + CHANNELS_BATCH_SIZE);
    let items: YouTubeChannelItem[];
    try {
      items = await fetchChannelDetails(ctx.accessToken, batch);
      await recordYouTubeQuota(ctx.env, 1);
    } catch (e) {
      // 这一批的频道本轮没拿到数据，因此它们「不在本次结果里」不能被解释成取消订阅。
      completeWalk = false;
      console.error(JSON.stringify({
        event: "youtube_channels_batch_error",
        account_channel_id: ctx.accountChannelId, batchStart: i, error: String(e),
      }));
      continue;
    }

    for (const item of items) {
      // 全量 payload 进日志不进库（CLAUDE.md）。
      console.log(JSON.stringify({ event: "youtube_channel_raw", channel_id: item.id, payload: item }));

      const props = resolveProps(item as unknown as Record<string, unknown>, YT_USER_META.userProps, YT_USER_META.linkPrefix);
      const followers = toInt(props.followers_count);
      const posts = toInt(props.post_count);
      if (followers === undefined) delete props.followers_count; else props.followers_count = followers;
      if (posts === undefined) delete props.post_count; else props.post_count = posts;

      const sourceUserId = String(props.source_user_id ?? item.id ?? "");
      if (!sourceUserId) continue;
      seen.add(sourceUserId);

      await usersService.upsertUserFromMetadata(
        item as unknown as Record<string, unknown>,
        props,
        ctx.accountChannelId,
        SUBSCRIBED_CHANNEL_TYPE,
        YT_USER_META
      );
    }
  }

  if (completeWalk) {
    // 只有完整走查才允许判定取消订阅。半份列表做 diff 会把仍在订阅的频道误置 0 ——
    // 数据准确性优先于「这次也把状态更新掉」。
    const stillFollowed = await ctx.tenantDb.query<{ source_user_id: string }>(
      "SELECT source_user_id FROM user WHERE channel_id = ? AND channel_type = ? AND is_follow = 1",
      [ctx.accountChannelId, SUBSCRIBED_CHANNEL_TYPE]
    );
    const gone = stillFollowed.filter((r) => !seen.has(r.source_user_id));
    for (const row of gone) {
      await usersService.setFollowState(ctx.accountChannelId, SUBSCRIBED_CHANNEL_TYPE, row.source_user_id, { is_follow: 0 });
    }
    if (gone.length > 0) {
      console.log(JSON.stringify({
        event: "youtube_subscriptions_unfollowed",
        account_channel_id: ctx.accountChannelId, count: gone.length,
      }));
    }
  } else {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_diff_skipped",
      account_channel_id: ctx.accountChannelId,
      reason: "incomplete_walk",
    }));
  }

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'subscriptions'")
    .bind(ctx.accountChannelId)
    .run();

  console.log(JSON.stringify({
    event: "youtube_subscriptions_poll_complete",
    account_channel_id: ctx.accountChannelId, upserted: seen.size, completeWalk,
  }));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test -- tests/services/pollers/youtube-subscriptions.test.ts && npm run typecheck
```

Expected: 10 passed。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/pollers/youtube-subscriptions.ts \
        link/tests/services/pollers/youtube-subscriptions.test.ts
git commit -m "feat(link): YouTube subscriptions poller writes subscribed channels as users

Full walk of subscriptions.list, then channels.list in batches of 50 for
the statistics. Unsubscribed channels get is_follow=0 (row kept), and the
diff is skipped entirely whenever the walk was incomplete."
```

---

## Task 5: 账号级同步入口 + OAuth 接线

**Files:**
- Create: `link/src/services/tenant-db.ts`
- Rewrite: `link/src/services/youtube-account.ts`
- Modify: `link/src/services/pollers/poll-channel.ts:23-30`（删掉私有 `resolveTenantDb`，改为 import）
- Modify: `link/src/oauth.ts:9,635`
- Test: `link/tests/services/youtube-account.test.ts`（新建）

**Interfaces:**
- Consumes: Task 4 的 `runYouTubeSubscriptionsPoller`
- Produces:
  ```ts
  // link/src/services/tenant-db.ts
  export async function resolveTenantDb(env: Env, tenantId: number): Promise<TenantDataDB | null>;
  // link/src/services/youtube-account.ts
  export async function syncYouTubeSubscriptionUsers(
    env: Env, accountChannelId: string, budgetMs?: number
  ): Promise<void>;
  ```
  Task 6 依赖 `syncYouTubeSubscriptionUsers`。

**背景（实现者必读）：** `syncYouTubeSubscriptions`（旧函数）被 `link/src/oauth.ts:635` 的 `waitUntil` 调用，作用是把订阅列表快照写进 `channels.config.subscriptions`。本 task 把它整体换掉：新函数不再写快照，改为调 Task 4 的 poller 写 user 行。`config.sync_status` / `last_synced_at` **保留**（前端 `useYouTubeAccount.ts` 靠 `sync_status` 显示「正在同步你的订阅…」），但写法必须换成 `json_set` —— `YouTubeTokenService.forceRefresh` 会整体重写 `config`，读改写会与它互相覆盖。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/services/youtube-account.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncYouTubeSubscriptionUsers } from "../../src/services/youtube-account";

vi.mock("../../src/services/pollers/youtube-subscriptions", () => ({
  runYouTubeSubscriptionsPoller: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/tenant-db", () => ({
  resolveTenantDb: vi.fn(),
}));
import { runYouTubeSubscriptionsPoller } from "../../src/services/pollers/youtube-subscriptions";
import { resolveTenantDb } from "../../src/services/tenant-db";

function createEnv(channelRow: Record<string, unknown> | null) {
  const runs: { sql: string; params: unknown[] }[] = [];
  const LINK_DB = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: unknown[]) => ({
        first: vi.fn().mockResolvedValue(channelRow),
        run: vi.fn().mockImplementation(async () => { runs.push({ sql, params }); return { success: true }; }),
      })),
    })),
  };
  return { env: { LINK_DB, KV: { get: vi.fn(), put: vi.fn() } } as any, runs };
}

const CHANNEL_ROW = {
  id: "acct-1",
  tenant_id: 42,
  config: JSON.stringify({ access_token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
};

describe("syncYouTubeSubscriptionUsers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("租户 D1 未 provision 时，在任何 YouTube API 调用前就退出", async () => {
    (resolveTenantDb as any).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv(CHANNEL_ROW);

    await syncYouTubeSubscriptionUsers(env, "acct-1");

    expect(runYouTubeSubscriptionsPoller).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("channels 行不存在时静默返回", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    const { env } = createEnv(null);

    await syncYouTubeSubscriptionUsers(env, "missing");

    expect(runYouTubeSubscriptionsPoller).not.toHaveBeenCalled();
  });

  it("正常路径调 poller，并把 sync_status 写成 done", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    vi.stubGlobal("fetch", vi.fn());
    const { env, runs } = createEnv(CHANNEL_ROW);

    await syncYouTubeSubscriptionUsers(env, "acct-1");

    expect(runYouTubeSubscriptionsPoller).toHaveBeenCalledTimes(1);
    const statusWrite = runs.find((r) => r.sql.includes("json_set"));
    expect(statusWrite).toBeTruthy();
    // 整体重写 config 会与 token 刷新互相覆盖 —— 必须是 json_set 定点改
    expect(statusWrite!.sql).toContain("$.sync_status");
    expect(statusWrite!.sql).not.toMatch(/SET\s+config\s*=\s*\?/);
    expect(statusWrite!.params).toContain("done");
  });

  it("poller 抛错时把 sync_status 写成 error 而不是让异常逃逸", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    (runYouTubeSubscriptionsPoller as any).mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", vi.fn());
    const { env, runs } = createEnv(CHANNEL_ROW);

    await expect(syncYouTubeSubscriptionUsers(env, "acct-1")).resolves.toBeUndefined();

    expect(runs.find((r) => r.sql.includes("json_set"))!.params).toContain("error");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/youtube-account.test.ts
```

Expected: FAIL —— `syncYouTubeSubscriptionUsers` 未导出、`src/services/tenant-db` 不存在。

- [ ] **Step 3: 实现**

3a. 新建 `link/src/services/tenant-db.ts`（内容原样搬自 `poll-channel.ts:23-30` 的私有实现，注释一并搬过来）：

```ts
import type { Env } from "../types";
import { TenantDataDB } from "../../../shared/tenant-data-db";

// Per-tenant D1 —— user/content 的真相（2026-07-26 计划）。租户还没 provision 数据库时
// 返回 null（dev 上有几个这种状态的 e2e 测试租户）。每个调用方看到 null 都必须在**任何**
// 外部 API 调用之前跳过，而不是只跳过 D1 写入 —— 为一个存不下结果的租户烧 token 刷新和
// 抓取预算是没有意义的。
export async function resolveTenantDb(env: Env, tenantId: number): Promise<TenantDataDB | null> {
  const tenant = await env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ d1_database_id: string | null }>();
  if (!tenant?.d1_database_id) return null;
  return new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);
}
```

3b. `link/src/services/pollers/poll-channel.ts`：删除私有的 `resolveTenantDb` 函数（含 `TenantDataDB` 的 import，如果不再被别处使用），改为：

```ts
import { resolveTenantDb } from "../tenant-db";
```

其余调用点一字不改。

3c. 重写 `link/src/services/youtube-account.ts`：

```ts
import type { Env } from "../types";
import { YouTubeTokenService } from "./youtube-token";
import { EntityStateStore } from "./entity-state";
import { resolveTenantDb } from "./tenant-db";
import { runYouTubeSubscriptionsPoller } from "./pollers/youtube-subscriptions";

// OAuth 连接后立即跑一次，之后由每天一次的 cron 接手（poll-channel.ts）。两条路径
// 共用这一个入口，是为了让「一个 YouTube 账号跑一轮订阅同步」只有一份实现。
// budgetMs 默认给 OAuth 的 waitUntil 留余量；cron 侧传自己的 per-channel 预算。
export async function syncYouTubeSubscriptionUsers(
  env: Env,
  accountChannelId: string,
  budgetMs = 25_000
): Promise<void> {
  const row = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE id = ? AND channel_type = 'YOUTUBE_ACCOUNT' AND is_active = 1")
    .bind(accountChannelId)
    .first<{ id: string; config: string; tenant_id: number | null }>();
  if (!row || !row.tenant_id) return;

  // 在任何 YouTube API 调用（含 token 刷新）之前守住 —— 存不下就别抓。
  const tenantDb = await resolveTenantDb(env, row.tenant_id);
  if (!tenantDb) {
    console.log(JSON.stringify({
      event: "youtube_subscriptions_sync_skipped_no_tenant_db",
      account_channel_id: accountChannelId, tenant_id: row.tenant_id,
    }));
    return;
  }

  let syncStatus = "done";
  try {
    const tokenService = new YouTubeTokenService(env.LINK_DB, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(accountChannelId);

    await runYouTubeSubscriptionsPoller({
      env,
      accountChannelId,
      accessToken,
      linkDb: env.LINK_DB,
      tenantDb,
      entityState: new EntityStateStore(env.LINK_DB, row.tenant_id),
      tenantId: row.tenant_id,
      pipelineUser: env.PIPELINE_USER,
      deadline: Date.now() + budgetMs,
    });
  } catch (e) {
    syncStatus = "error";
    console.error(JSON.stringify({
      event: "youtube_subscriptions_sync_error",
      account_channel_id: accountChannelId, error: String(e),
    }));
  }

  // json_set 定点改这两个 key，绝不整体重写 config —— YouTubeTokenService.forceRefresh
  // 会整体重写 config，读改写会与它互相覆盖（本仓库在 X 冻结标记上踩过这个坑）。
  await env.LINK_DB
    .prepare(
      `UPDATE channels
          SET config = json_set(config, '$.sync_status', ?, '$.last_synced_at', ?),
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(syncStatus, new Date().toISOString(), accountChannelId)
    .run();
}
```

3d. `link/src/oauth.ts`：

- 第 9 行：`import { syncYouTubeSubscriptions } from "./services/youtube-account";` → `import { syncYouTubeSubscriptionUsers } from "./services/youtube-account";`
- 第 635 行：
  ```ts
  c.executionCtx.waitUntil(syncYouTubeSubscriptionUsers(c.env, actualChannelId));
  ```
  （新入口自己用 `YouTubeTokenService.getValidToken` 取 token，不再需要把 `tokens.accessToken()` 传进去——config 此刻刚写好，`getValidToken` 会直接命中未过期的 access_token。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test && npm run typecheck
```

Expected: 新增 4 个通过；`poll-channel` 相关既有测试全绿（`resolveTenantDb` 只是换了住处，行为不变）。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/tenant-db.ts link/src/services/youtube-account.ts \
        link/src/services/pollers/poll-channel.ts link/src/oauth.ts \
        link/tests/services/youtube-account.test.ts
git commit -m "feat(link): syncYouTubeSubscriptionUsers replaces the config.subscriptions snapshot

OAuth connect now runs one subscriptions sync that writes user rows.
sync_status/last_synced_at survive, written with json_set so a concurrent
token refresh can't clobber them."
```

---

## Task 6: 接进每天一次的 cron

**Files:**
- Modify: `link/src/services/pollers/poll-channel.ts`（`shouldPoll` 签名、新增 `pollYouTubeChannel`、`pollChannelOnce` 分支）
- Modify: `link/src/cron.ts:215`（`handlePolling` 的候选频道 SELECT）
- Test: `link/tests/services/poll-channel-youtube.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5 的 `syncYouTubeSubscriptionUsers(env, accountChannelId, budgetMs?)`
- Produces: 无新的对外接口（`pollChannelOnce` 的既有签名 `(env, channelType, channelId)` 不变）

**背景（实现者必读）：** `shouldPoll(env, channelId, pollerName)` 目前硬编码 `REPOLL_INTERVAL_MS = 55 * 60 * 1000`。YouTube 要 23 小时，所以加第 4 个可选参数，X/TikTok 调用点一字不改。`handlePolling` 的 SELECT 里有个 `json_extract(config, '$.x_frozen_at') IS NULL` 条件——YouTube 行从不带这个 key，`json_extract` 返回 NULL，条件恒真，无副作用。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/services/poll-channel-youtube.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/youtube-account", () => ({
  syncYouTubeSubscriptionUsers: vi.fn().mockResolvedValue(undefined),
}));
import { syncYouTubeSubscriptionUsers } from "../../src/services/youtube-account";
import { pollChannelOnce } from "../../src/services/pollers/poll-channel";

function createEnv(channelRow: Record<string, unknown> | null, pollState: Record<string, unknown> | null) {
  const runs: string[] = [];
  const LINK_DB = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(sql.includes("channel_poll_state") ? pollState : channelRow),
        run: vi.fn().mockImplementation(async () => { runs.push(sql); return { success: true }; }),
      }),
    })),
  };
  return { env: { LINK_DB } as any, runs };
}

const YT_ROW = { id: "acct-1", tenant_id: 42, config: JSON.stringify({ access_token: "tok" }) };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("pollChannelOnce YOUTUBE_ACCOUNT", () => {
  beforeEach(() => vi.clearAllMocks());

  it("距上次同步 24 小时 —— 跑", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 1, last_polled_at: hoursAgo(24) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledWith(env, "acct-1", expect.any(Number));
  });

  // 每小时的 cron 会反复看到这个频道；23 小时的节流是配额天花板的直接体现
  // （10,000 units/天是整个 Google Cloud 项目共享的，不是每租户）。
  it("距上次同步 22 小时 —— 跳过", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 1, last_polled_at: hoursAgo(22) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });

  it("从没同步过（last_polled_at 为 null）—— 跑", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 0, last_polled_at: null });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  // poller 自播种，所以「没有 state 行」等价于「从没跑过」，必须跑而不是跳过 ——
  // 这与 X 的语义（没有 state 行 = 未授权 = 跳过）相反，是刻意的。
  it("没有 channel_poll_state 行 —— 跑", async () => {
    const { env } = createEnv(YT_ROW, null);
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  it("没有 tenant_id —— 跳过", async () => {
    const { env } = createEnv({ ...YT_ROW, tenant_id: null }, { backfill_complete: 1, last_polled_at: hoursAgo(48) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });
});
```

同时在 `link/tests/services/` 下已有的 cron 测试之外，新增一条对 SELECT 的断言（放在同一个新文件里）：

```ts
import { handlePolling } from "../../src/cron";

describe("handlePolling 候选频道", () => {
  it("把 YOUTUBE_ACCOUNT 纳入候选", async () => {
    const prepare = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    await handlePolling({ LINK_DB: { prepare } } as any);
    expect(String(prepare.mock.calls[0][0])).toContain("'YOUTUBE_ACCOUNT'");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/poll-channel-youtube.test.ts
```

Expected: FAIL —— `pollChannelOnce` 对 `YOUTUBE_ACCOUNT` 无分支，`syncYouTubeSubscriptionUsers` 从未被调用；SELECT 里没有 `'YOUTUBE_ACCOUNT'`。

- [ ] **Step 3: 实现**

`link/src/services/pollers/poll-channel.ts`：

顶部新增 import：

```ts
import { syncYouTubeSubscriptionUsers } from "../youtube-account";
```

在 `REPOLL_INTERVAL_MS` 旁边新增：

```ts
// YouTube 的 10,000 units/天配额是整个 Google Cloud 项目共享的，不是每租户。
// 每小时刷一次订阅 = 192 units/天/账号，50 个账号就吃光池子并饿死同池的
// videos.list（content trigger）和写操作（50 units/次）。每天一次 = 8 units/天/账号。
const YOUTUBE_REPOLL_INTERVAL_MS = 23 * 60 * 60 * 1000;
```

`shouldPoll` 签名加第 4 个可选参数（函数体只改比较用的那个常量）：

```ts
async function shouldPoll(
  env: Env,
  channelId: string,
  pollerName: string,
  intervalMs: number = REPOLL_INTERVAL_MS
): Promise<boolean> {
```

函数体里 `if (elapsedMs < REPOLL_INTERVAL_MS)` → `if (elapsedMs < intervalMs)`。**其余不改** —— 尤其是「没有 state 行则返回 false」那段留给 X/TikTok。

新增 YouTube 分支（放在 `pollTikTokChannel` 之后）：

```ts
// YouTube 与 X/TikTok 有两处刻意的差异：
// 1) 没有 channel_poll_state 行 = 从没同步过 = 应该跑（poller 会自播种）。X 那边
//    「没有行」意味着未授权；YouTube 的授权凭证就在 channels 行的 config 里。
// 2) 节流 23 小时而不是 55 分钟（共享配额，见 YOUTUBE_REPOLL_INTERVAL_MS）。
// tenantDb 解析与 token 刷新都在 syncYouTubeSubscriptionUsers 里，这里只做调度判断。
async function pollYouTubeChannel(env: Env, row: { id: string; config: string; tenant_id: number | null }): Promise<void> {
  if (!row.tenant_id) return;

  const state = await env.LINK_DB
    .prepare("SELECT last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'subscriptions'")
    .bind(row.id)
    .first<{ last_polled_at: string | null }>();

  if (state?.last_polled_at) {
    const elapsedMs = Date.now() - new Date(state.last_polled_at).getTime();
    if (elapsedMs < YOUTUBE_REPOLL_INTERVAL_MS) {
      console.log(JSON.stringify({ event: "youtube_subscriptions_poll_skipped_too_recent", channel_id: row.id, elapsedMs }));
      return;
    }
  }

  try {
    await syncYouTubeSubscriptionUsers(env, row.id, PER_CHANNEL_BUDGET_MS);
  } catch (e) {
    console.error(JSON.stringify({ event: "youtube_subscriptions_poll_error", channel_id: row.id, error: String(e) }));
  }
}
```

`pollChannelOnce` 增加分支：

```ts
  if (channelType === "X") {
    await pollXChannel(env, row);
  } else if (channelType === "TIKTOK") {
    await pollTikTokChannel(env, row);
  } else if (channelType === "YOUTUBE_ACCOUNT") {
    await pollYouTubeChannel(env, row);
  }
```

`link/src/cron.ts` 第 215 行的 SELECT 改为：

```ts
    .prepare("SELECT id, channel_type FROM channels WHERE channel_type IN ('X', 'TIKTOK', 'YOUTUBE_ACCOUNT') AND is_active = 1 AND json_extract(config, '$.x_frozen_at') IS NULL")
    .all<{ id: string; channel_type: "X" | "TIKTOK" | "YOUTUBE_ACCOUNT" }>();
```

（`json_extract` 对 YouTube 行返回 NULL，条件恒真，无副作用；注释里补一句说明。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd link && npm test && npm run typecheck
```

Expected: 新增 6 个通过；X / TikTok 的 poll 相关既有测试全绿（`shouldPoll` 的默认参数保证行为不变）。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/services/pollers/poll-channel.ts link/src/cron.ts \
        link/tests/services/poll-channel-youtube.test.ts
git commit -m "feat(link): run the YouTube subscriptions sync once a day from cron

23h throttle rather than the X/TikTok 55min one: the 10k/day YouTube
quota is shared across the whole Google Cloud project, not per tenant."
```

---

## Task 7: 选择器实时拉取 + 计数改查 D1

**Files:**
- Modify: `link/src/routes-channels.ts:295-332`（`GET /youtube/status` 与 `GET /youtube/subscriptions`）
- Test: `link/tests/services/routes-channels-youtube.test.ts`（新建）

**Interfaces:**
- Consumes: `link/src/services/youtube-api.ts` 的 `fetchAllSubscriptions(accessToken)`（既有，不改）；`YouTubeTokenService.getValidToken`；middleware 注入的 `tenantDataDb`
- Produces: 两个路由的响应结构**与改动前完全一致**（`flow/frontend/components/Inspector.tsx`、`flow/frontend/lib/api.ts`、`link/frontend/hooks/useYouTubeAccount.ts` 均零改动）

**背景（实现者必读）：**
- `GET /youtube/subscriptions` 现在返回 `{connected, accountChannelId, email, subscriptions: {channelId, channelName, thumbnailUrl}[]}`，数据来自 `config.subscriptions`。改为实时调 `fetchAllSubscriptions`，**返回结构一字不改**。
- `GET /youtube/status` 现在返回 `{connected, email, channel_title, sync_status, subscription_count, created_at}`，`subscription_count` 来自 `config.subscriptions.length`。改为查 per-tenant D1 的 `user` 表。
- middleware 在 `c.get("tenantDataDb")` 注入 `TenantDataDB | undefined`（`link/src/middleware.ts:53`）——租户未 provision 时是 undefined，此时 `subscription_count` 返回 0，**不要**返 503（status 是页面加载就调的，未 provision 不是错误状态）。
- 完成本 task 后，`config.subscriptions` 在整个代码库中应无任何读点。用 `grep -rn "config.subscriptions\|\.subscriptions" link/src` 确认。

- [ ] **Step 1: 写失败的测试**

新建 `link/tests/services/routes-channels-youtube.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../../src/routes-channels";

// 组一个最小的 app：注入 tenantId / tenantDataDb，挂上被测路由。
// channelsRoutes() 返回一个 Hono<{ Bindings: Env }> 路由器（src/routes-channels.ts:19）。
function createApp(opts: {
  channelRow: Record<string, unknown> | null;
  tenantDataDb?: { query: ReturnType<typeof vi.fn> };
}) {
  const LINK_DB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(opts.channelRow),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    }),
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 42 as never);
    c.set("tenantDataDb" as never, opts.tenantDataDb as never);
    await next();
  });
  app.route("/", channelsRoutes());
  return { app, env: { LINK_DB, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs" } as any };
}

const ACCOUNT_ROW = {
  id: "acct-1",
  created_at: "2026-07-01T00:00:00.000Z",
  config: JSON.stringify({
    email: "a@b.com",
    channel_title: "My Channel",
    sync_status: "done",
    access_token: "tok",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    // 故意留一份旧快照：路由绝不能再读它
    subscriptions: [{ channelId: "STALE", channelName: "stale", thumbnailUrl: "" }],
  }),
};

describe("GET /youtube/subscriptions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("实时拉取，不读 config.subscriptions 里的旧快照", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      items: [{ snippet: { resourceId: { channelId: "UC1" }, title: "Fresh", thumbnails: { default: { url: "u" } } } }],
    }), { status: 200 }));
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW });

    const res = await app.request("/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.subscriptions).toEqual([{ channelId: "UC1", channelName: "Fresh", thumbnailUrl: "u" }]);
    expect(JSON.stringify(body)).not.toContain("STALE");
    // 响应结构与改动前一致 —— flow 前端零改动的前提
    expect(body).toMatchObject({ connected: true, accountChannelId: "acct-1", email: "a@b.com" });
  });

  it("未连接时返回空列表", async () => {
    const { app, env } = createApp({ channelRow: null });
    const body = await (await app.request("/youtube/subscriptions", {}, env)).json() as any;
    expect(body).toEqual({ connected: false, accountChannelId: null, subscriptions: [] });
  });

  it("YouTube API 失败时返回空列表而不是 5xx", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW });

    const res = await app.request("/youtube/subscriptions", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).subscriptions).toEqual([]);
  });
});

describe("GET /youtube/status", () => {
  it("subscription_count 来自 per-tenant D1 的 user 表，不是 config 快照", async () => {
    const query = vi.fn().mockResolvedValue([{ c: 7 }]);
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW, tenantDataDb: { query } });

    const body = await (await app.request("/youtube/status", {}, env)).json() as any;

    expect(body.subscription_count).toBe(7);
    expect(String(query.mock.calls[0][0])).toContain("is_follow = 1");
    expect(String(query.mock.calls[0][0])).toContain("channel_type");
    expect(body).toMatchObject({ connected: true, email: "a@b.com", channel_title: "My Channel", sync_status: "done" });
  });

  it("租户 D1 未 provision 时计数为 0，且仍是 200", async () => {
    const { app, env } = createApp({ channelRow: ACCOUNT_ROW, tenantDataDb: undefined });
    const res = await app.request("/youtube/status", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).subscription_count).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd link && npm test -- tests/services/routes-channels-youtube.test.ts
```

Expected: FAIL —— `/youtube/subscriptions` 返回快照里的 `STALE`；`/youtube/status` 的计数来自 config。

- [ ] **Step 3: 实现**

`link/src/routes-channels.ts`，`GET /youtube/status`：

```ts
  router.get("/youtube/status", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const row = await c.env.LINK_DB
      .prepare("SELECT id, config, created_at FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string; created_at: string }>();
    if (!row) return c.json({ connected: false });

    const config = JSON.parse(row.config) as { email?: string; channel_title?: string; sync_status?: string };

    // 订阅数的真相现在是 per-tenant D1 的 user 表（is_follow = 1 的 YOUTUBE 行），
    // 不再是 config 里的快照。租户还没 provision 数据库时返 0 而不是报错 ——
    // 这个接口是页面加载就调的，未 provision 不是错误状态。
    const tenantDb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    let subscriptionCount = 0;
    if (tenantDb) {
      try {
        const rows = await tenantDb.query<{ c: number }>(
          "SELECT COUNT(*) AS c FROM user WHERE channel_id = ? AND channel_type = 'YOUTUBE' AND is_follow = 1",
          [row.id]
        );
        subscriptionCount = Number(rows[0]?.c ?? 0);
      } catch (e) {
        console.error(JSON.stringify({ event: "youtube_status_count_error", channel_id: row.id, error: String(e) }));
      }
    }

    return c.json({
      connected: true,
      email: config.email,
      channel_title: config.channel_title,
      sync_status: config.sync_status,
      subscription_count: subscriptionCount,
      created_at: row.created_at,
    });
  });
```

`GET /youtube/subscriptions`：

```ts
  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string }>();
    if (!accountRow) return c.json({ connected: false, accountChannelId: null, subscriptions: [] });

    const config = JSON.parse(accountRow.config) as { email?: string };

    // 实时拉取，不吃快照 —— 用户新订阅的频道必须立刻出现在 flow 的选择器里。
    // 与 YouTube Condition 节点已定的「取实时 API 数据、不吃快照」同一原则。
    // 失败时返回空列表而不是 5xx：前端已有「No subscriptions found」空态，
    // 一个配额问题不该让整个 Inspector 报错。
    let subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] = [];
    try {
      const tokenService = new YouTubeTokenService(c.env.LINK_DB, c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET);
      const accessToken = await tokenService.getValidToken(accountRow.id);
      subscriptions = await fetchAllSubscriptions(accessToken);
    } catch (e) {
      console.error(JSON.stringify({ event: "youtube_subscriptions_fetch_error", channel_id: accountRow.id, error: String(e) }));
    }

    return c.json({
      connected: true,
      accountChannelId: accountRow.id,
      email: config.email,
      subscriptions,
    });
  });
```

按需在文件顶部补 import：`fetchAllSubscriptions`（来自 `./services/youtube-api`）、`TenantDataDB` 类型（来自 `../../shared/tenant-data-db`）。`YouTubeTokenService` 该文件已有 import（`/youtube/playlists` 在用）。

- [ ] **Step 4: 跑测试确认通过 + 确认快照彻底无人读**

```bash
cd link && npm test && npm run typecheck
grep -rn "config.subscriptions" src/ || echo "OK: no readers of config.subscriptions left"
```

Expected: 全套通过；grep 无输出（除注释外）。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/routes-channels.ts link/tests/services/routes-channels-youtube.test.ts
git commit -m "feat(link): fetch the flow subscription picker live; count subs from D1

Response shapes unchanged, so flow's Inspector and link's account card
need no frontend edits. config.subscriptions now has no readers."
```

---

## 部署与自测（全部 task 完成后）

- [ ] **Step 1: 全量测试与类型检查**

```bash
cd link && npm test && npm run typecheck
cd /Users/zc/Documents/UniSCRM/uniscrm-web && node scripts/tenant-scope-audit.mjs
```

- [ ] **Step 2: 部署 dev**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm run deploy:dev
```

**不要**手写 `wrangler deploy --env dev`（会跳过 vite build，发布陈旧前端），**不要**裸 `wrangler deploy`（会打到 PROD 并剥掉 bindings），**不要** `npx wrangler`（会捡到过期的本地 4.86）。

- [ ] **Step 3: 浏览器自测**

复用已登录的 Chrome session（`tabs_context_mcp`），在 `*-dev.uni-scrm.com` 上验证：

1. Social 页 YouTube 卡片显示 `subscription_count`（首次同步后应等于真实订阅数）
2. flow 编辑器打开 YouTube 订阅触发节点，选择器列表非空且是当前真实订阅
3. Users 列表出现 `channel_type = YOUTUBE` 的行，`followers_count` / `post_count` 有值

- [ ] **Step 4: 验证 D1 落库**

```bash
wrangler d1 execute uniscrm-link-dev --remote --command \
  "SELECT channel_id, poller_name, last_polled_at FROM channel_poll_state WHERE poller_name = 'subscriptions'"
```

再对该租户的 `uniscrm-t*` 库查 `SELECT source_user_id, name, username, followers_count, post_count, is_follow FROM user WHERE channel_type = 'YOUTUBE' LIMIT 10`。

- [ ] **Step 5: prod 部署**

prod 由 GitHub Action **手动触发**，本计划不代为执行；且只有在你明确说 "push to main" 时才推送分支。

---

## Notes

- 本计划不新增任何数据库迁移：7 个 propId 对应的列在 tenant D1 `user` 表与 R2 `user_stream` schema 里都已存在。
- 不需要 `sequence.md`（无新增异步队列流程）或 `status.md`（`sync_status` 是 config JSON 的 key，不是数据库表里 `_status` 后缀的列）。
- 已知代价（spec 已记录，非遗漏）：`subscriberCount` 官方只精确到 3 位有效数字；取消订阅但仍被 flow 引用的频道，WebSub 续期不受影响（续期由 flow 的引用驱动），该 flow 仍会收到新视频。
