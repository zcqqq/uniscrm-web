# User/Content 回 per-tenant D1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `user`/`content` 的唯一真相从 R2 Data Catalog 挪回 per-tenant D1,R2 降级为 analytics 专用副本;`event` 不动(R2 唯一真相);只有 metadata `flowType:"content"` 的内容源落库。

**Architecture:** per-tenant D1(经 `TenantDataDB` REST 客户端)承担产品读写与原地 UPDATE;R2 副本沿用上一轮修硬的整行构造器双写;`entity_state` 收缩为两职责(trigger 去重 + flow 热读 follow);恢复建库 provisioning 与 `migrate-tenant-dbs` CI。

**Tech Stack:** Cloudflare Workers + Hono、D1(REST API + binding)、R2 Data Catalog/Pipelines、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-26-user-content-back-to-tenant-d1-design.md`

## Global Constraints

- **id 域纪律**:D1 `user.id` = R2 副本 `id` = `entity_state.entity_id`(D1 铸造的 uuid);`event.user_id`、flow 的 `userId`、flow 写入的 `list_users.user_id` 是**平台源 id**。拿平台 id 查 uuid 域必须经 `source_user_id` 列。上轮 final review 的 2 个 Critical 都是违反此纪律。
- **R2 副本写入仍必须是完整行**,经 `buildUserRecord`/`buildContentRecord`,schema key 集合断言测试保留且必须继续从 schema JSON 导入。
- **flowType 门控必须 metadata 驱动**(branch on `metadata.flowType` 的值),不允许按 poller 名字硬编码。
- R2 读路径(analytics/insight-segment/Users 列表/名字查询)**一律不动**。
- `raw_data` 剥离规则不变:按 metadata `dataId` 路径经 `consumedPaths`,永不按 propId 名。
- git 恢复锚点:**机制类文件**从 `371d0c5^`(Task 11 删除前),**webhook/poller 的 d1DatabaseId 管线**参考 `f503650^`(Task 7 改造前),**D1 写逻辑**参考 `461d039`(迁移基线)。恢复后按任务说明改造,不是原样照抄。
- 恢复文件时**必须剔除**:profile/segment_profiles/event/content_trigger_dedup 表、`content.status`、`user.profile_id`、`setFollowState`/`setUserActive`。这些是上轮迁移里被独立决策删除的,不随恢复回归。
- dev 部署一律模块目录里 `npm run deploy:dev`;禁 `npx wrangler`;prod 只走手动 GitHub Action;不主动 push main。
- 提交只 `git add` 本任务文件,提交后立读 `git show --stat HEAD`;并发 session 可能有未提交文件,禁 `git add -A`/`stash`/`checkout .`/`restore`/`reset --hard`。
- 每任务跑其模块 `npx vitest run` + 根目录 `npm test`(secrets-sync 守卫)+ `node scripts/tenant-scope-audit.mjs`。
- 控制字节检查:所触每文件 `python3 -c "d=open('<f>','rb').read(); print(sum(1 for b in d if b<9 or (10<b<32)))"` → 0。

---

## File Structure

| 文件 | 处理 |
|---|---|
| `shared/tenant-data-db.ts` | **恢复**(371d0c5^ 原样,77 行) |
| `admin/src/services/tenant-init-sql.ts` | **恢复+重写**:仅 user+content 两表 |
| `admin/src/services/tenant-provisioning.ts` | **恢复**(371d0c5^),接回 task-executor |
| `web/worker/services/task-executor.ts`、`web/worker/api/auth.ts`、`oauth.ts` | 恢复 `provision-db` task 创建/执行 |
| `web/migrations/0009_restore_tenant_d1_column.sql` | **新建** |
| `operation/migrate-tenant-dbs.ts`(+空 `operation/migrations/`) | **恢复**(371d0c5^) |
| `.github/workflows/deploy-{dev,prod}.yml` | 恢复 `migrate-tenant-dbs` job + `CF_D1_API_TOKEN` env |
| `link/src/middleware.ts`、`link/src/types.ts` | tenantDataDb 注入回归(与 entityState 并存) |
| `link/src/services/content.ts` | D1 主写 + flowType 门控 + R2 副本 |
| `link/src/services/x-users.ts` | D1 主写 + follow 镜像 + R2 副本 |
| `link/src/webhook.ts`、`webhook-youtube.ts`、`pollers/*`、`routes-internal.ts`、`routes-channels.ts` | d1DatabaseId 管线 + 构造点 |
| `link/src/routes-contents.ts` | 读写回 D1 |
| `docs/adr/0006-*.md`、`docs/adr/0005`、`CLAUDE.md`(AGENTS.md) | 文档随动 |

---

## Task 1: 恢复 TenantDataDB 与新版 tenant-init-sql

**Files:**
- Create: `shared/tenant-data-db.ts`(恢复)
- Create: `admin/src/services/tenant-init-sql.ts`(恢复+重写)
- Test: `admin/tests/unit/tenant-init-sql.test.ts`(新)

**Interfaces:**
- Produces: `class TenantDataDB { constructor(accountId, apiToken, dbId); query<T>(sql, params?): Promise<T[]>; run(sql, params?): Promise<{changes:number}>; batch(stmts): Promise<...>; getDbId(): string }`(与 371d0c5^ 完全一致);`export const TENANT_DB_INIT_SQL: string[]`

- [ ] **Step 1: 原样恢复 REST 客户端**

```bash
git show 371d0c5^:shared/tenant-data-db.ts > shared/tenant-data-db.ts
```

- [ ] **Step 2: 写失败测试**(新 init SQL 的形状断言)

`admin/tests/unit/tenant-init-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TENANT_DB_INIT_SQL } from "../../src/services/tenant-init-sql";

const all = TENANT_DB_INIT_SQL.join("\n");

describe("TENANT_DB_INIT_SQL", () => {
  it("creates exactly the user and content tables — the deleted features stay deleted", () => {
    const tables = [...all.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["content", "user"]);
    for (const gone of ["profile", "segment_profiles", "event", "content_trigger_dedup"]) {
      expect(all).not.toContain(gone);
    }
  });

  it("user has no profile_id and uses post_count (the 0005 rename is baked in)", () => {
    expect(all).not.toContain("profile_id");
    expect(all).not.toContain("tweet_count");
    expect(all).toContain("post_count");
  });

  it("content has no status column and no status index", () => {
    expect(all).not.toMatch(/\bstatus\b/);
  });

  it("keeps the dedup unique indexes both writers rely on", () => {
    expect(all).toContain("idx_user_channel_source");
    expect(all).toContain("idx_content_channel_source");
    expect(all).toContain("idx_content_channel_list_source");
  });
});
```

- [ ] **Step 3: 确认失败** `cd admin && npx vitest run tests/unit/tenant-init-sql.test.ts` → 模块不存在

- [ ] **Step 4: 写新 init SQL**(以 371d0c5^ 版为底,删 profile/segment_profiles/event/content_trigger_dedup 四表、user.profile_id、content.status 及其索引;tweet_count 直接写成 post_count):

```ts
export const TENANT_DB_INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    source_user_id TEXT NOT NULL,
    channel_type TEXT,
    name TEXT,
    username TEXT,
    profile_image_url TEXT,
    description TEXT,
    followers_count INTEGER,
    following_count INTEGER,
    post_count INTEGER,
    listed_count INTEGER,
    like_count INTEGER,
    media_count INTEGER,
    verified_type TEXT,
    raw_data TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER NOT NULL DEFAULT 1,
    is_follow INTEGER NOT NULL DEFAULT 0,
    is_followed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel_source ON user(channel_id, source_user_id)`,
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    channel_type TEXT NOT NULL,
    content_type TEXT,
    source_content_id TEXT NOT NULL,
    list_id TEXT,
    title TEXT,
    content_text TEXT,
    summary TEXT,
    source_url TEXT,
    source_updated_at TEXT,
    source_created_at TEXT,
    bookmark_count INTEGER,
    view_count INTEGER,
    like_count INTEGER,
    quote_count INTEGER,
    reply_count INTEGER,
    repost_count INTEGER,
    share_count INTEGER,
    cover_image_url TEXT,
    duration INTEGER,
    height INTEGER,
    width INTEGER,
    has_face INTEGER,
    raw_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_source ON content(channel_id, source_content_id) WHERE list_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_channel_list_source ON content(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL`,
];
```

注意 user 表比 371d0c5^ 版多了 `verified_type`(R2 副本有此列,D1 真相必须是超集,否则双写构造器无源可取)。

- [ ] **Step 5: 测试通过 + 提交**

```bash
cd admin && npx vitest run tests/unit/tenant-init-sql.test.ts && cd ..
git add shared/tenant-data-db.ts admin/src/services/tenant-init-sql.ts admin/tests/unit/tenant-init-sql.test.ts
git commit -m "feat(admin,shared): restore TenantDataDB and a user+content-only tenant init schema"
```

---

## Task 2: 恢复 provisioning、`d1_database_id` 列与 signup 接线

**Files:**
- Create: `admin/src/services/tenant-provisioning.ts`(恢复自 371d0c5^)
- Modify: `web/worker/services/task-executor.ts`、`web/worker/api/auth.ts`、`web/worker/api/oauth.ts`、`admin/src/index.ts`(对照 `git show 371d0c5^:<path>` 恢复 `provision-db` 相关块)
- Create: `web/migrations/0009_restore_tenant_d1_column.sql`
- Test: 恢复对应旧测试片段(`git show 371d0c5^` 查看当时的测试文件),按需更新

**Interfaces:**
- Consumes: Task 1 的 `TenantDataDB`、`TENANT_DB_INIT_SQL`
- Produces: signup → tenants 行 + `provision-db` task + `activate-trial` task;task-executor 的 `provision-db` case 建库、跑 init SQL、写回 `tenants.d1_database_id`

- [ ] **Step 1: 迁移文件**

```sql
-- web/migrations/0009_restore_tenant_d1_column.sql
-- 0008 dropped this column when user/content moved to R2. The 2026-07-26 design moves
-- them back to per-tenant D1, so the column returns. Backfill is NOT done here: the
-- database ids differ per environment and SQL cannot branch, so a documented
-- per-environment `wrangler d1 execute` (spec §2) repopulates it right after apply.
ALTER TABLE tenants ADD COLUMN d1_database_id TEXT;
```

- [ ] **Step 2: 恢复 provisioning 与接线** — 逐文件 `git show 371d0c5^:<path>` 对照,把 `provision-db` 的 task 创建(auth.ts/oauth.ts signup 处)、task-executor 的执行 case、admin 的 provisioning service 恢复;provisioning 内部换用 Task 1 的新 `TENANT_DB_INIT_SQL`。**不要**恢复那几处当时一并存在的 profile/maigret 相关代码。

- [ ] **Step 3: 应用 dev 迁移并回填**

```bash
wrangler d1 migrations apply uniscrm-web-dev --env dev --config web/wrangler.toml --remote
wrangler d1 execute uniscrm-web-dev --env dev --config web/wrangler.toml --remote \
  --command "UPDATE tenants SET d1_database_id='e2a547ee-94eb-48e0-b3cc-18f882d33c07' WHERE tenant_id=1"
```

(prod 回填命令进 runbook,不在此执行:1→`f5f49e47-d779-49a0-b609-f2b2ab5fd09f`,100000→`ce377715-5196-4ad7-b2d7-a52a75a734d6`,100001→`b8656ee3-3e93-4d8c-b782-0508a824d549`)

- [ ] **Step 4: 测试 + 提交**(web、admin 两模块 vitest;web 有 8 个既有失败与本任务无关,不新增即可)

---

## Task 3: CI:migrate-tenant-dbs job 与 CF_D1_API_TOKEN

**Files:**
- Create: `operation/migrate-tenant-dbs.ts`(恢复自 371d0c5^;`operation/migrations/` 目录恢复为空目录 + `.gitkeep`,旧 5 个迁移**不**恢复——它们已烧进 Task 1 的新 init SQL)
- Modify: `.github/workflows/deploy-dev.yml`、`deploy-prod.yml`
- Modify: `link/.secrets.json`(+`CF_D1_API_TOKEN`)

**Interfaces:**
- Produces: 两个 workflow 恢复 `migrate-tenant-dbs` job(anchor:`git show 371d0c5^:.github/workflows/deploy-prod.yml` 第 99 行起),deploy job 的 `needs` 加回该 job;sync-secrets env 加 `CF_D1_API_TOKEN: ${{ secrets.CF_API_TOKEN }}`(旧映射即如此,无需新 GitHub secret)

- [ ] **Step 1:** 恢复 runner 与 job;两个 workflow 都改。
- [ ] **Step 2:** `link/.secrets.json` 两个 env 各加 `CF_D1_API_TOKEN`。
- [ ] **Step 3: 守卫验证(必须)** `npm test`(根)——secrets-sync 守卫要求声明的 secret 必须被 workflow 导出,顺序错了就红;红则先查 workflow env。
- [ ] **Step 4:** 提交(只这四个文件)。

---

## Task 4: link 中间件与 Env

**Files:**
- Modify: `link/src/types.ts`(Env 加回 `CF_D1_API_TOKEN: string`)、`link/src/middleware.ts`
- Test: `link/tests/`(middleware 相关如有)

**Interfaces:**
- Produces: `authMiddleware` 同时注入 `entityState`(不变)与 `tenantDataDb`(查 `tenants.d1_database_id`,有值才注入——与 f503650^ 时代相同形状);消费方约定:需要 D1 的路由 `const tdb = c.get("tenantDataDb"); if (!tdb) return c.json({ error: "Tenant DB not provisioned" }, 503)`

middleware 注入块(在现有 `c.set("entityState", ...)` 之后追加):

```ts
  const row = await c.env.WEB_DB
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(session.tenant_id)
    .first<{ d1_database_id: string | null }>();
  if (row?.d1_database_id) {
    c.set("tenantDataDb" as never, new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  }
```

- [ ] 测试:有 d1_database_id 时注入、无时不注入;提交。

---

## Task 5: ContentService — D1 真相 + flowType 门控 + R2 副本

**Files:**
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts`

**Interfaces:**
- Consumes: `TenantDataDB`(Task 1)、现有 `buildContentRecord`/`sendContentRecord`/`stripConsumedPaths`/`EntityStateStore.markSeen`
- Produces(后续任务按此调用,签名逐字):
  - `constructor(tenantDb: TenantDataDB | null, vectorize, ai, tenantId, pipelineContent?, flowQueue?, entityState?: EntityStateStore)` — **r2Env 参数删除**
  - `upsertContentFromMetadata(rawItem, resolvedProps, channelId, channelType, emitFlowEvent, listId?, consumedPaths?, flowType?: string): Promise<boolean>` — `flowType !== "content"` 时**抛错**(trigger 内容不该走到这;调用方按 metadata.flowType 分流,此处是防线)
  - `list/get/update/delete` 全走 `tenantDb`(D1);`delete` = D1 硬删 + R2 墓碑(由 D1 行构造完整行,`is_deleted:1`)+ `vectorize.deleteByIds`
  - `recordTriggerContentSeen`/`emitContentTriggerEvent` 不变(entityState.markSeen + flow 事件)

**要点**(D1 写逻辑参考 `461d039:link/src/services/content.ts`,但 R2 send 用现在的 `buildContentRecord`):

- `upsertContentFromMetadata`:D1 SELECT 现有行(按 channel_id+source_content_id+list_id 语义,与旧版相同)→ 得 `id`/`isNew`/`unchanged`(逐列比对 dynamicCols,替代 entity_state 指纹)→ `INSERT ... ON CONFLICT DO UPDATE`(raw_data 用 `json_patch`)→ `!unchanged` 时 `sendContentRecord(buildContentRecord(...))`(`.catch` 记日志即可——R2 是副本,D1 已落;此为有意接受的降级,注释写明)→ embed → flow 事件。id 由 D1 行铸造(新行 `crypto.randomUUID()`),**不再调用 entityState.claim**。
- `syncBatch`:同样回 D1(461d039 形状),R2 send 用现构造器;LOCAL/NOTION 视为 content(落库),注释声明该假设。
- `update`:D1 UPDATE title/summary → 从 D1 读整行 → R2 完整行 send → 重 embed。**不再读 R2**。
- `delete`:D1 SELECT 整行 → D1 DELETE → R2 墓碑(该行 + `is_deleted:1`)→ vectorize 删除。`deleteByKnownIdentity` 保留给 webhook 的 R2-lag 兜底。
- **测试**:flowType 门控正反测试(`flowType:"trigger"` 抛错且零写入;`"content"` D1+R2 都写);schema key 集合断言全部保留;新增「R2 send 失败不影响 D1 结果且下轮 unchanged 不重发(记录日志)」的行为测试;删除所有 entity_state claim/指纹相关的 content 测试。

- [ ] TDD 循环 + `npx vitest run` 全绿 + 提交。

---

## Task 6: XUsersService — D1 真相 + follow 镜像 + R2 副本

**Files:**
- Modify: `link/src/services/x-users.ts`
- Test: `link/tests/services/x-users.test.ts`、`x-followers.test.ts`

**Interfaces:**
- Produces(签名逐字):
  - `constructor(tenantDb: TenantDataDB | null, opts?: { queue?; pipelineEvent?; pipelineUser?; tenantId?: number; entityState?: EntityStateStore })` — **r2Env 删除**
  - `upsertUser(user, channelId, channelType, follow?): Promise<string>`(返回 D1 行 id)
  - `upsertUserFromMetadata(rawItem, resolvedProps, channelId, channelType): Promise<boolean>`
  - `insertEvents(...)` 不变(R2-only,event 无 D1 表)

**要点**(D1 写参考 `461d039`,R2 send 用现 `buildUserRecord`):

- `upsertUser`:D1 SELECT 现有行 → 合并(webhook 只知道 name/username/profile_image_url;**合并源是 D1 行,不再读 R2**,`getUserBySource` 调用删除)→ D1 `INSERT ON CONFLICT DO UPDATE`(含 follow 列,461d039 的 CASE WHEN 保空语义)→ **follow 镜像**:`entityState` 上 `INSERT OR IGNORE`(entity_id=该 D1 id)+ `setFollow`(有 follow 参数时)→ `!unchanged || follow` 时 R2 完整行 send(follow 值从 D1 行读,真实值)。
- `upsertUserFromMetadata`(poller):同构;resolvedProps 含 is_follow/is_followed 时同步 `setFollow` 镜像(上轮 C1 的教训:镜像必须与主写同调用)。
- 删除:`getUserBySource` 的调用(r2-entities 里函数本身保留——有测试,别处可能复用)、`sendUserRecordOrRollback`/`sendContentRecordOrRollback` 与 `rollbackFingerprint` 的调用(entity-state.ts 里方法保留但 user/content 路径不再用;若全仓无调用可删方法及其测试)。
- **测试**:反 null 冲刷(webhook 触已有用户,D1 里的指标列进入 R2 行)、无 follow 参数的重 upsert 不把 follow 清零(D1 CASE WHEN + R2 从 D1 读)、follow 镜像断言(`entityState.setFollow` 被正确调用,key 为 channel_id+source_id)、schema key 集合断言保留。

- [ ] TDD 循环 + 提交。

---

## Task 7: webhook/poller/routes 管线接回 D1

**Files:**
- Modify: `link/src/webhook.ts`、`webhook-youtube.ts`、`services/pollers/poll-channel.ts` 与 5 个 poller、`routes-internal.ts`、`routes-channels.ts`
- Test: 对应测试文件

**Interfaces:**
- Consumes: Task 5/6 的构造签名
- Produces: 全部构造点 `new ContentService(tenantDb, ..., entityState)` / `new XUsersService(tenantDb, {..., entityState})`;`ChannelInfo` 恢复 `d1DatabaseId`;未开通守卫恢复

**要点**:

- `webhook.ts`/`webhook-youtube.ts`/`poll-channel.ts`:恢复 `SELECT d1_database_id FROM tenants` 查询与 skip-if-null 守卫(形状参考 `f503650^`,守卫必须在任何外部 API 调用之前——上轮 I1 教训);`routes-internal.ts` 五处 `tenant_not_set` 守卫**保留**并在其后追加 provisioned 检查(同样 200 `{ok:false, reason:"tenant_db_not_provisioned"}`,flow 依赖可解析响应体)。
- **flowType 分流落点**:`x-posts.ts`/`tiktok-content.ts` 调 `upsertContentFromMetadata(..., METADATA.flowType)`(值来自各自 metadata 常量);`x-list-posts.ts`/`youtube-content.ts` 保持只 `recordTriggerContentSeen`+`emitContentTriggerEvent`(已如此,加一行注释指向 spec 的 flowType 表)。
- `webhook.ts` `post.create` → own 内容,D1+R2(flowType 传 `"content"`,对应 own:get-posts 条目);`post.delete` → D1 按 source_content_id 找行:找到 → `ContentService.delete`;找不到 → `deleteByKnownIdentity` 兜底(R2-lag/历史行),不 500。
- dev 部署自测:`(cd link && npm run deploy:dev)`;跑一轮 cron 后 `wrangler d1 execute uniscrm-t1-dev ... "SELECT COUNT(*) FROM user"` 应增长,同时 R2 `COUNT(DISTINCT id)` 同步增长;Content Library 编辑/删除走 D1 立即生效。
- `npx tsc --noEmit` 无新增 src 错误;全模块 vitest 绿。

- [ ] 实施 + 部署自测 + 提交。

---

## Task 8: routes-contents 回 D1

**Files:**
- Modify: `link/src/routes-contents.ts`
- Test: `link/tests/`(routes-contents 相关)

**要点**:四个路由改用 `c.get("tenantDataDb")`(无则 503 `Tenant DB not provisioned`),`ContentService` 按 Task 5 签名构造(`c.env.PIPELINE_CONTENT`、`c.get("entityState")`);移除 r2Env 传参与 R2SqlError→502 映射(D1 错误 → 500)。测试改用 tenantDb mock,保留「失败不返回 200 []」性质。

- [ ] TDD + 提交。

---

## Task 9: dev 端到端 + 清理

- [ ] **Step 1:** dev 全链路:signup 新 e2e 租户 → provision-db task 建库成功(`wrangler d1 list` 可见)→ poller 落 D1 → Users/Content 页正常 → Content 编辑/删除即时 → analytics 报表出数 → 含事件条件的分群可算。
- [ ] **Step 2:** 悬空清理:全仓 grep `getUserBySource|rollbackFingerprint|sendUserRecordOrRollback|claim(`,确认 user/content 路径无残留调用;无调用的方法连测试一起删。
- [ ] **Step 3:** `npm test` + `tenant-scope-audit` + 各模块 vitest/tsc 全绿;提交。

## Task 10: 文档随动

- [ ] `docs/adr/0006-user-content-back-to-per-tenant-d1.md`:记录推翻理由(append-only 对高频更新实体的代价链:读回合并/指纹/全量重发/compaction)、三个用户决定、id 域纪律、R2 副本定位;ADR 0005 顶部加"2026-07-26 部分推翻,见 0006"注记。
- [ ] `CLAUDE.md`(编辑 AGENTS.md 本体)Technical 段改写:user/content 真相在 per-tenant D1(REST 经 TenantDataDB),R2 为 analytics 副本,event 仍 R2 唯一,flowType:"content" 才落库。
- [ ] `analytics/pipelines/rebuild-tables.md` 顶部加一句:这三张表现在是 analytics 副本(user/content)与唯一真相(event),重建流程不变。
- [ ] 提交。

---

## 冻结区(本计划不做,随 prod 上线 runbook)

prod R2 三表重建、prod migrations apply(0007/0008/0009 连跑)+ d1_database_id 回填三条 execute、prod 部署、`profile` worker 与 `uniscrm-maigret` 队列删除。**「删除 4 个 uniscrm-t* 库」永久取消。**
