# Tenant DB 下线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `user` / `content` / `event` 的唯一真相搬到 R2 Data Catalog,在 `uniscrm-link` D1 里只留一张索引表 `entity_state`,然后删掉全部 per-tenant D1 数据库。

**Architecture:** R2 Data Catalog(Iceberg,append-only)存全部业务字段,读取时用 `QUALIFY ROW_NUMBER() OVER (PARTITION BY <业务键> ORDER BY updated_at DESC) = 1` 取每个业务键的最新行;写入时**永远发完整行**(部分写会把其它列变成 null)。D1 `entity_state` 只承担 R2 做不到的三件事:原子去重、变更检测、稳定 uuid 映射,外加 flow 唯一的热读字段 `is_follow`/`is_followed`。

**Tech Stack:** Cloudflare Workers + Hono、D1、R2 Data Catalog / R2 SQL、Cloudflare Pipelines、Vitest(`@cloudflare/vitest-pool-workers`)、React + shadcn/ui。

**Spec:** `docs/superpowers/specs/2026-07-25-tenant-db-removal-design.md`

## Global Constraints

- 所有 R2 SQL 查询**必须**带 `WHERE tenant_id = <int>`。窗口函数是 budget-gated,无租户过滤会被 R2 SQL 以 400 拒绝。
- 所有 R2 写入**必须是完整行**。读路径 `QUALIFY` 取整行最新,部分写会把未包含的列变成 null。
- R2 SQL 端点**不支持绑定参数**,SQL 靠字符串拼接。一切外部值必须经 `sqlStr()` / `sqlInt()` 转义,禁止裸模板插值。
- R2 读失败必须**抛出**,不得静默返回 `[]`。「数据准确性 > 系统稳定性 > 功能 > UI 界面」。
- `raw_data` 只存 **payload 中没有映射到具名列的剩余字段**,不是全量 payload。
- 逻辑删除:`is_deleted INTEGER`,`0`=存在 `1`=已删除;所有读路径带 `AND is_deleted = 0`。
- 新 D1 表必须有 `tenant_id INTEGER NOT NULL` 列。`scripts/tenant-scope-audit.mjs` 的
  `tenantScopedTables()` 会从各模块 migrations 里自动发现带 `tenant_id` 的表,所以
  `entity_state` / `segment_users` **无需手工登记**就会被门禁覆盖 —— 但也意味着凡是查它们的
  `.prepare()` 语句都必须带 `tenant_id`,否则 `node scripts/tenant-scope-audit.mjs` 会失败。
- dev 部署一律 `wrangler deploy --env dev`(全局 `wrangler`,不用 `npx wrangler`)。**裸 `wrangler deploy` 会打到 prod 并抹掉 bindings。**
- prod 部署只走手动触发的 GitHub Action;不主动 push 到 main,除非用户明确说「push to main」。
- 提交时只 `git add` 本任务涉及的文件 —— 工作区有其它 session 的未提交改动,不得裹挟。
- 每个任务结束前跑该模块的完整测试套件:`cd <module> && npx vitest run`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `shared/r2-sql.ts` | **新建**。R2 SQL HTTP 客户端 + SQL 字面量转义 + `latestRowsSql()` 构造器。link / flow / insight-segment 共用 |
| `link/migrations/0008_entity_state.sql` | **新建**。`entity_state` 表 |
| `link/src/services/entity-state.ts` | **新建**。`EntityStateStore` —— 原子去重、变更检测、uuid 映射、follow 状态 |
| `link/src/services/r2-entities.ts` | **新建**。从 R2 读 user / content 的查询函数 |
| `analytics/pipelines/user-stream-schema.json` | 改。＋`raw_data` ＋`is_deleted`,－`profile_id` |
| `analytics/pipelines/content-stream-schema.json` | 改。＋13 个业务列 ＋`raw_data` ＋`is_deleted`,－`status` |
| `analytics/pipelines/event-stream-schema.json` | 改。＋`raw_data` |
| `analytics/pipelines/rebuild-tables.md` | **新建**。旁置重建的逐条命令 |
| `link/src/services/content.ts` | 改。`TenantDataDB` → `EntityStateStore` + 整行 R2 写 |
| `link/src/services/x-users.ts` | 改。同上,并把 `setFollowState` 合并进整行 upsert |
| `link/src/routes-users.ts` | 改。列表读 R2;删详情页两个路由 |
| `link/src/routes-contents.ts` | 改。读 R2;PATCH 改「读整行→合并→整行回写」;DELETE 改逻辑删除 |
| `link/src/webhook.ts` `webhook-youtube.ts` | 改。去掉 `d1DatabaseId`,改用 `EntityStateStore` |
| `link/src/middleware.ts` | 改。不再注入 `tenantDataDb` |
| `flow/src/index.ts` | 改。`userPropsFilter` 读 `entity_state`;删 `changeUserProps`;node log 用户名改 R2 |
| `insight-segment/src/services/sql-builder.ts` `fields.ts` `index.ts` | 改。目标表改 `uniscrm.*`;membership 写 `segment_users` |
| `web/migrations/00XX_segment_users.sql` | **新建**。`segment_users` 表 |
| `profile/**` | **删除**整个模块 |
| `shared/tenant-data-db.ts` / `admin/src/services/tenant-init-sql.ts` / `operation/migrations/**` | **删除** |

---

## Task 0: 修复 `R2_SQL_TOKEN`(前置阻塞项)

**Files:**
- Modify: `scripts/sync-secrets.sh`(如缺 `R2_SQL_TOKEN` 条目)
- 无代码改动,以运维验证为主

**Interfaces:**
- Consumes: 无
- Produces: dev 与 prod 的 `R2_SQL_TOKEN` 均可用 —— 后续所有任务的读路径都依赖它

> 现状:`https://analytics-dev.uni-scrm.com/analytics/content/new` 报
> `{"error":"... 80011: Unauthenticated."}`。本计划之后 R2 从「分析用」变成**产品主链路**,
> token 一挂整个产品白屏,所以必须先修。

- [ ] **Step 1: 确认当前 token 是否失效**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
export WRANGLER_R2_SQL_AUTH_TOKEN=<现有 R2 API token>
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev \
  "SELECT COUNT(*) FROM uniscrm.event"
```
Expected(坏的情况): `80011: Unauthenticated`

- [ ] **Step 2: 在 Cloudflare Dashboard 重建 R2 API token**

R2 → Manage API Tokens → Create,权限必须选 **Admin Read only**,作用域选对应 bucket
(dev token 给 `uniscrm-dev`,prod token 给 `uniscrm`)。

⚠️ **不能选 "Object Read"**。按
<https://developers.cloudflare.com/r2/api/tokens/>:Object Read / Object Read & Write
只对 **S3-compatible API** 生效,对 Cloudflare REST API(R2 SQL 与 R2 Data Catalog 走的就是它)
无效。R2 SQL 需要的是两个权限组 **Workers R2 Data Catalog Read** ＋
**Workers R2 Storage Bucket Item Read** —— 在 Dashboard 上就是 "Admin Read only"。
用错权限的表现是 `80013: Unauthorized`(token 有效但没权限),
而不是 `80011: Unauthenticated`(token 本身无效/过期)。

- [ ] **Step 3: 用新 token 复验**

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<新 token>
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev \
  "SELECT COUNT(*) FROM uniscrm.event"
```
Expected: 返回一个数字,无 error

- [ ] **Step 4: 同步到所有需要它的 worker**

```bash
for m in link flow analytics insight-segment; do
  echo "$NEW_TOKEN" | wrangler secret put R2_SQL_TOKEN --env dev --config $m/wrangler.toml
done
```

确认 `scripts/sync-secrets.sh` 的 secret 列表里含 `R2_SQL_TOKEN` 且覆盖这 4 个模块;
缺则补上(prod 的 secret 由 GitHub Action 的 `sync-secrets` job 从仓库 secrets 注入,
所以还要在 GitHub repo settings 里更新同名 secret)。

- [ ] **Step 5: 浏览器验证**

打开 `https://analytics-dev.uni-scrm.com/analytics/content/new`,确认不再报 80011。

- [ ] **Step 6: 提交(如有脚本改动)**

```bash
git add scripts/sync-secrets.sh
git commit -m "chore: ensure R2_SQL_TOKEN is synced to link/flow/analytics/insight-segment"
```

---

## Task 1: `shared/r2-sql.ts` —— 统一的 R2 SQL 客户端

**Files:**
- Create: `shared/r2-sql.ts`
- Test: `link/tests/services/r2-sql.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface R2SqlEnv { CF_ACCOUNT_ID: string; R2_BUCKET: string; R2_WAREHOUSE: string; R2_SQL_TOKEN: string }`
  - `class R2SqlError extends Error { readonly status: number }`
  - `function sqlStr(v: string): string`
  - `function sqlInt(v: number): string`
  - `function latestRowsSql(opts: { table: string; columns: string[]; partitionBy: string[]; where: string[]; orderBy?: string; limit?: number }): string`
  - `async function r2Query<T>(env: R2SqlEnv, sql: string): Promise<T[]>`

> 说明:目前 `link/src/routes-users.ts` 和 `flow/src/index.ts` 各手写了一份到
> `https://api.sql.cloudflarestorage.com/api/v1/accounts/{acct}/r2-sql/query/{bucket}` 的
> `fetch`。这个任务把它们合并为一处,并加上转义与错误抛出。

- [ ] **Step 1: 建目录并写失败测试**

创建 `link/tests/services/r2-sql.test.ts`(**不要**放在 `shared/tests/` —— `shared/` 没有
vitest 配置,`link/vitest.config.ts` 的 root 是 `link/`,放在 `shared/` 下的测试不会被任何 runner 收录。
仓库既有约定就是从模块的 `tests/` 里测 `shared/` 代码,例如 `admin/tests/unit/credit-service.test.ts`
测的是 `shared/credit-service.ts`):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sqlStr, sqlInt, latestRowsSql, r2Query, R2SqlError } from "../../../shared/r2-sql";

const ENV = {
  CF_ACCOUNT_ID: "acct1",
  R2_BUCKET: "uniscrm-dev",
  R2_WAREHOUSE: "wh_uniscrm-dev",
  R2_SQL_TOKEN: "tok1",
};

describe("sqlStr", () => {
  it("wraps in single quotes and doubles embedded quotes", () => {
    expect(sqlStr("o'brien")).toBe("'o''brien'");
  });

  it("rejects NUL bytes rather than emitting them", () => {
    expect(() => sqlStr("a\0b")).toThrow(/NUL/);
  });
});

describe("sqlInt", () => {
  it("renders a safe integer", () => {
    expect(sqlInt(42)).toBe("42");
  });

  it("rejects non-integers so nothing can smuggle SQL through a number field", () => {
    expect(() => sqlInt(1.5)).toThrow(/integer/);
    expect(() => sqlInt(NaN)).toThrow(/integer/);
  });
});

describe("latestRowsSql", () => {
  it("emits a QUALIFY window that keeps one row per business key", () => {
    const sql = latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "name"],
      partitionBy: ["channel_id", "source_user_id"],
      where: ["tenant_id = 7", "is_deleted = 0"],
      limit: 100,
    });
    expect(sql).toContain("SELECT id, name FROM uniscrm.user");
    expect(sql).toContain("WHERE tenant_id = 7 AND is_deleted = 0");
    expect(sql).toContain(
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY channel_id, source_user_id ORDER BY updated_at DESC) = 1"
    );
    expect(sql).toContain("LIMIT 100");
  });

  it("refuses to build a query with no tenant_id filter (budget gate + tenant isolation)", () => {
    expect(() =>
      latestRowsSql({
        table: "uniscrm.user",
        columns: ["id"],
        partitionBy: ["channel_id", "source_user_id"],
        where: ["is_deleted = 0"],
      })
    ).toThrow(/tenant_id/);
  });
});

describe("r2Query", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rows on success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ result: { rows: [{ id: "u1" }] } }), { status: 200 })
    );
    const rows = await r2Query<{ id: string }>(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1");
    expect(rows).toEqual([{ id: "u1" }]);
  });

  it("throws R2SqlError on a non-2xx response instead of returning an empty list", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "80011: Unauthenticated" }), { status: 401 })
    );
    await expect(
      r2Query(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1")
    ).rejects.toBeInstanceOf(R2SqlError);
  });

  it("throws when the body carries an error even though HTTP status is 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "40010: iceberg table not found" }), { status: 200 })
    );
    await expect(
      r2Query(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1")
    ).rejects.toThrow(/40010/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/r2-sql.test.ts
```
Expected: FAIL —— `Failed to resolve import "../../../shared/r2-sql"`

- [ ] **Step 3: 实现 `shared/r2-sql.ts`**

```ts
// R2 SQL 的 HTTP 端点不支持绑定参数,SQL 只能拼字符串 —— 所以一切外部值必须经
// sqlStr/sqlInt 转义。直接模板插值是注入面,禁止。
export interface R2SqlEnv {
  CF_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_WAREHOUSE: string;
  R2_SQL_TOKEN: string;
}

export class R2SqlError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "R2SqlError";
  }
}

export function sqlStr(v: string): string {
  if (v.includes("\0")) throw new Error("sqlStr: value contains a NUL byte");
  return `'${v.replace(/'/g, "''")}'`;
}

export function sqlInt(v: number): string {
  if (!Number.isSafeInteger(v)) throw new Error(`sqlInt: ${v} is not a safe integer`);
  return String(v);
}

export interface LatestRowsOpts {
  table: string;
  columns: string[];
  partitionBy: string[];
  where: string[];
  orderBy?: string;
  limit?: number;
}

// Iceberg sink 是 append-only,同一业务键会有多行。QUALIFY + ROW_NUMBER 在读取时挑出
// updated_at 最新的一行,所以正确性不再依赖 analytics 每日 02:00 的 compaction。
export function latestRowsSql(opts: LatestRowsOpts): string {
  if (!opts.where.some((w) => /\btenant_id\s*=/.test(w))) {
    throw new Error("latestRowsSql: every query must filter on tenant_id");
  }
  const parts = [
    `SELECT ${opts.columns.join(", ")} FROM ${opts.table}`,
    `WHERE ${opts.where.join(" AND ")}`,
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY ${opts.partitionBy.join(", ")} ORDER BY updated_at DESC) = 1`,
  ];
  if (opts.orderBy) parts.push(`ORDER BY ${opts.orderBy}`);
  if (opts.limit !== undefined) parts.push(`LIMIT ${sqlInt(opts.limit)}`);
  return parts.join("\n");
}

interface R2SqlResponse<T> {
  result?: { rows?: T[] };
  error?: string;
}

export async function r2Query<T>(env: R2SqlEnv, sql: string): Promise<T[]> {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_BUCKET}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.R2_SQL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ warehouse: env.R2_WAREHOUSE, query: sql }),
  });

  const text = await res.text();
  let body: R2SqlResponse<T>;
  try {
    body = JSON.parse(text) as R2SqlResponse<T>;
  } catch {
    throw new R2SqlError(`r2Query: non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`, res.status);
  }

  // R2 SQL 会在 HTTP 200 里回 {"error": "..."}(见 analytics/CLAUDE.md 记录的 40010),
  // 只看 res.ok 会把错误当成「零行」——那正是要杜绝的静默失败。
  if (!res.ok || body.error) {
    throw new R2SqlError(`r2Query failed (HTTP ${res.status}): ${body.error ?? text.slice(0, 300)}`, res.status);
  }
  return body.result?.rows ?? [];
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/r2-sql.test.ts
```
Expected: PASS,9 个用例全绿。再跑一次 `cd link && npx vitest run`,确认 `r2-sql.test.ts`
出现在被收集的测试文件里 —— 这一步才证明它真的进了常规测试流。

- [ ] **Step 5: 提交**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add shared/r2-sql.ts link/tests/services/r2-sql.test.ts
git commit -m "feat(shared): add R2 SQL client with tenant_id enforcement and error surfacing"
```

---

## Task 2: `entity_state` 表 + `EntityStateStore`

**Files:**
- Create: `link/migrations/0008_entity_state.sql`
- Create: `link/src/services/entity-state.ts`
- Test: `link/tests/services/entity-state.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type EntityKind = "user" | "content" | "content_trigger"`
  - `interface EntityStateKey { entity: EntityKind; channelId: string; secondaryId?: string; sourceId: string }`
  - `interface EntityStateRow { entity_id: string; fingerprint: string | null; is_follow: number | null; is_followed: number | null }`
  - `class EntityStateStore { constructor(db: D1Database, tenantId: number) }`
    - `claim(key, fingerprint): Promise<{ entityId: string; isNew: boolean; unchanged: boolean }>`
    - `markSeen(key): Promise<boolean>`
    - `get(key): Promise<EntityStateRow | null>`
    - `setFollow(key, field: "is_follow" | "is_followed", value: 0 | 1): Promise<void>`
    - `getFollowByEntityId(entityId): Promise<{ is_follow: number | null; is_followed: number | null } | null>`
  - `async function fingerprintOf(values: Record<string, unknown>, fields: string[]): Promise<string>`

- [ ] **Step 1: 写迁移文件**

创建 `link/migrations/0008_entity_state.sql`:

```sql
CREATE TABLE entity_state (
  tenant_id    INTEGER NOT NULL,
  entity       TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  secondary_id TEXT NOT NULL DEFAULT '',
  source_id    TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  fingerprint  TEXT,
  is_follow    INTEGER,
  is_followed  INTEGER,
  seen_at      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity, channel_id, secondary_id, source_id)
);
CREATE INDEX idx_entity_state_entity_id ON entity_state(tenant_id, entity_id);
```

- [ ] **Step 2: 写失败测试**

创建 `link/tests/services/entity-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { EntityStateStore, fingerprintOf } from "../../src/services/entity-state";

// 内存版 D1 stub:只实现 entity_state 用到的三条语句形态,
// 语义与 SQLite 的 INSERT OR IGNORE / SELECT / UPDATE 一致。
function createFakeD1() {
  const rows = new Map<string, Record<string, unknown>>();
  const keyOf = (p: unknown[]) => p.slice(0, 5).join("\x1f");

  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO entity_state")) {
                const k = keyOf(params);
                if (rows.has(k)) return { meta: { changes: 0 } };
                rows.set(k, {
                  tenant_id: params[0], entity: params[1], channel_id: params[2],
                  secondary_id: params[3], source_id: params[4],
                  entity_id: params[5], fingerprint: params[6],
                  seen_at: params[7], updated_at: params[8],
                  is_follow: null, is_followed: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE entity_state SET fingerprint")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.fingerprint = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE entity_state SET is_follow")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.is_follow = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE entity_state SET is_followed")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = rows.get(k);
                if (row) { row.is_followed = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`fake D1: unhandled run() for ${sql}`);
            },
            async first() {
              if (sql.includes("WHERE tenant_id = ? AND entity_id = ?")) {
                for (const row of rows.values()) {
                  if (row.tenant_id === params[0] && row.entity_id === params[1]) return row;
                }
                return null;
              }
              return rows.get(keyOf(params)) ?? null;
            },
          };
        },
      };
    },
  };
}

describe("fingerprintOf", () => {
  it("is stable for the same values regardless of key insertion order", async () => {
    const a = await fingerprintOf({ name: "Ann", username: "ann" }, ["name", "username"]);
    const b = await fingerprintOf({ username: "ann", name: "Ann" }, ["name", "username"]);
    expect(a).toBe(b);
  });

  it("changes when any tracked field changes", async () => {
    const a = await fingerprintOf({ name: "Ann" }, ["name"]);
    const b = await fingerprintOf({ name: "Bob" }, ["name"]);
    expect(a).not.toBe(b);
  });

  it("treats a missing field and an empty string identically", async () => {
    const a = await fingerprintOf({ name: "Ann" }, ["name", "bio"]);
    const b = await fingerprintOf({ name: "Ann", bio: "" }, ["name", "bio"]);
    expect(a).toBe(b);
  });
});

describe("EntityStateStore.claim", () => {
  let db: ReturnType<typeof createFakeD1>;
  let store: EntityStateStore;
  const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };

  beforeEach(() => {
    db = createFakeD1();
    store = new EntityStateStore(db as any, 7);
  });

  it("returns isNew on first sight and mints a stable entity_id", async () => {
    const r = await store.claim(key, "fp1");
    expect(r.isNew).toBe(true);
    expect(r.unchanged).toBe(false);
    expect(r.entityId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the same entity_id on a second sight — the uuid must never churn", async () => {
    const first = await store.claim(key, "fp1");
    const second = await store.claim(key, "fp2");
    expect(second.entityId).toBe(first.entityId);
    expect(second.isNew).toBe(false);
  });

  it("reports unchanged when the fingerprint matches, so the poller skips the R2 write", async () => {
    await store.claim(key, "fp1");
    const again = await store.claim(key, "fp1");
    expect(again.unchanged).toBe(true);
  });

  it("reports changed and stores the new fingerprint when it differs", async () => {
    await store.claim(key, "fp1");
    const changed = await store.claim(key, "fp2");
    expect(changed.unchanged).toBe(false);
    const third = await store.claim(key, "fp2");
    expect(third.unchanged).toBe(true);
  });

  it("keys separately per secondary_id so the same post in two lists is two entities", async () => {
    const a = await store.claim({ ...key, entity: "content", secondaryId: "listA" }, "fp");
    const b = await store.claim({ ...key, entity: "content", secondaryId: "listB" }, "fp");
    expect(a.entityId).not.toBe(b.entityId);
  });

  it("keys separately per tenant", async () => {
    const other = new EntityStateStore(db as any, 8);
    const a = await store.claim(key, "fp");
    const b = await other.claim(key, "fp");
    expect(b.isNew).toBe(true);
    expect(b.entityId).not.toBe(a.entityId);
  });
});

describe("EntityStateStore.markSeen", () => {
  it("returns true only the first time — this is the flow-trigger dedup", async () => {
    const store = new EntityStateStore(createFakeD1() as any, 7);
    const key = { entity: "content_trigger" as const, channelId: "c1", secondaryId: "list1", sourceId: "t1" };
    expect(await store.markSeen(key)).toBe(true);
    expect(await store.markSeen(key)).toBe(false);
  });
});

describe("EntityStateStore follow state", () => {
  it("round-trips is_follow and leaves is_followed untouched", async () => {
    const db = createFakeD1();
    const store = new EntityStateStore(db as any, 7);
    const key = { entity: "user" as const, channelId: "c1", sourceId: "s1" };
    const { entityId } = await store.claim(key, "fp");

    await store.setFollow(key, "is_follow", 1);

    expect(await store.getFollowByEntityId(entityId)).toEqual({ is_follow: 1, is_followed: null });
  });

  it("returns null for an unknown entity_id rather than throwing", async () => {
    const store = new EntityStateStore(createFakeD1() as any, 7);
    expect(await store.getFollowByEntityId("nope")).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/entity-state.test.ts
```
Expected: FAIL —— `Failed to resolve import "../../src/services/entity-state"`

- [ ] **Step 4: 实现 `link/src/services/entity-state.ts`**

```ts
export type EntityKind = "user" | "content" | "content_trigger";

export interface EntityStateKey {
  entity: EntityKind;
  channelId: string;
  secondaryId?: string;
  sourceId: string;
}

export interface EntityStateRow {
  entity_id: string;
  fingerprint: string | null;
  is_follow: number | null;
  is_followed: number | null;
}

// 变更检测用的指纹。用 SHA-256 而不是短哈希:碰撞意味着「变了但没重发 R2」,
// 也就是静默丢数据 —— 与「数据准确性 > 一切」冲突。
// 缺字段与空串视为等价,避免上游 undefined/"" 的抖动引起假变更。
export async function fingerprintOf(
  values: Record<string, unknown>,
  fields: string[]
): Promise<string> {
  const canonical = [...fields]
    .sort()
    .map((f) => {
      const v = values[f];
      return `${f}=${v === undefined || v === null ? "" : String(v)}`;
    })
    .join("\x1f");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// R2 Data Catalog 是 append-only、无唯一索引、无原子插入,所以这三件事只能落在 D1:
//   1. 「见过吗」—— flow trigger 去重(靠 PK + INSERT OR IGNORE 的原子性)
//   2. 「变了吗」—— poller 每 tick 重走已抓过的页,没有它会全量重发 R2
//   3. 「我们的 uuid 是什么」—— flow log / vectorize / pending 队列都引用它,必须稳定
// 每行只有 key + 指纹 + 两个 int,不含任何业务字段。
export class EntityStateStore {
  constructor(private db: D1Database, private tenantId: number) {}

  private sec(key: EntityStateKey): string {
    return key.secondaryId ?? "";
  }

  async claim(
    key: EntityStateKey,
    fingerprint: string
  ): Promise<{ entityId: string; isNew: boolean; unchanged: boolean }> {
    const now = new Date().toISOString();
    const candidate = crypto.randomUUID();

    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_state
           (tenant_id, entity, channel_id, secondary_id, source_id, entity_id, fingerprint, seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId, candidate, fingerprint, now, now)
      .run();

    if (inserted.meta.changes > 0) {
      return { entityId: candidate, isNew: true, unchanged: false };
    }

    const row = await this.get(key);
    if (!row) {
      // PK 冲突后又读不到 —— 只可能是并发删除,当前代码没有删除路径,所以这是真异常。
      throw new Error(`EntityStateStore.claim: row vanished for ${key.entity}/${key.sourceId}`);
    }
    if (row.fingerprint === fingerprint) {
      return { entityId: row.entity_id, isNew: false, unchanged: true };
    }

    await this.db
      .prepare(
        `UPDATE entity_state SET fingerprint = ?, updated_at = ?
         WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
      )
      .bind(fingerprint, now, this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .run();

    return { entityId: row.entity_id, isNew: false, unchanged: false };
  }

  // 纯去重:第一次见到返回 true。取代原来的 content_trigger_dedup 表。
  async markSeen(key: EntityStateKey): Promise<boolean> {
    const now = new Date().toISOString();
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_state
           (tenant_id, entity, channel_id, secondary_id, source_id, entity_id, fingerprint, seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId, crypto.randomUUID(), null, now, now)
      .run();
    return res.meta.changes > 0;
  }

  async get(key: EntityStateKey): Promise<EntityStateRow | null> {
    return await this.db
      .prepare(
        `SELECT entity_id, fingerprint, is_follow, is_followed FROM entity_state
         WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
      )
      .bind(this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .first<EntityStateRow>();
  }

  async setFollow(key: EntityStateKey, field: "is_follow" | "is_followed", value: 0 | 1): Promise<void> {
    // field 是联合类型,不是外部输入,拼进 SQL 安全。
    const sql =
      field === "is_follow"
        ? `UPDATE entity_state SET is_follow = ?, updated_at = ?
           WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`
        : `UPDATE entity_state SET is_followed = ?, updated_at = ?
           WHERE tenant_id = ? AND entity = ? AND channel_id = ? AND secondary_id = ? AND source_id = ?`;
    await this.db
      .prepare(sql)
      .bind(value, new Date().toISOString(), this.tenantId, key.entity, key.channelId, this.sec(key), key.sourceId)
      .run();
  }

  async getFollowByEntityId(
    entityId: string
  ): Promise<{ is_follow: number | null; is_followed: number | null } | null> {
    return await this.db
      .prepare(`SELECT is_follow, is_followed FROM entity_state WHERE tenant_id = ? AND entity_id = ?`)
      .bind(this.tenantId, entityId)
      .first<{ is_follow: number | null; is_followed: number | null }>();
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/entity-state.test.ts
```
Expected: PASS,12 个用例全绿

- [ ] **Step 6: 在 dev 上应用迁移并验证**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
wrangler d1 migrations apply uniscrm-link-dev --env dev --config link/wrangler.toml --remote
wrangler d1 execute uniscrm-link-dev --env dev --config link/wrangler.toml --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='entity_state'"
```
Expected: 返回一行 `entity_state`

- [ ] **Step 7: 提交**

```bash
git add link/migrations/0008_entity_state.sql link/src/services/entity-state.ts link/tests/services/entity-state.test.ts
git commit -m "feat(link): add entity_state — atomic dedup, change detection, stable uuid mapping"
```

---

## Task 3: R2 三张表的新 schema 与旁置重建

**Files:**
- Modify: `analytics/pipelines/user-stream-schema.json`
- Modify: `analytics/pipelines/content-stream-schema.json`
- Modify: `analytics/pipelines/event-stream-schema.json`
- Create: `analytics/pipelines/rebuild-tables.md`
- Modify: `analytics/src/index.ts`(`compactContentTable` 的 `key_columns` 加 `list_id`)
- Test: `analytics/tests/unit/event-stream-schema.test.ts`(已存在,需同步)

**Interfaces:**
- Consumes: 无
- Produces: R2 表 `uniscrm.user` / `uniscrm.content` / `uniscrm.event` 的新列集合,供 Task 4/5/6/8/9 写入与读取

- [ ] **Step 1: 改三个 schema 文件**

`analytics/pipelines/user-stream-schema.json` —— 删掉 `profile_id` 那一行,在末尾追加:

```json
    { "name": "raw_data", "type": "string", "required": false },
    { "name": "is_deleted", "type": "int32", "required": true }
```

`analytics/pipelines/content-stream-schema.json` —— 在 `repost_count` 之后追加:

```json
    { "name": "list_id", "type": "string", "required": false },
    { "name": "title", "type": "string", "required": false },
    { "name": "content_text", "type": "string", "required": false },
    { "name": "summary", "type": "string", "required": false },
    { "name": "source_url", "type": "string", "required": false },
    { "name": "source_updated_at", "type": "string", "required": false },
    { "name": "cover_image_url", "type": "string", "required": false },
    { "name": "duration", "type": "int32", "required": false },
    { "name": "height", "type": "int32", "required": false },
    { "name": "width", "type": "int32", "required": false },
    { "name": "has_face", "type": "int32", "required": false },
    { "name": "view_count", "type": "int32", "required": false },
    { "name": "share_count", "type": "int32", "required": false },
    { "name": "raw_data", "type": "string", "required": false },
    { "name": "is_deleted", "type": "int32", "required": true }
```

`analytics/pipelines/event-stream-schema.json` —— 在末尾追加:

```json
    { "name": "raw_data", "type": "string", "required": false }
```

- [ ] **Step 2: 同步 schema 单测**

`analytics/tests/unit/event-stream-schema.test.ts` 第 13 行的 `IDENTITY_FIELDS` 是「非 prop 列」的白名单
—— 该测试断言 `schemaFieldNames − IDENTITY_FIELDS === eventProps 的并集`。`raw_data` 不由
`eventProps` 推导,所以要加进这个数组,否则第一个用例会失败:

```ts
// raw_data 存的是 payload 中没有映射到具名列的剩余字段(见
// docs/superpowers/specs/2026-07-25-tenant-db-removal-design.md),
// 不由 eventProps 推导,所以和身份列一样豁免于 prop 对账。
const IDENTITY_FIELDS = ["tenant_id", "id", "user_id", "channel_id", "event_type", "event_time", "created_at", "raw_data"];
```

同时把第二个用例(`keeps every identity/time column the pipeline writer always sends`)
里对 `IDENTITY_FIELDS` 的遍历保持不变 —— `raw_data` 确实每次写入都会带上,断言依然成立。

- [ ] **Step 3: 跑 analytics 测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/analytics && npx vitest run
```
Expected: PASS

- [ ] **Step 4: `compactContentTable` 的 key_columns 补 `list_id`**

`analytics/src/index.ts` 里 `compactContentTable` 的 body:

```ts
        key_columns: ["tenant_id", "channel_id", "list_id", "source_content_id"],
```

> 不补的话,同一条推文在两个 list 下的两行会被 compaction 错误合并成一行 ——
> 与读路径的 `PARTITION BY channel_id, list_id, source_content_id` 不一致。

- [ ] **Step 5: 写重建手册 `analytics/pipelines/rebuild-tables.md`**

```markdown
# R2 Data Catalog 表重建步骤

Pipeline sink 的 schema 不可修改,且拒绝写入已存在的 Iceberg 表。所以加列必须:
**旁置旧表 → 删旧 pipeline/sink/stream → 用新 schema 建 stream/sink/pipeline**。
旁置(而不是 drop)只是为了腾出表名,旁置副本不再被任何代码读取。

对 `user` / `content` / `event` 各做一遍。以 dev 的 `user` 为例
(prod 把 `-dev` 后缀去掉、warehouse 换成 prod 的):

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<R2 API token>   # 与 wrangler OAuth session 是分开的

# 1. 旁置旧表(脚本已存在)
python3 analytics/pipelines/rename-table.py --namespace uniscrm --from user --to user_v1

# 2. 删旧 pipeline / sink / stream(非交互 shell 必须加 -y,否则卡在确认提示)
wrangler pipelines delete uniscrm-user-dev -y
wrangler pipelines sinks delete uniscrm-user-sink-dev -y
wrangler pipelines streams delete uniscrm-user-stream-dev -y

# 3. 用新 schema 建 stream
wrangler pipelines streams create uniscrm-user-stream-dev \
  --schema-file analytics/pipelines/user-stream-schema.json

# 4. 建 sink（指向 uniscrm.user)
wrangler pipelines sinks create uniscrm-user-sink-dev \
  --type r2-data-catalog --bucket uniscrm-dev \
  --namespace uniscrm --table user

# 5. 建 pipeline 串起来
wrangler pipelines create uniscrm-user-dev \
  --stream uniscrm-user-stream-dev --sink uniscrm-user-sink-dev \
  --sql "INSERT INTO uniscrm-user-sink-dev SELECT * FROM uniscrm-user-stream-dev"

# 6. 确认 link/wrangler.toml 的 PIPELINE_USER 指向新 stream,然后
wrangler deploy --env dev --config link/wrangler.toml
```

新 sink 是**懒创建表**:第一次写入之前 `wrangler r2 sql query` 会报
`40010: iceberg table not found`,这是正常的全新状态,不是错误。

验证(写入一条后):

```bash
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev \
  "SELECT COUNT(DISTINCT id) FROM uniscrm.user WHERE tenant_id = 1"
```

`wrangler r2 sql query` 的第一个参数是 **warehouse 标识符**(各模块 wrangler.toml 的
`R2_WAREHOUSE`),不是 bucket 名;传错会报 "Warehouse name has invalid format"。
另注意它出错时仍可能 exit 0,务必肉眼看输出。
```

- [ ] **Step 6: 在 dev 上按手册重建三张表**

按 `rebuild-tables.md` 对 `user` / `content` / `event` 各执行一遍(dev)。
每张表建完后确认 `wrangler pipelines list` 里三条 pipeline 都是 active。

- [ ] **Step 7: 提交**

```bash
git add analytics/pipelines/ analytics/src/index.ts analytics/tests/unit/event-stream-schema.test.ts
git commit -m "feat(analytics): widen R2 user/content/event schemas, document table rebuild"
```

---

## Task 4: `link` 内容写入路径切到 R2 + `entity_state`

**Files:**
- Create: `link/src/services/r2-entities.ts`
- Modify: `link/src/services/content.ts`
- Test: `link/tests/services/content.test.ts`(改)、`link/tests/services/r2-entities.test.ts`(新)

**Interfaces:**
- Consumes: `shared/r2-sql.ts` 的 `r2Query` / `sqlStr` / `sqlInt` / `latestRowsSql`;`link/src/services/entity-state.ts` 的 `EntityStateStore` / `fingerprintOf`
- Produces:
  - `link/src/services/r2-entities.ts`:
    - `const USER_COLUMNS: string[]`、`const CONTENT_COLUMNS: string[]`
    - `async function listContents(env: R2SqlEnv, tenantId: number, channelType?: string): Promise<ContentRow[]>`
    - `async function getContent(env: R2SqlEnv, tenantId: number, id: string): Promise<ContentRow | null>`
    - `async function listUsers(env: R2SqlEnv, tenantId: number, limit: number): Promise<Record<string, unknown>[]>`
    - `async function getUserNames(env: R2SqlEnv, tenantId: number, ids: string[]): Promise<Map<string, string>>`
  - `ContentService` 构造签名改为
    `constructor(entityState: EntityStateStore, vectorize, ai, tenantId, pipelineContent?, flowQueue?, r2Env?)`

- [ ] **Step 1: 写 `r2-entities.ts` 的失败测试**

创建 `link/tests/services/r2-entities.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listContents, getContent, getUserNames } from "../../src/services/r2-entities";

const ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };

function stubR2(rows: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>): string {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string).query as string;
}

afterEach(() => vi.unstubAllGlobals());

describe("listContents", () => {
  it("filters by tenant, hides logically deleted rows, and keeps one row per business key", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7);
    const q = sentQuery(fetchMock);
    expect(q).toContain("tenant_id = 7");
    expect(q).toContain("is_deleted = 0");
    expect(q).toContain("PARTITION BY channel_id, list_id, source_content_id");
  });

  it("escapes channel_type instead of interpolating it raw", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7, "O'X");
    expect(sentQuery(fetchMock)).toContain("channel_type = 'O''X'");
  });
});

describe("getContent", () => {
  it("returns null when no row matches", async () => {
    stubR2([]);
    expect(await getContent(ENV, 7, "c1")).toBeNull();
  });

  it("escapes the id", async () => {
    const fetchMock = stubR2([]);
    await getContent(ENV, 7, "a'b");
    expect(sentQuery(fetchMock)).toContain("id = 'a''b'");
  });
});

describe("getUserNames", () => {
  it("returns an empty map without querying when given no ids", async () => {
    const fetchMock = stubR2([]);
    const map = await getUserNames(ENV, 7, []);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps id to name", async () => {
    stubR2([{ id: "u1", name: "Ann" }]);
    const map = await getUserNames(ENV, 7, ["u1"]);
    expect(map.get("u1")).toBe("Ann");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/r2-entities.test.ts
```
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `link/src/services/r2-entities.ts`**

```ts
import { r2Query, latestRowsSql, sqlStr, sqlInt, type R2SqlEnv } from "../../../shared/r2-sql";
import type { ContentRow } from "../types";

export const CONTENT_COLUMNS = [
  "id", "channel_id", "channel_type", "content_type", "source_content_id", "list_id",
  "title", "content_text", "summary", "source_url", "source_updated_at", "source_created_at",
  "cover_image_url", "duration", "height", "width", "has_face",
  "bookmark_count", "impression_count", "view_count", "like_count",
  "quote_count", "reply_count", "repost_count", "share_count",
  "raw_data", "created_at", "updated_at",
];

export const USER_COLUMNS = [
  "id", "channel_id", "channel_type", "source_user_id", "name", "username",
  "is_active", "is_follow", "is_followed", "verified_type",
  "followers_count", "following_count", "post_count", "listed_count", "like_count", "media_count",
  "raw_data", "created_at", "updated_at",
];

const CONTENT_PARTITION = ["channel_id", "list_id", "source_content_id"];
const USER_PARTITION = ["channel_id", "source_user_id"];

export async function listContents(
  env: R2SqlEnv,
  tenantId: number,
  channelType?: string
): Promise<ContentRow[]> {
  const where = [`tenant_id = ${sqlInt(tenantId)}`, "is_deleted = 0"];
  if (channelType) where.push(`channel_type = ${sqlStr(channelType)}`);
  return await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where,
      orderBy: "source_updated_at DESC",
      limit: 1000,
    })
  );
}

export async function getContent(
  env: R2SqlEnv,
  tenantId: number,
  id: string
): Promise<ContentRow | null> {
  const rows = await r2Query<ContentRow>(
    env,
    latestRowsSql({
      table: "uniscrm.content",
      columns: CONTENT_COLUMNS,
      partitionBy: CONTENT_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id = ${sqlStr(id)}`],
      limit: 1,
    })
  );
  return rows[0] ?? null;
}

export async function listUsers(
  env: R2SqlEnv,
  tenantId: number,
  limit: number
): Promise<Record<string, unknown>[]> {
  return await r2Query<Record<string, unknown>>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: USER_COLUMNS,
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, "is_deleted = 0"],
      orderBy: "updated_at DESC",
      limit,
    })
  );
}

export async function getUserNames(
  env: R2SqlEnv,
  tenantId: number,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const list = ids.map(sqlStr).join(", ");
  const rows = await r2Query<{ id: string; name: string | null }>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "name"],
      partitionBy: USER_PARTITION,
      where: [`tenant_id = ${sqlInt(tenantId)}`, `id IN (${list})`],
    })
  );
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/r2-entities.test.ts
```
Expected: PASS,6 个用例全绿

- [ ] **Step 5: 改 `ContentService` —— 写完整行,不再碰 tenant D1**

`link/src/services/content.ts` 的改动要点(逐处替换,不新建文件):

1. 构造函数第一个参数由 `private tenantDb: TenantDataDB` 换成 `private entityState: EntityStateStore`,
   末尾追加 `private r2Env?: R2SqlEnv`。删除 `import type { TenantDataDB }`。
2. `CONTENT_COLUMN_MAP` 保留(它现在描述的是 R2 列而非 D1 列),
   额外补上 R2 新增的 `list_id` 不进此 map(由调用方单独传)。
3. `upsertContentFromMetadata` 改为:

```ts
    const sourceContentId = String(resolvedProps.source_content_id ?? "");
    if (!sourceContentId) throw new Error("upsertContentFromMetadata: missing source_content_id");

    const now = new Date().toISOString();

    const columnValues: Record<string, unknown> = {};
    for (const [propId, column] of Object.entries(CONTENT_COLUMN_MAP)) {
      const val = resolvedProps[propId];
      if (val !== undefined && val !== null && val !== "") columnValues[column] = val;
    }

    // 指纹只覆盖会变的业务字段;created_at/updated_at 不参与,否则每次都判定为「变了」。
    const fingerprint = await fingerprintOf(columnValues, CONTENT_TABLE_COLUMNS);
    const key = {
      entity: "content" as const,
      channelId,
      secondaryId: listId ?? "",
      sourceId: sourceContentId,
    };
    const { entityId: id, isNew, unchanged } = await this.entityState.claim(key, fingerprint);

    // raw_data 只保留没有映射到具名列的剩余字段 —— 全量 payload 进日志不进库
    // (uniscrm-web/CLAUDE.md「调用外部API返回的payload全量数据不要存在数据库中」)。
    const mapped = new Set(Object.keys(CONTENT_COLUMN_MAP));
    const leftover: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawItem)) {
      if (!mapped.has(k)) leftover[k] = v;
    }
    const rawData = JSON.stringify(leftover);

    await this.embedContents([{
      id,
      channel_id: channelId,
      channel_type: channelType,
      content_type: (columnValues.content_type as string) ?? null,
      source_content_id: sourceContentId,
      title: (columnValues.title as string) ?? null,
      content_text: (columnValues.content_text as string) ?? null,
      summary: null,
      status: "new",
      source_url: null,
      source_updated_at: null,
      source_created_at: (columnValues.source_created_at as string) ?? null,
      raw_data: rawData,
      created_at: now,
      updated_at: now,
    }]);

    if (this.pipelineContent && this.tenantId && !unchanged) {
      // 完整行:读路径用 QUALIFY 取整行最新,漏一列就等于把那列写成 null。
      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id,
        channel_id: channelId,
        channel_type: channelType,
        source_content_id: sourceContentId,
        list_id: listId ?? null,
        raw_data: rawData,
        is_deleted: 0,
        created_at: now,
        updated_at: now,
      };
      for (const col of CONTENT_TABLE_COLUMNS) {
        record[col] = columnValues[col] ?? null;
      }
      await this.pipelineContent.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_content_error", error: String(err) }));
      });
    }
```

4. `syncBatch` 的 `existing` 查询删掉,改为对每个 item 走 `entityState.claim`
   (`entity: "content"`、`channelId: ""`、`secondaryId: ""`、`sourceId: item.source_content_id`,
   指纹取 `source_updated_at|title|summary|source_url`),`claim` 返回 `unchanged` 即 `skipped++`,
   `isNew` 即 `added++`,否则 `updated++`;然后按上面同样的方式发完整行。
5. `recordPublishedContent` 去掉 `status` 字段,改为发完整 R2 行(`is_deleted: 0`)。
6. `recordTriggerContentSeen` 改为 `return await this.entityState.markSeen({ entity: "content_trigger", channelId, secondaryId, sourceId: sourceContentId })`。
7. `list` / `get` 改为调用 `listContents(this.r2Env!, this.tenantId, channelType)` / `getContent(...)`。
8. `update` / `delete` 全文替换为(**删掉 `status` 参数与 `VALID_STATUSES`**):

```ts
  // R2 是 append-only 且读路径按 QUALIFY 取整行最新,所以"改一个字段"必须
  // 读整行 → 覆盖 → 整行回写。只发 {id, title} 会把其余列全部写成 null。
  async update(id: string, fields: { title?: string; summary?: string }): Promise<void> {
    if (!this.r2Env) throw new Error("ContentService.update: r2Env is required");
    const row = await getContent(this.r2Env, this.tenantId, id);
    if (!row) throw new Error(`ContentService.update: content ${id} not found`);

    const next: Record<string, unknown> = { ...row };
    if (fields.title !== undefined) next.title = fields.title;
    if (fields.summary !== undefined) next.summary = fields.summary;
    next.tenant_id = this.tenantId;
    next.is_deleted = 0;
    next.updated_at = new Date().toISOString();

    await this.pipelineContent?.send([next]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_content_error", contentId: id, error: String(err) }));
    });
  }

  // 逻辑删除:uniscrm-web/CLAUDE.md「重要的被关联数据用逻辑删除」,
  // 而且 Iceberg sink 本来也没有 DELETE。
  async delete(id: string): Promise<void> {
    if (!this.r2Env) throw new Error("ContentService.delete: r2Env is required");
    const row = await getContent(this.r2Env, this.tenantId, id);
    if (!row) throw new Error(`ContentService.delete: content ${id} not found`);

    const next: Record<string, unknown> = { ...row };
    next.tenant_id = this.tenantId;
    next.is_deleted = 1;
    next.updated_at = new Date().toISOString();

    await this.pipelineContent?.send([next]).catch((err) => {
      console.error(JSON.stringify({ event: "pipeline_content_error", contentId: id, error: String(err) }));
    });
    await this.vectorize.deleteByIds([id]);
  }
```

- [ ] **Step 6: 改 `link/tests/services/content.test.ts`**

把 `createMockTenantDb()` 换成 `createMockEntityState()`:

```ts
function createMockEntityState(overrides: Partial<{ entityId: string; isNew: boolean; unchanged: boolean }> = {}) {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "c-uuid", isNew: true, unchanged: false, ...overrides }),
    markSeen: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn(),
    getFollowByEntityId: vi.fn(),
  };
}
```

新增/改写这些用例:

```ts
it("sends a complete row to the content pipeline — every mapped column present, null when absent", async () => {
  const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
  const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

  await service.upsertContentFromMetadata(
    { id: "t1", text: "hi" },
    { source_content_id: "t1", content_type: "TWEET", content_text: "hi" },
    "chan1", "X", false
  );

  const [[record]] = pipeline.send.mock.calls[0];
  for (const col of ["title", "summary", "duration", "height", "width", "has_face", "view_count"]) {
    expect(record).toHaveProperty(col);
  }
  expect(record.is_deleted).toBe(0);
  expect(record.tenant_id).toBe(42);
});

it("does not send to the pipeline when entity_state reports the fingerprint unchanged", async () => {
  const pipeline = { send: vi.fn() };
  const service = new ContentService(
    createMockEntityState({ isNew: false, unchanged: true }) as any,
    vectorize as any, ai as any, 42, pipeline as any
  );

  await service.upsertContentFromMetadata(
    { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false
  );

  expect(pipeline.send).not.toHaveBeenCalled();
});

it("keeps only unmapped payload fields in raw_data", async () => {
  const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
  const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

  await service.upsertContentFromMetadata(
    { id: "t1", content_text: "hi", weird_field: 1 },
    { source_content_id: "t1", content_text: "hi" },
    "chan1", "X", false
  );

  const [[record]] = pipeline.send.mock.calls[0];
  const raw = JSON.parse(record.raw_data as string);
  expect(raw).toHaveProperty("weird_field", 1);
  expect(raw).not.toHaveProperty("content_text");
});

it("delete() writes a full row with is_deleted = 1 instead of removing anything", async () => {
  const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows: [{ id: "c1", channel_id: "chan1", title: "t" }] } }), { status: 200 })
  ));
  const r2Env = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };
  const service = new ContentService(
    createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any, undefined, r2Env
  );

  await service.delete("c1");

  const [[record]] = pipeline.send.mock.calls[0];
  expect(record.is_deleted).toBe(1);
  expect(record.id).toBe("c1");
  vi.unstubAllGlobals();
});
```

删掉所有断言 `tenantDb.run` 收到 `INSERT INTO content` / `DELETE FROM content` 的旧用例,
以及断言 `status` 的用例。

- [ ] **Step 7: 跑 link 全量测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run
```
Expected: PASS(poller 相关测试此时可能因构造签名变化而失败 —— 一并改掉它们的 `createMockTenantDb`)

- [ ] **Step 8: 提交**

```bash
git add link/src/services/r2-entities.ts link/src/services/content.ts \
        link/tests/services/r2-entities.test.ts link/tests/services/content.test.ts \
        link/tests/services/pollers/
git commit -m "feat(link): content writes full rows to R2, dedup via entity_state"
```

---

## Task 5: `link` 用户写入路径切到 R2 + 修复 `is_follow`

**Files:**
- Modify: `link/src/services/x-users.ts`
- Modify: `link/src/webhook.ts`
- Test: `link/tests/services/x-users.test.ts`、`link/tests/services/x-followers.test.ts`

**Interfaces:**
- Consumes: `EntityStateStore`、`fingerprintOf`、`Pipeline`
- Produces:
  - `XUsersService` 构造签名:`constructor(entityState: EntityStateStore, opts?: { queue?; pipelineEvent?; pipelineUser?; tenantId?: number })`
  - `upsertUser(user, channelId, channelType, follow?: { is_follow?: 0|1; is_followed?: 0|1 }): Promise<string>` —— 返回 `entityId`
  - `upsertUserFromMetadata(rawItem, resolvedProps, channelId, channelType): Promise<boolean>`
  - **删除** `setFollowState`、`setUserActive`

> 这个任务同时修掉一个现存的数据准确性 bug:今天 `setFollowState` 只写 D1 不发 pipeline,
> `upsertUser` 发 pipeline 时硬编码 `is_follow: 0, is_followed: 0`,而 Users 列表页已经在读
> R2 的这两列 —— 所以列表页显示的关注状态**全是 0**。

- [ ] **Step 1: 写失败测试**

在 `link/tests/services/x-users.test.ts` 追加:

```ts
it("sends is_follow = 1 on the same full row when the webhook reports a follow", async () => {
  const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
  const entityState = {
    claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: true, unchanged: false }),
    setFollow: vi.fn().mockResolvedValue(undefined),
  };
  const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

  await service.upsertUser({ id: "x1", name: "Ann", username: "ann" } as any, "chan1", "X", { is_follow: 1 });

  const [[record]] = pipelineUser.send.mock.calls[0];
  expect(record.is_follow).toBe(1);
  expect(record.is_followed).toBe(0);
  expect(record.is_deleted).toBe(0);
  expect(record.tenant_id).toBe(42);
  // entity_state 是 flow userPropsFilter 的热读来源,必须同步写
  expect(entityState.setFollow).toHaveBeenCalledWith(
    expect.objectContaining({ entity: "user", channelId: "chan1", sourceId: "x1" }),
    "is_follow",
    1
  );
});

it("preserves the previously stored follow state when a plain poll re-upserts the user", async () => {
  const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
  const entityState = {
    claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: false }),
    get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 1, is_followed: 0 }),
    setFollow: vi.fn(),
  };
  const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

  await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

  const [[record]] = pipelineUser.send.mock.calls[0];
  // 不带 follow 参数的 upsert 绝不能把已知的 is_follow 冲回 0
  expect(record.is_follow).toBe(1);
});

it("skips the pipeline when entity_state reports unchanged", async () => {
  const pipelineUser = { send: vi.fn() };
  const entityState = {
    claim: vi.fn().mockResolvedValue({ entityId: "u-uuid", isNew: false, unchanged: true }),
    get: vi.fn().mockResolvedValue({ entity_id: "u-uuid", fingerprint: "x", is_follow: 0, is_followed: 0 }),
    setFollow: vi.fn(),
  };
  const service = new XUsersService(entityState as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

  await service.upsertUser({ id: "x1", name: "Ann" } as any, "chan1", "X");

  expect(pipelineUser.send).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/services/x-users.test.ts
```
Expected: FAIL —— `setFollow is not a function` / `is_follow` 为 0

- [ ] **Step 3: 改 `x-users.ts`**

要点:

1. 构造函数第一参数换成 `EntityStateStore`,删掉 `TenantDataDB` import。
2. `upsertUser` 新增第 4 个可选参数 `follow?: { is_follow?: 0 | 1; is_followed?: 0 | 1 }`,
   返回 `entityId`:

```ts
  async upsertUser(
    user: XUserData,
    channelId: string,
    channelType: string,
    follow?: { is_follow?: 0 | 1; is_followed?: 0 | 1 }
  ): Promise<string> {
    console.log(JSON.stringify({ event: "x_user_raw", user_id: user.id, payload: user }));
    const now = new Date().toISOString();
    const key = { entity: "user" as const, channelId, sourceId: user.id };

    const tracked = { name: user.name, username: user.username, profile_image_url: user.profile_image_url };
    const fingerprint = await fingerprintOf(tracked, ["name", "username", "profile_image_url"]);
    const { entityId, unchanged } = await this.entityState.claim(key, fingerprint);

    // follow 状态先落 D1(flow userPropsFilter 的热读来源),再读回来带进 R2 整行。
    if (follow?.is_follow !== undefined) await this.entityState.setFollow(key, "is_follow", follow.is_follow);
    if (follow?.is_followed !== undefined) await this.entityState.setFollow(key, "is_followed", follow.is_followed);

    const changedFollow = follow !== undefined;
    if (unchanged && !changedFollow) return entityId;

    const stored = await this.entityState.get(key);
    const isFollow = follow?.is_follow ?? stored?.is_follow ?? 0;
    const isFollowed = follow?.is_followed ?? stored?.is_followed ?? 0;

    if (this.pipelineUser && this.tenantId) {
      const resolved = resolveProps(user as Record<string, unknown>, X_USER_MAPPINGS, X_USER_META?.linkPrefix);
      const mapped = new Set(["id", ...INSIGHT_PROPS.map((p) => p.propId), "name", "username", "profile_image_url"]);
      const leftover: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(user as Record<string, unknown>)) {
        if (!mapped.has(k)) leftover[k] = v;
      }

      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id: entityId,
        channel_id: channelId,
        source_user_id: user.id,
        channel_type: channelType,
        name: user.name || null,
        username: user.username || null,
        is_active: 1,
        is_follow: isFollow,
        is_followed: isFollowed,
        is_deleted: 0,
        raw_data: JSON.stringify(leftover),
        created_at: now,
        updated_at: now,
      };
      for (const prop of INSIGHT_PROPS) {
        record[prop.propId] = resolved[prop.propId] ?? null;
      }
      await this.pipelineUser.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_user_error", error: String(err) }));
      });
    }
    return entityId;
  }
```

3. `upsertUserFromMetadata` 同样改造:`claim` 取 id/unchanged,发完整行(所有 `INSIGHT_PROPS` 列
   缺失时写 `null`,加 `is_follow`/`is_followed` 从 `entityState.get` 读、`is_deleted: 0`、`raw_data` 为剩余字段)。
4. **删除** `setFollowState` 和 `setUserActive`。
5. `insertEvents` 的 R2 记录加 `raw_data`(剩余字段)。
6. `upsertUsers` 里那段 `SELECT id FROM user WHERE id IN (...)` 改为逐个 `entityState.claim`,
   `isNew` 为真的进 `newUserIds`。

- [ ] **Step 4: 改 `webhook.ts` 的两处调用**

```ts
      // follow 状态与用户快照一次性写完:R2 读路径按 QUALIFY 取整行最新,
      // 分两次写会让后一次把前一次的列冲成 null。
      await usersService.upsertUser(userData as XUserData, channelId, "X", { is_follow: isFollow ? 1 : 0 });
```

另一处对称地传 `{ is_followed: isFollow ? 1 : 0 }`。删掉紧随其后的两行 `setFollowState` 调用。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run
```
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add link/src/services/x-users.ts link/src/webhook.ts link/tests/services/
git commit -m "fix(link): user writes full rows to R2 including real is_follow state"
```

---

## Task 6: `link` 路由与前端 —— 读 R2、删详情页、删 status

**Files:**
- Modify: `link/src/routes-users.ts`、`link/src/routes-contents.ts`、`link/src/routes-lists.ts`、`link/src/middleware.ts`、`link/src/index.ts`
- Delete: `link/frontend/pages/UserDetail.tsx`
- Modify: `link/frontend/pages/Users.tsx`(去掉行点击跳转)、`link/frontend/components/ContentTable.tsx`(`onUpdate` 类型收窄)、前端路由表
- Test: `link/tests/routes-users.test.ts`(新)

**Interfaces:**
- Consumes: `r2-entities.ts` 的 `listUsers` / `getUserNames` / `listContents` / `getContent`
- Produces: 路由 `GET /api/users`(R2)、`GET /api/items`、`PATCH /api/items/:id`、`DELETE /api/items/:id`;
  `middleware.ts` 不再 `c.set("tenantDataDb", ...)`,改为 `c.set("entityState", new EntityStateStore(c.env.LINK_DB, session.tenant_id))`

- [ ] **Step 1: 写失败测试 `link/tests/routes-users.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { usersRoutes } from "../src/routes-users";

afterEach(() => vi.unstubAllGlobals());

function appWithTenant(tenantId: number) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tenantId" as never, tenantId); await next(); });
  app.route("/api/users", usersRoutes());
  return app;
}

const ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };

it("lists users from R2 scoped to the caller's tenant", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows: [{ id: "u1", name: "Ann" }] } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);

  const res = await appWithTenant(7).request("/api/users", {}, ENV);

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ users: [{ id: "u1", name: "Ann" }] });
  const q = JSON.parse(fetchMock.mock.calls[0][1].body as string).query as string;
  expect(q).toContain("tenant_id = 7");
});

it("returns 502 with the R2 error rather than an empty list when R2 SQL fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: "80011: Unauthenticated" }), { status: 401 })
  ));

  const res = await appWithTenant(7).request("/api/users", {}, ENV);

  expect(res.status).toBe(502);
  expect(JSON.stringify(await res.json())).toContain("80011");
});

it("no longer exposes the per-user detail route", async () => {
  const res = await appWithTenant(7).request("/api/users/u1", {}, ENV);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run tests/routes-users.test.ts
```
Expected: FAIL —— 详情路由仍返回 200 / 失败时返回空列表

- [ ] **Step 3: 改路由**

`link/src/routes-users.ts` 全文替换为:

```ts
import { Hono } from "hono";
import type { Env } from "./types";
import { listUsers } from "./services/r2-entities";
import { R2SqlError } from "../../shared/r2-sql";

export function usersRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    try {
      const users = await listUsers(c.env, tenantId, 1000);
      return c.json({ users });
    } catch (err) {
      // 静默返回空列表会把「查询挂了」伪装成「没有用户」——
      // 「数据准确性 > 系统稳定性 > 功能 > UI 界面」。
      console.error(JSON.stringify({ event: "users_r2_query_failed", tenantId, error: String(err) }));
      const status = err instanceof R2SqlError ? 502 : 500;
      return c.json({ error: String(err) }, status);
    }
  });

  return router;
}
```

`link/src/routes-contents.ts`:
- 把 `c.get("tenantDataDb")` 换成 `c.get("entityState")`
- `ContentService` 的构造参数是 `(entityState, vectorize, ai, tenantId, pipelineContent?, flowQueue?, r2Env?)`,
  所以 4 个路由里全部改成完整 7 参形式,中间的可选项显式传:

```ts
const service = new ContentService(
  entityState, c.env.VECTORIZE, c.env.AI, tenantId,
  c.env.PIPELINE_CONTENT, undefined, c.env
);
```

- `PATCH /items/:id` 的 body 类型收窄为 `{ title?: string; summary?: string }`(去掉 `status`)
- 四个路由都套 Task 6 Step 3 里同样的 try/catch → `R2SqlError` 返回 502、其它返回 500

`link/src/routes-lists.ts:70` 的 `SELECT id, name, username, updated_at FROM user WHERE id IN (...)`
换成 `await getUserNames(c.env, tenantId, ids)`。

`link/src/middleware.ts`:删掉 `TenantDataDB` 的 import、`SELECT d1_database_id FROM tenants` 查询、
`c.set("tenantDataDb", ...)`;改为:

```ts
  c.set("entityState" as never, new EntityStateStore(c.env.LINK_DB, session.tenant_id));
```

`link/src/index.ts`:删掉 `GET /api/users/:id` 与 `GET /api/users/:id/events` 的挂载(若在此处)。

- [ ] **Step 4: 删前端详情页**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
rm link/frontend/pages/UserDetail.tsx
```

`link/frontend/App.tsx`:删掉第 7 行 `import { UserDetail } from "./pages/UserDetail";`
与第 36 行 `<Route path="/users/:id" element={<UserDetail />} />`。

`link/frontend/pages/Users.tsx`:删掉第 39 行 `onRowClick={(r) => navigate(\`/users/${r.id}\`)}`,
以及第 2 行的 `useNavigate` import 和第 19 行的 `const navigate = useNavigate();`
(删完后 `navigate` 不再被使用,留着会触发 TS 的 unused 报错)。

`link/frontend/components/ContentTable.tsx` 的 `onUpdate` 类型已经是
`{ title?: string; summary?: string }`,无需改。

- [ ] **Step 5: 跑测试 + 构建前端**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run && npx vite build
```
Expected: 测试 PASS,构建无 TS 报错

- [ ] **Step 6: 部署 dev 并浏览器自测**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web && wrangler deploy --env dev --config link/wrangler.toml
```

在浏览器打开 `https://link-dev.uni-scrm.com/users` 与 `/content`:
- Users 列表有数据、`is_follow` 列显示真实值(不再全是"未关注")
- 点击用户行不再跳转
- Content 列表可编辑 title/summary 并保存后刷新仍在
- 删除一条后列表里消失

- [ ] **Step 7: 提交**

```bash
git add link/src/routes-users.ts link/src/routes-contents.ts link/src/routes-lists.ts \
        link/src/middleware.ts link/src/index.ts link/frontend link/tests/routes-users.test.ts
git commit -m "feat(link): read entities from R2, drop user detail page and content status"
```

---

## Task 7: `link` 剩余的 tenant DB 调用点

**Files:**
- Modify: `link/src/webhook.ts`、`link/src/webhook-youtube.ts`、`link/src/routes-internal.ts`、`link/src/routes-channels.ts`、`link/src/services/pollers/poll-channel.ts` 与 5 个 poller
- Modify: `link/src/types.ts`(删 `CF_D1_API_TOKEN`,若无其它用途)
- Test: 对应 `link/tests/`

**Interfaces:**
- Consumes: `EntityStateStore`
- Produces: `link` 模块内不再有任何 `TenantDataDB` 引用

- [ ] **Step 1: 全仓定位剩余引用**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
grep -rn "TenantDataDB\|tenantDataDb\|d1DatabaseId\|d1_database_id" --include="*.ts" link/src
```
把输出逐条处理完为止。

- [ ] **Step 2: 逐个替换**

- `ChannelInfo` 接口去掉 `d1DatabaseId` 字段;所有构造点同步删。
- `poll-channel.ts` 里 `new TenantDataDB(...)` 换成 `new EntityStateStore(env.LINK_DB, tenantId)`,
  各 poller 的 `ctx.tenantDb` 改名 `ctx.entityState`,类型改 `EntityStateStore`。
- `webhook.ts` / `webhook-youtube.ts` 里从 `tenants` 表取 `d1_database_id` 的查询整段删掉。
- `routes-internal.ts` / `routes-channels.ts` 里 `c.get("tenantDataDb")` 换成 `c.get("entityState")`。

- [ ] **Step 3: 确认没有残留**

```bash
grep -rn "TenantDataDB\|tenantDataDb" --include="*.ts" link/ | grep -v node_modules
```
Expected: 无输出

- [ ] **Step 4: 跑 link 全量测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run
```
Expected: PASS

- [ ] **Step 5: 部署 dev 并触发一次真实抓取**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web && wrangler deploy --env dev --config link/wrangler.toml
wrangler tail link-dev --env dev --config link/wrangler.toml --format pretty
```

在另一个终端触发 X channel 的一次 poll(或等 cron),观察日志里没有 D1 REST 报错;
然后查 R2 确认写入:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<token>
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev \
  "SELECT COUNT(DISTINCT id) FROM uniscrm.user WHERE tenant_id = 1"
```
Expected: 数字 > 0

- [ ] **Step 6: 提交**

```bash
git add link/src link/tests
git commit -m "refactor(link): remove all TenantDataDB call sites"
```

---

## Task 8: `flow` —— `is_follow` 读 `entity_state`、删 `changeUserProps`

**Files:**
- Modify: `flow/wrangler.toml`(加 `LINK_DB` binding)、`flow/src/types.ts`、`flow/src/index.ts`、`flow/src/engine.ts`、`flow/nodeTypeRegistry.ts`
- Delete: `flow/frontend/nodes/ChangeUserPropsNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`、`flow/frontend/components/Sidebar.tsx`、`flow/frontend/components/Inspector.tsx`、`flow/frontend/store/flow-editor.ts`
- Test: `flow/tests/unit/`

**Interfaces:**
- Consumes: `EntityStateStore`(经 `LINK_DB` binding)、`r2Query` / `latestRowsSql`
- Produces: `flow` 不再引用 `TenantDataDB`;`changeUserProps` 从 `NODE_TYPE_REGISTRY` 与画布中移除

> `changeUserProps` 删除的理由(spec 已记录):Inspector 是两个自由文本框,后端裸拼
> `UPDATE user SET ${u.field} = ?` —— 没有白名单、没有自定义属性存储、只能改固定列,
> 且是 SQL 注入面。

- [ ] **Step 1: 加 `LINK_DB` binding**

`flow/wrangler.toml` 的 `[env.dev]` 与 `[env.production]` 各加一段:

```toml
[[env.dev.d1_databases]]
binding = "LINK_DB"
database_name = "uniscrm-link-dev"
database_id = "464f02da-5a53-438d-8f7b-f92519cf8bd9"
```

```toml
[[env.production.d1_databases]]
binding = "LINK_DB"
database_name = "uniscrm-link"
database_id = "279a86a5-985c-4a22-8d50-ebc64c8ed63b"
```

`flow/src/types.ts` 的 `Env` 加 `LINK_DB: D1Database;`。

- [ ] **Step 2: 写失败测试**

创建 `flow/tests/unit/user-props-filter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveUserPropsForFilter } from "../../src/index";

describe("resolveUserPropsForFilter", () => {
  it("reads is_follow from entity_state, not from a tenant D1", async () => {
    const first = vi.fn().mockResolvedValue({ is_follow: 1, is_followed: 0 });
    const env = {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first }) }) },
    };

    const props = await resolveUserPropsForFilter(env as any, 7, "u1");

    expect(props).toEqual({ is_follow: 1, is_followed: 0 });
  });

  it("returns an empty object when the user is unknown, so a fail-closed filter blocks the action", async () => {
    const env = {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) },
    };

    expect(await resolveUserPropsForFilter(env as any, 7, "nope")).toEqual({});
  });
});
```

创建 `flow/tests/unit/change-user-props-removed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { buildGeneratePrompt } from "../../src/generate-prompt";

describe("changeUserProps removal", () => {
  it("is gone from the node type registry", () => {
    expect(NODE_TYPE_REGISTRY).not.toHaveProperty("changeUserProps");
  });

  it("is never offered to the flow-generating model", () => {
    expect(buildGeneratePrompt("user")).not.toContain("changeUserProps");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npx vitest run tests/unit/user-props-filter.test.ts tests/unit/change-user-props-removed.test.ts
```
Expected: FAIL

- [ ] **Step 4: 改 `flow/src/index.ts`**

导出新函数并替换 `xAction` 分支里的 tenant DB 读取:

```ts
// flow 唯一的 user props 热读是 metadata/x.ts 的 userPropsFilter,而它只用到 is_follow。
// 这两列常驻 entity_state(D1 binding,毫秒级),不走 R2 —— R2 单次查询 1-3s,
// 会把每次 xAction 都拖慢。
export async function resolveUserPropsForFilter(
  env: Env,
  tenantId: number,
  userId: string
): Promise<Record<string, unknown>> {
  const row = await env.LINK_DB
    .prepare(`SELECT is_follow, is_followed FROM entity_state WHERE tenant_id = ? AND entity_id = ?`)
    .bind(tenantId, userId)
    .first<{ is_follow: number | null; is_followed: number | null }>();
  if (!row) return {};
  return { is_follow: row.is_follow, is_followed: row.is_followed };
}
```

`xAction` 分支:

```ts
      const meta = EventMetadata_X.find(m => m.eventType === action.xEvent);
      if (meta?.userPropsFilter?.length) {
        const row = await resolveUserPropsForFilter(env, Number(tenantId), userId);
        const pass = passesPropsFilter(meta.userPropsFilter, row);
        if (!pass) {
          console.log(JSON.stringify({ event: "flow_action_skipped_filter", xEvent: action.xEvent, userId, filter: meta.userPropsFilter, actual: row }));
          continue;
        }
      }
```

删掉整个 `action.type === "changeUserProps"` 分支;
`flow/src/index.ts:1463` 那句 `SELECT id, name FROM user WHERE id IN (...)` 换成
`await getUserNames(c.env, tenantId, ids)`(从 `link/src/services/r2-entities.ts` 抽到
`shared/r2-entities.ts` 或在 flow 侧直接用 `latestRowsSql` 重写一份 —— 选后者,避免跨模块 import);
删掉 `TenantDataDB` 的 import 与所有 `new TenantDataDB(...)`。

- [ ] **Step 5: 改 `engine.ts` / `nodeTypeRegistry.ts` / 前端**

- `nodeTypeRegistry.ts`:删 `changeUserProps` 条目;从第 322 行的 domain 白名单数组里删掉它
- `engine.ts`:删掉指向 `changeUserProps` 的 action push(若有)
- `generate-prompt.ts`:第 64 行的 "Do NOT use ..." 列表里删掉 `changeUserProps`
- 前端:`rm flow/frontend/nodes/ChangeUserPropsNode.tsx`;
  `nodes/index.ts`、`Sidebar.tsx`、`Inspector.tsx`(第 1362 与 1437 两处 + `ChangeUserPropsInspector` 组件)、
  `store/flow-editor.ts`(第 73/74 的 valid 数组、第 147-148 的分支)各删掉对应引用

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/flow && npx vitest run && npx vite build
```
Expected: PASS + 构建无 TS 报错

- [ ] **Step 7: 部署 dev 并自测**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web && wrangler deploy --env dev --config flow/wrangler.toml
```

浏览器打开 `https://flow-dev.uni-scrm.com`:侧栏没有 Change User Props 节点;
打开一个含 xAction 的 flow,Analytics tab 的 node log 抽屉里用户名正常显示。

- [ ] **Step 8: 提交**

```bash
git add flow/
git commit -m "feat(flow): read is_follow from entity_state, remove changeUserProps node"
```

---

## Task 9: `insight-segment` —— 分群改跑 R2,membership 落 `segment_users`

**Files:**
- Create: `web/migrations/<下一个序号>_segment_users.sql`
- Modify: `insight-segment/src/fields.ts`、`insight-segment/src/services/sql-builder.ts`、`insight-segment/src/index.ts`、`insight-segment/wrangler.toml`(补 R2 SQL 相关 vars/secret)
- Test: `insight-segment/tests/sql-builder.test.ts`

**Interfaces:**
- Consumes: `shared/r2-sql.ts`
- Produces: `buildSegmentQuery(conditions, fields, tenantId): { sql: string }` —— 不再返回 `params`(R2 SQL 无绑定参数)

- [ ] **Step 1: 写迁移**

创建 `web/migrations/<下一个序号>_segment_users.sql`:

```sql
CREATE TABLE segment_users (
  tenant_id  INTEGER NOT NULL,
  segment_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, user_id)
);
CREATE INDEX idx_segment_users_tenant ON segment_users(tenant_id);
```

序号取 `ls web/migrations/` 里最大值 +1。

- [ ] **Step 2: 写失败测试**

`insight-segment/tests/sql-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSegmentQuery } from "../src/services/sql-builder";
import { getAllFields } from "../src/fields";

const fields = getAllFields();

describe("buildSegmentQuery", () => {
  it("targets the R2 tables and always filters by tenant", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields,
      7
    );
    expect(sql).toContain("uniscrm.user");
    expect(sql).toContain("tenant_id = 7");
    expect(sql).not.toContain("profile");
  });

  it("joins uniscrm.event only when a condition needs it", () => {
    const noEvent = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "name", operator: "=", value: "Ann" }] },
      fields, 7
    ).sql;
    expect(noEvent).not.toContain("uniscrm.event");
  });

  it("escapes string values instead of interpolating them raw", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "name", operator: "=", value: "o'brien" }] },
      fields, 7
    );
    expect(sql).toContain("'o''brien'");
  });

  it("reads followers_count as a real column now that R2 has one", () => {
    const { sql } = buildSegmentQuery(
      { logic: "AND", conditions: [{ field: "followers_count", operator: ">", value: 100 }] },
      fields, 7
    );
    expect(sql).not.toContain("json_extract");
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/insight-segment && npx vitest run
```
Expected: FAIL

- [ ] **Step 4: 改 `fields.ts` 的 `SQL_EXPR_MAP`**

```ts
// R2 的 uniscrm.user 把这些做成了真实列,不再需要从 raw_data 里 json_extract。
const SQL_EXPR_MAP: Record<string, { source: "user" | "event"; sqlExpr: string }> = {
  name: { source: "user", sqlExpr: "u.name" },
  username: { source: "user", sqlExpr: "u.username" },
  followers_count: { source: "user", sqlExpr: "u.followers_count" },
  following_count: { source: "user", sqlExpr: "u.following_count" },
  verified_type: { source: "user", sqlExpr: "u.verified_type" },
  is_follow: { source: "user", sqlExpr: "u.is_follow" },
  is_followed: { source: "user", sqlExpr: "u.is_followed" },
};
```

- [ ] **Step 5: 改 `sql-builder.ts`**

```ts
import { sqlStr, sqlInt } from "../../../shared/r2-sql";

export interface SqlResult { sql: string }

export function buildSegmentQuery(
  conditions: ParsedConditions,
  fields: InsightField[],
  tenantId: number
): SqlResult {
  const needsEvent = conditions.conditions.some((c) => {
    const field = fields.find((f) => f.propId === c.field);
    return field?.source === "event";
  });

  // R2 SQL 没有绑定参数,所有值必须经 sqlStr/sqlInt 转义。
  const clauses: string[] = [`u.tenant_id = ${sqlInt(tenantId)}`, "u.is_deleted = 0"];

  for (const cond of conditions.conditions) {
    const field = fields.find((f) => f.propId === cond.field)!;
    const expr = field.sqlExpr;
    const lit = (v: string | number) =>
      field.dataType === "INT" || field.dataType === "ENUM_INT" ? sqlInt(Number(v)) : sqlStr(String(v));

    if (cond.timeRelative && field.dataType === "DATETIME") {
      const days = parseInt(cond.timeRelative, 10);
      clauses.push(`${expr} >= (NOW() - INTERVAL '${sqlInt(days)} days')`);
    } else if (cond.operator === "IN") {
      const vals = cond.value as string[];
      clauses.push(`${expr} IN (${vals.map(lit).join(", ")})`);
    } else if (cond.operator === "BETWEEN") {
      const [lo, hi] = cond.value as [string, string];
      clauses.push(`${expr} BETWEEN ${lit(lo)} AND ${lit(hi)}`);
    } else {
      clauses.push(`${expr} ${cond.operator} ${lit(cond.value as string | number)}`);
    }
  }

  const join = needsEvent
    ? `\nINNER JOIN uniscrm.event e ON e.user_id = u.id AND e.tenant_id = ${sqlInt(tenantId)}`
    : "";

  const sql = `SELECT DISTINCT u.id FROM uniscrm.user u${join}
WHERE ${clauses.join(conditions.logic === "OR" ? " OR " : " AND ")}
QUALIFY ROW_NUMBER() OVER (PARTITION BY u.channel_id, u.source_user_id ORDER BY u.updated_at DESC) = 1
LIMIT 10000`;

  return { sql };
}
```

- [ ] **Step 6: 改 `insight-segment/src/index.ts` 的 compute / users 两个路由**

`POST /api/segments/:id/compute` 的 try 块:

```ts
    const conditions = JSON.parse(segment.conditions_json);
    const fields = getAllFields();
    const { sql } = buildSegmentQuery(conditions, fields, tenantId);

    const rows = await r2Query<{ id: string }>(c.env, sql);
    const userIds = rows.map((r) => r.id);

    await c.env.WEB_DB.prepare(`DELETE FROM segment_users WHERE tenant_id = ? AND segment_id = ?`)
      .bind(tenantId, segmentId)
      .run();

    const now = new Date().toISOString();
    const BATCH_SIZE = 50;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      await c.env.WEB_DB.batch(
        userIds.slice(i, i + BATCH_SIZE).map((uid) =>
          c.env.WEB_DB
            .prepare(`INSERT OR IGNORE INTO segment_users (tenant_id, segment_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
            .bind(tenantId, segmentId, uid, now)
        )
      );
    }
```

`GET /api/segments/:id/users`:先从 `segment_users` 取分页的 `user_id`,
再用 `latestRowsSql` 从 `uniscrm.user` 拉这批 id 的 `name`/`username` 合并返回。

`insight-segment/wrangler.toml` 的 dev/production 各补 `R2_BUCKET` / `R2_WAREHOUSE` vars
(值抄 `link/wrangler.toml`),`R2_SQL_TOKEN` 走 `scripts/sync-secrets.sh`。

- [ ] **Step 7: 跑测试 + 应用迁移 + 部署自测**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/insight-segment && npx vitest run
cd /Users/zc/Documents/UniSCRM/uniscrm-web
wrangler d1 migrations apply uniscrm-web-dev --env dev --config web/wrangler.toml --remote
wrangler deploy --env dev --config insight-segment/wrangler.toml
```

浏览器建一个 `followers_count > 100` 的分群 → compute → 成员列表有人。

- [ ] **Step 8: 提交**

```bash
git add web/migrations insight-segment/
git commit -m "feat(insight-segment): compute segments from R2, store membership in segment_users"
```

---

## Task 10: 删除 `profile` 模块

**Files:**
- Delete: `profile/`(整个目录)
- Modify: `.github/workflows/deploy-prod.yml`、`.github/workflows/deploy-dev.yml`、`scripts/deploy-all.sh`、`scripts/sync-secrets.sh`、`scripts/tenant-scope-audit.mjs`、`uniscrm-web/CLAUDE.md`

**Interfaces:**
- Consumes: 无
- Produces: 无

> 依据:prod `profile` 表 0 行、`segment_profiles` 0 行;`profile` worker 只有
> `/health`、`/internal/maigret-retry`、`/api/auth/me`、`/api/users`;`profile.uni-scrm.com`
> 不在任何 nav 里。`flow/src/index.ts` 那句「Proxy lists from profile worker」注释是过时的,
> 实际转发到 `link`。

- [ ] **Step 1: 确认没有活引用**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
grep -rn "profile-dev\|profile\.uni-scrm\|PROFILE_URL" --include="*.ts" --include="*.tsx" --include="*.toml" --include="*.sh" --include="*.yml" . | grep -v node_modules | grep -v "^./profile/"
```
Expected: 无输出(有输出则先处理)

- [ ] **Step 2: 删除并清理引用**

```bash
rm -rf profile
```

- `.github/workflows/deploy-prod.yml` 与 `deploy-dev.yml`:deploy 矩阵里删掉 `profile`
- `scripts/deploy-all.sh`、`scripts/sync-secrets.sh`:删掉 `profile` 条目
- `scripts/tenant-scope-audit.mjs` 第 4 行 `MODULES` 数组删掉 `"profile"`
- `uniscrm-web/CLAUDE.md` 模块列表删掉 `- profile: maigret container做跨渠道查询。`

- [ ] **Step 3: 跑门禁脚本**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web && node scripts/tenant-scope-audit.mjs && node scripts/tenant-scope-audit.test.mjs
```
Expected: 全部通过

- [ ] **Step 4: 删除 Cloudflare 上的 worker**

```bash
wrangler delete --name profile-dev
wrangler delete --name profile
```

- [ ] **Step 5: 提交**

```bash
git add -A profile .github scripts CLAUDE.md
git commit -m "chore: remove the profile module (maigret cross-channel lookup, unused in prod)"
```

---

## Task 11: 清理 `TenantDataDB` 及其配套设施

**Files:**
- Delete: `shared/tenant-data-db.ts`、`admin/src/services/tenant-init-sql.ts`、`operation/migrations/`(全部 11 个文件)
- Modify: `admin/src/services/tenant-provisioning.ts`、`admin/src/types.ts`、`admin/src/index.ts`、`.github/workflows/deploy-prod.yml`
- Modify: `web/migrations/<下一个序号>_drop_tenant_d1_column.sql`

**Interfaces:**
- Consumes: 无
- Produces: 全仓无 `TenantDataDB`;`tenants` 表不再有 `d1_database_id`

- [ ] **Step 1: 确认全仓无引用**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
grep -rn "TenantDataDB\|tenant-data-db\|TENANT_DB_INIT_SQL" --include="*.ts" . | grep -v node_modules
```
Expected: 只剩 `admin/` 与待删文件自身

- [ ] **Step 2: 改 `admin/src/services/tenant-provisioning.ts`**

删掉建 D1 数据库、跑 `TENANT_DB_INIT_SQL`、把 `d1_database_id` 写回 `tenants` 的整段;
开租户只保留写 `tenants` 行 + billing 初始化。

- [ ] **Step 3: 加迁移移除 `tenants.d1_database_id`**

创建 `web/migrations/<下一个序号>_drop_tenant_d1_column.sql`:

```sql
ALTER TABLE tenants DROP COLUMN d1_database_id;
```

- [ ] **Step 4: 删文件**

```bash
rm shared/tenant-data-db.ts admin/src/services/tenant-init-sql.ts
rm -rf operation/migrations
```

- [ ] **Step 5: 删 CI 的 `migrate-tenant-dbs` job**

`.github/workflows/deploy-prod.yml`:整段删掉 `migrate-tenant-dbs` job;
把 `deploy` job 的 `needs:` 里对它的引用一并去掉。

- [ ] **Step 6: 跑全仓测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
for m in admin analytics content flow insight-segment link trend-skill web; do
  echo "=== $m"; (cd $m && npx vitest run) || exit 1
done
```
Expected: 全绿

- [ ] **Step 7: 应用迁移 + 部署 dev + 端到端自测**

```bash
wrangler d1 migrations apply uniscrm-web-dev --env dev --config web/wrangler.toml --remote
for m in link flow insight-segment admin analytics web; do
  wrangler deploy --env dev --config $m/wrangler.toml
done
```

浏览器完整走一遍:登录 → Social 连渠道 → Users 列表 → Content 列表(增改删)→
建 flow 并发布 → 触发一次 → Analytics 报表 → 建分群并 compute。

- [ ] **Step 8: 提交**

```bash
git add -A shared admin operation web .github
git commit -m "chore: remove TenantDataDB, tenant provisioning DBs and the migrate-tenant-dbs job"
```

---

## Task 12: 文档、ADR 与删库

**Files:**
- Create: `docs/adr/0005-tenant-db-removed-r2-as-single-source.md`
- Modify: `docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md`
- Modify: `uniscrm-web/CLAUDE.md`
- Modify: `analytics/CLAUDE.md`

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 写 ADR 0005**

创建 `docs/adr/0005-tenant-db-removed-r2-as-single-source.md`:

```markdown
# Per-tenant D1 下线,R2 Data Catalog 成为唯一真相

每个租户一个 D1(`uniscrm-t*`)承载 `user`/`content`/`event`/`profile`/`segment_profiles`/
`content_trigger_dedup`,并且是通过 D1 REST API(而非 binding)访问的 —— 每次读写都是一次
跨网 HTTP。代价是:每开一个租户要建一个库、每次加列要遍历所有租户库跑 ALTER TABLE、
CI 里养着一个专门的 `migrate-tenant-dbs` job;同时 `user`/`content`/`event` 已经双写到
R2 Data Catalog,tenant D1 沦为会漂移的第二份真相。

现在 R2 SQL 补齐了 JOIN(2026-05)与窗口函数/QUALIFY(2026-06),读取时可以用
`QUALIFY ROW_NUMBER() OVER (PARTITION BY <业务键> ORDER BY updated_at DESC) = 1`
直接拿到每个业务键的最新行,正确性不再依赖 analytics 每日 02:00 的 compaction ——
compaction 因此降级为纯存储优化。于是把全部业务字段搬进 R2,per-tenant D1 全部删除。

R2 结构上做不到三件事:原子去重(append-only、无唯一索引)、变更检测(poller 每 tick
重走已抓过的页)、稳定 uuid 映射(点查 1-3s)。这三件事落在 `uniscrm-link` D1 的单张
`entity_state` 表上 —— 每行只有 key + 指纹 + 两个 int,不含任何业务字段,355 个用户约 21 KB。
`is_follow`/`is_followed` 额外常驻此处,因为它们是 flow `userPropsFilter` 的唯一热读,
必须毫秒级;它们同时写入 R2 供 analytics 作为维度,由同一次调用写两处,不会漂移。
原 `content_trigger_dedup` 并入为 `entity='content_trigger'`。

代价是明确接受的:**读路径全部变成 1-3s 的 R2 查询**。用户详情页因此整个删除
(而不是留一个慢页面);Content 列表页的编辑改为「读整行 → 合并 → 整行回写」。
写路径的铁律随之变成**只发完整行** —— QUALIFY 取整行最新,部分写会把未包含的列变成 null。
这条约束直接删掉了两个功能:`content.status` 编辑(本来就没有任何读取方)和 flow 的
`changeUserProps` 节点(Inspector 是自由文本框,后端裸拼 `UPDATE user SET ${field}`,
既是注入面又只能改固定列)。

跨渠道 profile(maigret)一并删除:prod 上 `profile` 与 `segment_profiles` 都是 0 行。
后果是分群从「跨渠道的人」降级为「单渠道账号」,membership 改存 `uniscrm-web` 的
`segment_users`。

R2 三张表因为 sink schema 不可改而全部旁置重建,**历史数据不迁移** —— prod 当时只有
355 user / 40 content / 6 event。

最大的新风险:R2 从「分析用」变成产品主链路,`R2_SQL_TOKEN` 一挂整个产品白屏。
所有 R2 读路径因此必须抛错并返回 502,绝不静默返回空列表。
```

- [ ] **Step 2: 给 ADR 0002 补一段**

在 `docs/adr/0002-r2-data-catalog-dedup-via-periodic-compaction.md` 末尾追加:

```markdown

**2026-07-25 更新**:读路径改用 `QUALIFY ROW_NUMBER() OVER (PARTITION BY <业务键>
ORDER BY updated_at DESC) = 1` 之后,compaction 不再承担读取正确性,只是存储优化 ——
两次 compaction 之间的重复行由查询自己滤掉。`compactContentTable` 的 `key_columns`
同步补上了 `list_id`,与读路径的 PARTITION BY 保持一致。见
`docs/adr/0005-tenant-db-removed-r2-as-single-source.md`。
```

- [ ] **Step 3: 改两个 CLAUDE.md**

`uniscrm-web/CLAUDE.md` 的 `# Technical` 段:删掉

> 比较特殊的是tenantdb，各个模块可能都有数据量大的表，要按租户分库放到tenantdb。

替换为:

```
user/content/event 的唯一真相在 R2 Data Catalog（namespace uniscrm）。读取一律经
shared/r2-sql.ts，必须带 tenant_id 过滤并用 QUALIFY 取每个业务键的最新行；写入一律
发完整行——部分写会把未包含的列变成 null。R2 做不到的原子去重/变更检测/uuid 映射
落在 uniscrm-link 的 entity_state 表。见 docs/adr/0005。
```

`analytics/CLAUDE.md` 补一条:

```
- R2 SQL 在 2026-05 支持了 JOIN/子查询/CTE，2026-06 支持了窗口函数/QUALIFY/DISTINCT。
  窗口函数是 budget-gated（预估扫描量过大直接 400），所有查询必须带 WHERE tenant_id = ?。
```

- [ ] **Step 4: 提交文档**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add docs/adr CLAUDE.md analytics/CLAUDE.md
git commit -m "docs: ADR for tenant DB removal, update CLAUDE.md storage rules"
```

- [ ] **Step 5: prod 上线(需用户明确说「push to main」)**

```bash
git push origin main          # 仅在用户明确要求时执行
```

然后手动触发 Deploy Production workflow,按 `analytics/pipelines/rebuild-tables.md`
在 prod 重建三张 R2 表,再应用 `uniscrm-web` / `uniscrm-link` 的迁移。

- [ ] **Step 6: prod 验证后删库(本计划最后一步)**

prod 上完整走一遍浏览器自测(与 Task 11 Step 7 相同的清单),确认无回归后:

```bash
wrangler d1 delete uniscrm-t1
wrangler d1 delete uniscrm-t100000
wrangler d1 delete uniscrm-t100001
wrangler d1 delete uniscrm-t1-dev
```

⚠️ 这一步不可逆。在此之前 tenant DB 全程保留,任一步出问题都可以回滚到读写 tenant DB 的版本。
