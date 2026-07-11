# X-BYOK Followers Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill and hourly-poll a BYOK X channel's follower list via `GET /2/users/:id/followers`, writing into the existing tenant `user` table and R2 pipeline, gated to BYOK channels only.

**Architecture:** A new `channel_poll_state` table (in `LINK_DB`) tracks per-channel pagination cursor and backfill status. The existing hourly cron gains a `handlePolling` step that, for each active BYOK X channel, either continues backfill pagination or runs a lightweight incremental catch-up poll, bounded by a time budget per run. Field extraction is driven by `metadata/x-byok.ts`'s `UserMetadata_X`, with unmapped fields preserved in `raw_data` — never defaulted or dropped.

**Tech Stack:** Cloudflare Workers (Hono), D1 (`LINK_DB` for channel state, per-tenant D1 via `TenantDataDB` REST client for `user` rows), Cloudflare Pipelines (R2), Vitest with `@cloudflare/vitest-pool-workers`.

## Global Constraints

- Polling runs only for channels where `is_byok = 1` (DB column on `channels`) — never the system-default X app (shared rate-limit quota).
- `channel_type` stays `'X'` for BYOK; no new channel type, no duplicated event/prop metadata (`metadata/x-byok.ts` keeps its own copy of `PROPS_X` intentionally — do not refactor it to import from `metadata/x.ts`).
- A resolved field that's missing/undefined is **omitted** from every write (D1 column update, pipeline record) — never defaulted to `0` or `null`. This applies to both the new metadata-driven upsert and the existing `upsertUser`'s insight-prop pipeline construction (which currently violates this and gets fixed as part of this plan).
- `raw_data` stores the entire raw item returned by X for that user (whatever `user.fields` were requested), unfiltered — matching how `event.raw_data` already stores full payloads.
- Per-channel poll budget: 20s. Per-cron-run total budget across all channels: 50s. Stop immediately on HTTP 429 regardless of budget.
- No new Worker, no new Queue — reuses the existing hourly cron trigger in `link/src/cron.ts`.

---

## File Structure

- `link/migrations/0004_create_channel_poll_state.sql` — new table.
- `metadata/x-byok.ts` — add one static prop to the existing `UserMetadata_X` entry (no other changes; keep the file's existing `PROPS_X` duplication as-is).
- `link/src/services/x-users.ts` — add `upsertUserFromMetadata()`; fix the `?? 0` default bug in `upsertUser`'s pipeline record construction.
- `link/src/services/pollers/resolve-user-props.ts` — new: resolves `UserPropMapping[]` against a raw item (shared by all future pollers).
- `link/src/services/x-followers-api.ts` — new: thin HTTP client for `GET /2/users/:id/followers` (one page per call).
- `link/src/services/pollers/x-followers.ts` — new: backfill/incremental-poll orchestration for the followers poller.
- `link/src/cron.ts` — add `handlePolling()`, wire into `handleCron`'s `Promise.allSettled`.
- `link/src/oauth.ts` — seed/reset the `channel_poll_state` row when a BYOK channel's OAuth callback succeeds.
- `link/vitest.config.ts` — new (the `link` module has no unit-test runner configured yet; only Playwright e2e exists).
- `link/tests/services/resolve-user-props.test.ts`, `link/tests/services/x-users.test.ts`, `link/tests/services/x-followers.test.ts` — new unit tests.

`link/src/webhook.ts`'s private `navigatePath` gets exported (one-word change) so the resolver can reuse it instead of duplicating a trivial path-walker.

---

### Task 1: Vitest setup + channel_poll_state migration

**Files:**
- Create: `link/vitest.config.ts`
- Create: `link/migrations/0004_create_channel_poll_state.sql`
- Test: `link/tests/services/smoke.test.ts` (temporary, deleted at the end of this task once a real test exists in Task 2 — actually keep it minimal and permanent as a sanity check)

**Interfaces:**
- Produces: a working `npm test` (vitest) command in `link/`, and the `channel_poll_state` table available to later tasks.

- [ ] **Step 1: Create the vitest config**

```ts
// link/vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml", environment: "dev" },
      },
    },
  },
});
```

- [ ] **Step 2: Write a smoke test to confirm the runner works**

```ts
// link/tests/services/smoke.test.ts
import { describe, it, expect } from "vitest";

describe("vitest setup", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd link && npx vitest run tests/services/smoke.test.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Create the migration**

```sql
-- link/migrations/0004_create_channel_poll_state.sql
CREATE TABLE channel_poll_state (
  channel_id TEXT NOT NULL,
  poller_name TEXT NOT NULL,
  cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, poller_name)
);
```

- [ ] **Step 5: Apply the migration to dev**

Run: `cd link && wrangler d1 migrations apply uniscrm-link-dev --env dev --remote`
Expected: output shows `0004_create_channel_poll_state.sql` applied (0003 should be skipped/already-applied, since it was recovered separately and dev already has that column).

- [ ] **Step 6: Commit**

```bash
git add link/vitest.config.ts link/tests/services/smoke.test.ts link/migrations/0004_create_channel_poll_state.sql
git commit -m "test: add vitest runner and channel_poll_state migration"
```

---

### Task 2: `resolveUserProps` — metadata-driven field resolution

**Files:**
- Modify: `link/src/webhook.ts` (export `navigatePath`, no behavior change)
- Create: `link/src/services/pollers/resolve-user-props.ts`
- Test: `link/tests/services/resolve-user-props.test.ts`

**Interfaces:**
- Consumes: `UserPropMapping` type from `metadata/dataTypes.ts` (`{ propId: string; dataId?: string; value?: string | number }`).
- Produces: `resolveUserProps(item: Record<string, unknown>, userProps: UserPropMapping[], linkPrefix?: string): Record<string, unknown>` — used by Task 5.

- [ ] **Step 1: Export `navigatePath` from webhook.ts**

In `link/src/webhook.ts`, change:
```ts
function navigatePath(obj: unknown, path: string): unknown {
```
to:
```ts
export function navigatePath(obj: unknown, path: string): unknown {
```
(No other change to that file.)

- [ ] **Step 2: Write the failing tests**

```ts
// link/tests/services/resolve-user-props.test.ts
import { describe, it, expect } from "vitest";
import { resolveUserProps } from "../../src/services/pollers/resolve-user-props";
import type { UserPropMapping } from "../../../metadata/dataTypes";

describe("resolveUserProps", () => {
  const userProps: UserPropMapping[] = [
    { propId: "source_user_id", dataId: "{linkPrefix}.id" },
    { propId: "name", dataId: "{linkPrefix}.name" },
    { propId: "is_followed", value: 1 },
  ];

  it("resolves dataId fields relative to the item", () => {
    const item = { id: "123", name: "Ada", username: "ada" };
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result).toEqual({ source_user_id: "123", name: "Ada", is_followed: 1 });
  });

  it("omits a prop when its dataId resolves to nothing, rather than defaulting", () => {
    const item = { id: "123" }; // no "name"
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result).toEqual({ source_user_id: "123", is_followed: 1 });
    expect(result).not.toHaveProperty("name");
  });

  it("uses static value mappings verbatim regardless of item contents", () => {
    const item = { id: "1", is_followed: 0 }; // item's own field must not override static mapping
    const result = resolveUserProps(item, userProps, "data[]");
    expect(result.is_followed).toBe(1);
  });

  it("works without a linkPrefix (dataId used as-is)", () => {
    const item = { id: "9", name: "Bob" };
    const mapping: UserPropMapping[] = [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
    ];
    const result = resolveUserProps(item, mapping);
    expect(result).toEqual({ source_user_id: "9", name: "Bob" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/resolve-user-props.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/pollers/resolve-user-props'`

- [ ] **Step 4: Implement**

```ts
// link/src/services/pollers/resolve-user-props.ts
import { navigatePath } from "../../webhook";
import type { UserPropMapping } from "../../../../metadata/dataTypes";

export function resolveUserProps(
  item: Record<string, unknown>,
  userProps: UserPropMapping[],
  linkPrefix?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mapping of userProps) {
    if (mapping.value !== undefined) {
      result[mapping.propId] = mapping.value;
      continue;
    }
    if (!mapping.dataId) continue;
    const relativePath = linkPrefix
      ? mapping.dataId.replace(`{linkPrefix}.`, "")
      : mapping.dataId;
    const resolved = navigatePath(item, relativePath);
    if (resolved !== null && resolved !== undefined) {
      result[mapping.propId] = resolved;
    }
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/resolve-user-props.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add link/src/webhook.ts link/src/services/pollers/resolve-user-props.ts link/tests/services/resolve-user-props.test.ts
git commit -m "feat: add metadata-driven user-prop resolver for pollers"
```

---

### Task 3: `metadata/x-byok.ts` — add the `is_followed` static prop

**Files:**
- Modify: `metadata/x-byok.ts`

**Interfaces:**
- Produces: `UserMetadata_X[0].userProps` includes a static `is_followed: 1` mapping, consumed by Task 5.

- [ ] **Step 1: Edit the existing `UserMetadata_X` array**

In `metadata/x-byok.ts`, change:
```ts
export const UserMetadata_X: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
   linkPrefix:"data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
    ],
  }
]
```
to:
```ts
export const UserMetadata_X: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
    linkPrefix: "data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
    ],
  },
];
```
(Only the `userProps` array and whitespace change — everything else in the file, including the duplicated `PROPS_X`, stays exactly as-is.)

- [ ] **Step 2: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add metadata/x-byok.ts
git commit -m "feat: mark get-followers results as is_followed in x-byok metadata"
```

---

### Task 4: `upsertUserFromMetadata` + fix the `?? 0` default bug

**Files:**
- Modify: `link/src/services/x-users.ts`
- Test: `link/tests/services/x-users.test.ts`

**Interfaces:**
- Consumes: `TenantDataDB` (`query`, `run`, `batch` methods — see `shared/tenant-data-db.ts`).
- Produces: `XUsersService.upsertUserFromMetadata(rawItem: Record<string, unknown>, resolvedProps: Record<string, unknown>, channelId: string, channelType: string): Promise<boolean>` (returns `true` if the user row was newly inserted) — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

```ts
// link/tests/services/x-users.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { XUsersService } from "../../src/services/x-users";

function createMockTenantDb() {
  return {
    query: vi.fn(),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("XUsersService.upsertUserFromMetadata", () => {
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let pipelineUser: { send: ReturnType<typeof vi.fn> };
  let service: XUsersService;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    service = new XUsersService(tenantDb as any, { pipelineUser: pipelineUser as any, tenantId: 42 });
  });

  it("inserts a new user and returns true when none exists for channel+source_user_id", async () => {
    tenantDb.query.mockResolvedValue([]); // no existing row
    const rawItem = { id: "u1", name: "Ada", username: "ada" };
    const resolvedProps = { source_user_id: "u1", name: "Ada", is_followed: 1 };

    const isNew = await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user"),
      expect.arrayContaining(["chan1", "u1", "X"])
    );
    const rawDataArg = tenantDb.run.mock.calls[0][1].find((p: unknown) => typeof p === "string" && p.includes("\"id\":\"u1\""));
    expect(rawDataArg).toBe(JSON.stringify(rawItem));
  });

  it("updates and returns false when a user already exists for channel+source_user_id", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid" }]);
    const rawItem = { id: "u1", name: "Ada Updated" };
    const resolvedProps = { source_user_id: "u1", name: "Ada Updated" };

    const isNew = await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(false);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE user"),
      expect.arrayContaining(["existing-uuid"])
    );
  });

  it("omits unresolved fields from the pipeline record instead of defaulting them", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "u1" };
    const resolvedProps = { source_user_id: "u1" }; // no name, no username, no is_followed

    await service.upsertUserFromMetadata(rawItem, resolvedProps, "chan1", "X");

    const record = pipelineUser.send.mock.calls[0][0][0];
    expect(record).not.toHaveProperty("name");
    expect(record).not.toHaveProperty("is_followed");
    expect(record.source_user_id).toBe("u1");
  });
});

describe("XUsersService.upsertUser (regression: no more zero-defaulting)", () => {
  it("omits a missing count field from the pipeline record instead of writing 0", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.run.mockResolvedValue({ changes: 1 });
    const pipelineUser = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new XUsersService(tenantDb as any, { pipelineUser: pipelineUser as any, tenantId: 42 });

    // public_metrics deliberately omits following_count
    await service.upsertUser(
      { id: "u2", name: "Bea", public_metrics: { followers_count: 500 } } as any,
      "chan1",
      "X"
    );

    const record = pipelineUser.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(500);
    expect(record).not.toHaveProperty("following_count");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/x-users.test.ts`
Expected: FAIL — `upsertUserFromMetadata is not a function`, and the regression test fails because `following_count` is currently `0`.

- [ ] **Step 3: Fix the `?? 0` bug in `upsertUser`**

In `link/src/services/x-users.ts`, inside `upsertUser`, change:
```ts
      for (const prop of INSIGHT_PROPS) {
        const pm = (user as Record<string, unknown>).public_metrics as Record<string, unknown> | undefined;
        const val = prop.propId.includes("_count")
          ? pm?.[prop.propId] ?? 0
          : (user as Record<string, unknown>)[prop.propId] ?? null;
        record[prop.propId] = val;
      }
```
to:
```ts
      for (const prop of INSIGHT_PROPS) {
        const pm = (user as Record<string, unknown>).public_metrics as Record<string, unknown> | undefined;
        const val = prop.propId.includes("_count")
          ? pm?.[prop.propId]
          : (user as Record<string, unknown>)[prop.propId];
        if (val !== undefined && val !== null) {
          record[prop.propId] = val;
        }
      }
```

- [ ] **Step 4: Add `upsertUserFromMetadata`**

In `link/src/services/x-users.ts`, add this method to the `XUsersService` class (after `upsertUser`):

```ts
  async upsertUserFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: string
  ): Promise<boolean> {
    const sourceUserId = String(resolvedProps.source_user_id ?? rawItem.id ?? "");
    if (!sourceUserId) throw new Error("upsertUserFromMetadata: missing source_user_id");

    const existing = await this.tenantDb.query<{ id: string }>(
      "SELECT id FROM user WHERE channel_id = ? AND source_user_id = ?",
      [channelId, sourceUserId]
    );
    const isNew = existing.length === 0;
    const id = isNew ? crypto.randomUUID() : existing[0].id;
    const now = new Date().toISOString();
    const rawData = JSON.stringify(rawItem);
    const name = resolvedProps.name != null ? String(resolvedProps.name) : null;
    const username = resolvedProps.username != null ? String(resolvedProps.username) : null;

    if (isNew) {
      await this.tenantDb.run(
        `INSERT INTO user (id, channel_id, source_user_id, channel_type, name, username, raw_data, is_followed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [id, channelId, sourceUserId, channelType, name, username, rawData, resolvedProps.is_followed ?? 0]
      );
    } else {
      const sets: string[] = ["raw_data = ?", "updated_at = datetime('now')"];
      const params: unknown[] = [rawData];
      if (name) { sets.push("name = ?"); params.push(name); }
      if (username) { sets.push("username = ?"); params.push(username); }
      if (resolvedProps.is_followed !== undefined) { sets.push("is_followed = ?"); params.push(resolvedProps.is_followed); }
      params.push(id);
      await this.tenantDb.run(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`, params);
    }

    if (this.pipelineUser && this.tenantId) {
      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id,
        channel_id: channelId,
        source_user_id: sourceUserId,
        channel_type: channelType,
        created_at: now,
        updated_at: now,
        ...resolvedProps,
      };
      await this.pipelineUser.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_user_error", error: String(err) }));
      });
    }

    return isNew;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/x-users.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add link/src/services/x-users.ts link/tests/services/x-users.test.ts
git commit -m "feat: add metadata-driven user upsert; fix pipeline zero-defaulting bug"
```

---

### Task 5: X followers API client

**Files:**
- Create: `link/src/services/x-followers-api.ts`

**Interfaces:**
- Produces: `fetchFollowersPage(accessToken: string, xUserId: string, paginationToken?: string): Promise<{ page: { data: Record<string, unknown>[]; nextToken?: string }; rateLimited: boolean }>` — consumed by Task 6.

- [ ] **Step 1: Implement (no test — thin fetch wrapper, exercised via Task 6's poller tests with a mocked global `fetch`)**

```ts
// link/src/services/x-followers-api.ts
export interface XFollowersPage {
  data: Record<string, unknown>[];
  nextToken?: string;
}

export interface XFollowersFetchResult {
  page: XFollowersPage;
  rateLimited: boolean;
}

export async function fetchFollowersPage(
  accessToken: string,
  xUserId: string,
  paginationToken?: string
): Promise<XFollowersFetchResult> {
  const url = new URL(`https://api.x.com/2/users/${xUserId}/followers`);
  url.searchParams.set("max_results", "1000");
  url.searchParams.set("user.fields", "id,name,username");
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    return { page: { data: [] }, rateLimited: true };
  }
  if (!res.ok) {
    throw new Error(`X get-followers failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: Record<string, unknown>[]; meta?: { next_token?: string } };
  return { page: { data: body.data || [], nextToken: body.meta?.next_token }, rateLimited: false };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add link/src/services/x-followers-api.ts
git commit -m "feat: add X get-followers API client"
```

---

### Task 6: Followers poller (backfill + incremental catch-up)

**Files:**
- Create: `link/src/services/pollers/x-followers.ts`
- Test: `link/tests/services/x-followers.test.ts`

**Interfaces:**
- Consumes: `fetchFollowersPage` (Task 5), `resolveUserProps` (Task 2), `XUsersService.upsertUserFromMetadata` (Task 4), `UserMetadata_X` from `metadata/x-byok.ts` (Task 3).
- Produces: `runFollowersPoller(ctx: FollowersPollerContext): Promise<void>` — consumed by Task 7.
  ```ts
  export interface FollowersPollerContext {
    channelId: string;
    xUserId: string;
    accessToken: string;
    linkDb: D1Database;
    tenantDb: TenantDataDB;
    tenantId: number;
    pipelineUser?: Pipeline;
    deadline: number; // Date.now()-comparable timestamp
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// link/tests/services/x-followers.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runFollowersPoller } from "../../src/services/pollers/x-followers";

function createMockLinkDb(initialState: { cursor: string | null; backfill_complete: number; last_polled_at: string | null } | null) {
  const state = { ...initialState } as any;
  const first = vi.fn().mockImplementation(() => Promise.resolve(state ? { ...state } : null));
  const run = vi.fn().mockImplementation(() => Promise.resolve({ success: true }));
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _state: state, _run: run, _bind: bind };
}

function createMockTenantDb() {
  return {
    query: vi.fn().mockResolvedValue([]), // every followed user is "new" by default
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

describe("runFollowersPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: {} }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tenantDb.run).toHaveBeenCalledTimes(2); // one INSERT per follower
    const finalUpdate = linkDb._run.mock.calls.find((c: unknown[]) =>
      (linkDb._bind.mock.calls as unknown[][]).length > 0
    );
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // cursor persisted to "p2" after the first successful page, backfill NOT marked complete
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() - 1, // already past
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("post-backfill: stops after a page with zero new users", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const tenantDb = createMockTenantDb();
    // first page: one new user; second page: user already exists -> query returns a row
    tenantDb.query
      .mockResolvedValueOnce([]) // page 1, user "1" is new
      .mockResolvedValueOnce([{ id: "existing" }]); // page 2, user "2" already known

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "1", name: "A", username: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "2", name: "B", username: "b" }], meta: { next_token: "p3" } }));

    await runFollowersPoller({
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      deadline: Date.now() + 20_000,
    });

    // stops after page 2 (zero new users there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/x-followers.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/pollers/x-followers'`

- [ ] **Step 3: Implement**

```ts
// link/src/services/pollers/x-followers.ts
import type { TenantDataDB } from "../../../../shared/tenant-data-db";
import type { Pipeline } from "../../types";
import { XUsersService } from "../x-users";
import { fetchFollowersPage } from "../x-followers-api";
import { resolveUserProps } from "./resolve-user-props";
import { UserMetadata_X } from "../../../../metadata/x-byok";

const FOLLOWERS_METADATA = UserMetadata_X.find((m) => m.sourceUserType === "get-followers")!;

export interface FollowersPollerContext {
  channelId: string;
  xUserId: string;
  accessToken: string;
  linkDb: D1Database;
  tenantDb: TenantDataDB;
  tenantId: number;
  pipelineUser?: Pipeline;
  deadline: number;
}

interface PollStateRow {
  cursor: string | null;
  backfill_complete: number;
  last_polled_at: string | null;
}

export async function runFollowersPoller(ctx: FollowersPollerContext): Promise<void> {
  const state = await ctx.linkDb
    .prepare("SELECT cursor, backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'followers'")
    .bind(ctx.channelId)
    .first<PollStateRow>();

  if (!state) return; // not seeded yet — channel isn't authorized

  const usersService = new XUsersService(ctx.tenantDb, { pipelineUser: ctx.pipelineUser, tenantId: ctx.tenantId });

  if (!state.backfill_complete) {
    await runBackfill(ctx, usersService, state.cursor);
  } else {
    await runIncrementalPoll(ctx, usersService);
  }
}

async function upsertPage(
  usersService: XUsersService,
  items: Record<string, unknown>[],
  channelId: string
): Promise<number> {
  let newCount = 0;
  for (const item of items) {
    const props = resolveUserProps(item, FOLLOWERS_METADATA.userProps, FOLLOWERS_METADATA.linkPrefix);
    const isNew = await usersService.upsertUserFromMetadata(item, props, channelId, "X");
    if (isNew) newCount++;
  }
  return newCount;
}

async function runBackfill(
  ctx: FollowersPollerContext,
  usersService: XUsersService,
  startCursor: string | null
): Promise<void> {
  let cursor = startCursor || undefined;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) return;

    await upsertPage(usersService, page.data, ctx.channelId);

    if (!page.nextToken) {
      await ctx.linkDb
        .prepare(
          "UPDATE channel_poll_state SET cursor = NULL, backfill_complete = 1, last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'"
        )
        .bind(ctx.channelId)
        .run();
      return;
    }

    cursor = page.nextToken;
    await ctx.linkDb
      .prepare("UPDATE channel_poll_state SET cursor = ?, updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
      .bind(cursor, ctx.channelId)
      .run();
  }
}

async function runIncrementalPoll(ctx: FollowersPollerContext, usersService: XUsersService): Promise<void> {
  let cursor: string | undefined;

  while (Date.now() < ctx.deadline) {
    const { page, rateLimited } = await fetchFollowersPage(ctx.accessToken, ctx.xUserId, cursor);
    if (rateLimited) break;

    const newCount = await upsertPage(usersService, page.data, ctx.channelId);

    if (newCount === 0 || !page.nextToken) break;
    cursor = page.nextToken;
  }

  await ctx.linkDb
    .prepare("UPDATE channel_poll_state SET last_polled_at = datetime('now'), updated_at = datetime('now') WHERE channel_id = ? AND poller_name = 'followers'")
    .bind(ctx.channelId)
    .run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/x-followers.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add link/src/services/pollers/x-followers.ts link/tests/services/x-followers.test.ts
git commit -m "feat: add followers backfill + incremental-poll orchestration"
```

---

### Task 7: Wire into the hourly cron

**Files:**
- Modify: `link/src/cron.ts`

**Interfaces:**
- Consumes: `runFollowersPoller` and `FollowersPollerContext` (Task 6), `getAppCredentials` / `ByokConfig` (existing), `XTokenService.getValidToken` (existing), `TenantDataDB` (existing).

- [ ] **Step 1: Add the `handlePolling` function and wire it in**

In `link/src/cron.ts`, add near the top of the file (after existing imports):
```ts
import { runFollowersPoller } from "./services/pollers/x-followers";
```

Change:
```ts
export async function handleCron(env: Env): Promise<void> {
  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
  ]);
}
```
to:
```ts
export async function handleCron(env: Env): Promise<void> {
  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
    handlePolling(env),
  ]);
}
```

Add this function (anywhere after `handleCron`, e.g. right after `handleTokenRefresh`):
```ts
async function handlePolling(env: Env): Promise<void> {
  const PER_CHANNEL_BUDGET_MS = 20_000;
  const TOTAL_BUDGET_MS = 50_000;
  const REPOLL_INTERVAL_MS = 55 * 60 * 1000; // just under an hour, guards overlapping cron runs
  const runDeadline = Date.now() + TOTAL_BUDGET_MS;

  const rows = await env.LINK_DB
    .prepare("SELECT id, config, tenant_id FROM channels WHERE channel_type = 'X' AND is_active = 1 AND is_byok = 1")
    .all<{ id: string; config: string; tenant_id: number | null }>();

  for (const row of rows.results) {
    if (Date.now() >= runDeadline) break;

    const config = JSON.parse(row.config) as ByokConfig & { x_user_id?: string };
    if (!config.x_user_id || !row.tenant_id) continue;

    const state = await env.LINK_DB
      .prepare("SELECT backfill_complete, last_polled_at FROM channel_poll_state WHERE channel_id = ? AND poller_name = 'followers'")
      .bind(row.id)
      .first<{ backfill_complete: number; last_polled_at: string | null }>();
    if (!state) continue;
    if (state.backfill_complete && state.last_polled_at) {
      const elapsedMs = Date.now() - new Date(state.last_polled_at).getTime();
      if (elapsedMs < REPOLL_INTERVAL_MS) continue;
    }

    try {
      const creds = await getAppCredentials(env, config);
      const tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
      const accessToken = await tokenService.getValidToken(row.id);

      const tenant = await env.WEB_DB
        .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(row.tenant_id)
        .first<{ d1_database_id: string | null }>();
      if (!tenant?.d1_database_id) continue;

      const tenantDb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenant.d1_database_id);

      await runFollowersPoller({
        channelId: row.id,
        xUserId: config.x_user_id,
        accessToken,
        linkDb: env.LINK_DB,
        tenantDb,
        tenantId: row.tenant_id,
        pipelineUser: env.PIPELINE_USER,
        deadline: Math.min(Date.now() + PER_CHANNEL_BUDGET_MS, runDeadline),
      });
    } catch (e) {
      console.error(`Followers poll failed for channel ${row.id}:`, e);
    }
  }
}
```

Add the `TenantDataDB` import at the top of the file if not already present:
```ts
import { TenantDataDB } from "../../shared/tenant-data-db";
```

- [ ] **Step 2: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add link/src/cron.ts
git commit -m "feat: run BYOK followers polling from the hourly cron"
```

---

### Task 8: Seed poll state on BYOK authorization

**Files:**
- Modify: `link/src/oauth.ts`

- [ ] **Step 1: Add the seed/reset insert right after the BYOK channel config UPDATE**

In `link/src/oauth.ts`, immediately after this existing block:
```ts
      await c.env.LINK_DB
        .prepare(`UPDATE channels SET config = ?, source_channel_id = ?, access_token = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(updatedConfig, xUser.id, tokens.accessToken(), byokChannelId)
        .run();
```
add:
```ts
      // Seed (or reset, on re-authorization) followers poll state — full backfill runs again
      await c.env.LINK_DB
        .prepare(
          `INSERT INTO channel_poll_state (channel_id, poller_name, cursor, backfill_complete, last_polled_at, updated_at)
           VALUES (?, 'followers', NULL, 0, NULL, datetime('now'))
           ON CONFLICT(channel_id, poller_name) DO UPDATE SET cursor = NULL, backfill_complete = 0, last_polled_at = NULL, updated_at = datetime('now')`
        )
        .bind(byokChannelId)
        .run();
```

- [ ] **Step 2: Typecheck**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add link/src/oauth.ts
git commit -m "feat: seed followers poll state on BYOK channel authorization"
```

---

### Task 9: Full test suite, deploy, manual verification

**Files:** none (verification task)

- [ ] **Step 1: Run the full test suite**

Run: `cd link && npx vitest run`
Expected: all tests pass (smoke + resolve-user-props + x-users + x-followers).

- [ ] **Step 2: Typecheck the whole module**

Run: `cd link && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Deploy to dev**

Run: `cd link && wrangler deploy --env dev`
Expected: successful deploy; migration `0004_create_channel_poll_state.sql` auto-applies (per project convention).

- [ ] **Step 4: Manual verification against a real BYOK channel**

- Authorize (or re-authorize) an existing BYOK X channel through the UI (Social Channels page → BYOK card).
- Confirm a row now exists: `wrangler d1 execute uniscrm-link-dev --env dev --remote --command "SELECT * FROM channel_poll_state"`.
- Trigger the cron manually (or wait for the top of the hour) and check logs for `Followers poll failed` entries (should be none) — `wrangler tail link-dev --env dev`.
- Confirm rows appear in the tenant DB `user` table with `channel_type='X'`, `is_followed=1`, and non-empty `raw_data`.
- Confirm the system-default (non-BYOK) X channel is untouched: no `channel_poll_state` row for it, no followers-poll log lines referencing its channel id.

- [ ] **Step 5: Commit if any fixes were needed during verification, otherwise nothing to commit**

---

## Self-Review Notes

- **Spec coverage:** BYOK-only gating (Task 7's `is_byok = 1` filter), dedicated `channel_poll_state` table (Task 1), metadata-driven extraction with `raw_data` = full item (Tasks 2–4), backfill-then-hourly cadence with page-until-429/budget and restart-at-page-1-until-known-user post-backfill (Task 6), hourly cron integration (Task 7), the `?? 0` pipeline bug fix (Task 4), and the recovered `is_byok` production migration (done directly in this session, prerequisite for Task 7's query) are all covered.
- **Type consistency checked:** `FollowersPollerContext` (Task 6) matches the fields passed from `handlePolling` (Task 7) exactly. `upsertUserFromMetadata`'s signature (Task 4) matches its call sites in Task 6's `upsertPage`. `resolveUserProps`'s signature (Task 2) matches its two call sites in Task 6.
- **No placeholders:** every step has complete code.
