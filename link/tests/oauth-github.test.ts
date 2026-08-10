import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// oauth.ts's local resolveSession() wrapper calls shared/auth's `resolveSession` (imported
// there as `resolveSharedSession`) and reshapes its camelCase SharedSession into the
// snake_case { tenant_id, member_id } shape this file's routes use. Mock that real export
// name — not a `resolveSessionFromCookie` that doesn't exist on the module — so the KV/D1
// behaviours under test never depend on cookie parsing or a live WEB_DB.
const sessionMock = vi.fn();
vi.mock("../../shared/auth", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  resolveSession: (...args: unknown[]) => sessionMock(...args),
}));

import { oauthRoutes } from "../src/oauth";

const KV = { store: new Map<string, string>(), async put(k: string, v: string) { this.store.set(k, v); }, async get(k: string) { return this.store.get(k) ?? null; }, async delete(k: string) { this.store.delete(k); } };

function app(db: D1Database) {
  const a = new Hono();
  a.route("/api/auth", oauthRoutes());
  return (path: string) => a.request(`https://link-dev.uni-scrm.com${path}`, {}, {
    LINK_DB: db, KV, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec",
  } as never);
}

/**
 * `existingGitHubOwner` 是跨租户接管那道闸门的输入：GitHub 回调在 upsert 之前会按
 * (channel_type='GITHUB', source_channel_id) 查一次仍然 active 的行，读它的 tenant_id。
 * null = 这个 GitHub 账号还没人连过。
 */
function fakeDb(existingGitHubOwner: { tenant_id: number | null } | null = null) {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() { runs.push({ sql, binds }); return { success: true }; },
            async first() {
              if (sql.includes("SELECT tenant_id FROM channels") && sql.includes("'GITHUB'")) return existingGitHubOwner;
              return sql.includes("SELECT id FROM channels") ? { id: "chan-existing" } : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runs };
}

function stubGitHubOAuthFetch() {
  vi.stubGlobal("fetch", vi.fn((url: string) =>
    Promise.resolve(url.includes("login/oauth/access_token")
      ? new Response(JSON.stringify({ access_token: "gho_x", token_type: "bearer" }), { status: 200 })
      : new Response(JSON.stringify({ id: 4242, login: "zc", name: "ZC", avatar_url: "https://a/x.png" }), { status: 200 }))
  ));
}

// SharedSession shape (shared/auth.ts) is camelCase; oauth.ts's resolveSession() wrapper
// converts it to the snake_case { tenant_id, member_id } the routes below read.
beforeEach(() => { KV.store.clear(); sessionMock.mockReset().mockResolvedValue({ tenantId: 7, memberId: "m1", email: "z@example.com", language: "en" }); });
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/auth/github/connect", () => {
  it("未登录直接 401，不把用户送进 GitHub 授权页", async () => {
    // 这个流程只会把 channel 挂到已存在的租户上，没有「顺便注册」的分支。
    // 不在这里拦，用户会走完整个授权流程最后落在一张 401 JSON 上，什么都没连上。
    sessionMock.mockResolvedValue(null);
    const { db } = fakeDb();
    const res = await app(db)("/api/auth/github/connect");
    expect(res.status).toBe(401);
  });

  it("登录后 302 到 GitHub，state 存进 KV", async () => {
    const { db } = fakeDb();
    const res = await app(db)("/api/auth/github/connect");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.host).toBe("github.com");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://link-dev.uni-scrm.com/api/auth/github/callback");
    const state = loc.searchParams.get("state")!;
    expect(JSON.parse(KV.store.get(`oauth_state:${state}`)!)).toMatchObject({ tenantId: "7", provider: "github" });
  });
});

describe("GET /api/auth/github/callback", () => {
  it("换 token、取用户、写 channels 行", async () => {
    KV.store.set("oauth_state:s1", JSON.stringify({ tenantId: "7", memberId: "m1", provider: "github" }));
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve(url.includes("login/oauth/access_token")
        ? new Response(JSON.stringify({ access_token: "gho_x", token_type: "bearer" }), { status: 200 })
        : new Response(JSON.stringify({ id: 4242, login: "zc", name: "ZC", avatar_url: "https://a/x.png" }), { status: 200 }))
    ));

    const { db, runs } = fakeDb();
    const res = await app(db)("/api/auth/github/callback?code=c1&state=s1");

    expect(res.status).toBe(302);
    const insert = runs.find((r) => r.sql.includes("INSERT INTO channels"))!;
    expect(insert.sql).toContain("'GITHUB'");
    expect(insert.binds).toContain("4242");                 // source_channel_id
    expect(JSON.parse(insert.binds[1] as string)).toMatchObject({ login: "zc", access_token: "gho_x" });
    expect(KV.store.has("oauth_state:s1")).toBe(false);      // state 一次性
  });

  it("重连时清掉 deactivated_reason —— 健康 channel 上不该挂着上次 401 的旧原因", async () => {
    KV.store.set("oauth_state:s1", JSON.stringify({ tenantId: "7", memberId: "m1", provider: "github" }));
    stubGitHubOAuthFetch();

    const { db, runs } = fakeDb({ tenant_id: 7 });   // 同一个租户重连
    const res = await app(db)("/api/auth/github/callback?code=c1&state=s1");

    expect(res.status).toBe(302);
    const insert = runs.find((r) => r.sql.includes("INSERT INTO channels"))!;
    expect(insert.sql).toContain("deactivated_reason = NULL");
  });

  it("同一个 GitHub 账号被别的租户连着时拒绝，且一行都不写", async () => {
    // 这是 release 洪水的入口：ON CONFLICT(channel_type, source_channel_id) 会把 tenant_id
    // 改写成新租户，而 channel_poll_state 按 (channel_id, poller_name) 存、仍然
    // backfill_complete=1，dedup 用的 entity_state 却是**按 tenant_id** 存、对新租户是空的
    // —— 下一次 cron 会把最新一页上的一百条 release 全当新的发出去（真的公开发帖、真的
    // 给真人发私信），同时原租户的 flow 直接变哑。
    KV.store.set("oauth_state:s1", JSON.stringify({ tenantId: "7", memberId: "m1", provider: "github" }));
    stubGitHubOAuthFetch();

    const { db, runs } = fakeDb({ tenant_id: 99 });  // 已被租户 99 连着
    const res = await app(db)("/api/auth/github/callback?code=c1&state=s1");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("already connected by another workspace");
    expect(body.error).toContain("已被另一个工作区连接");   // 用户可见文案必须中英双语
    expect(runs.some((r) => r.sql.includes("INSERT INTO channels"))).toBe(false);
  });

  it("state 不存在直接 400，不换 token", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { db } = fakeDb();
    const res = await app(db)("/api/auth/github/callback?code=c1&state=nope");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
