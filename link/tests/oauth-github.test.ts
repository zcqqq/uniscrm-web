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

function fakeDb() {
  const runs: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() { runs.push({ sql, binds }); return { success: true }; },
            async first() { return sql.includes("SELECT id FROM channels") ? { id: "chan-existing" } : null; },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runs };
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

  it("state 不存在直接 400，不换 token", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { db } = fakeDb();
    const res = await app(db)("/api/auth/github/callback?code=c1&state=nope");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
