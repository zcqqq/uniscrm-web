import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";
import * as password from "../../worker/services/password";

const MEMBER = {
  id: "m1",
  tenant_id: 7,
  email: "a@example.com",
  preferred_location: "global",
  language: "en",
  timezone: "Asia/Shanghai",
  password_hash: "pbkdf2$sha256$600000$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ==",
};

function makeApp(memberRow: any, kvStore: Map<string, string>, envOverrides: Record<string, unknown> = {}) {
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (sql.includes("FROM members WHERE email") ? memberRow : null)),
        run: vi.fn(async () => ({})),
      })),
    })),
  };
  const kv = {
    get: async (k: string) => (kvStore.has(k) ? kvStore.get(k)! : null),
    put: async (k: string, v: string) => { kvStore.set(k, v); },
    delete: async (k: string) => { kvStore.delete(k); },
  };
  const app = new Hono();
  app.use("/*", (c, next) => {
    (c.env as any) = { WEB_DB: db, KV: kv, WEB_URL: "https://app.example.com", ...envOverrides };
    return next();
  });
  app.route("/auth", createAuthRouter());
  return { app, db };
}

function post(app: Hono, body: object, headers: Record<string, string> = {}) {
  return app.request(
    "/auth/password-login",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    undefined,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  );
}

describe("POST /auth/password-login", () => {
  let kvStore: Map<string, string>;

  beforeEach(() => { kvStore = new Map(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("密码正确时建立 session 并返回 member 与 tenant", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    const { app } = makeApp(MEMBER, kvStore);

    const res = await post(app, { email: "a@example.com", password: "hunter22222" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.member.id).toBe("m1");
    expect(body.tenant.id).toBe(7);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("session=") && !c.includes("Max-Age=0"))).toBe(true);
  });

  // members.email 存的是 normalizeEmail 之后的规范形式（全小写、去空格）。这个用例锁住的是
  // Finding 1 的回归：提交邮箱的大小写不能决定 SELECT 能不能查到人。
  it("stored email 是小写、提交邮箱大小写不同时依然能查到并登录成功", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    const statements: { sql: string; args: any[] }[] = [];
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          statements.push({ sql, args });
          return {
            first: vi.fn(async () => (sql.includes("FROM members WHERE email") ? MEMBER : null)),
            run: vi.fn(async () => ({})),
          };
        }),
      })),
    };
    const kv = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    };
    const app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { WEB_DB: db, KV: kv, WEB_URL: "https://app.example.com" };
      return next();
    });
    app.route("/auth", createAuthRouter());

    const res = await post(app, { email: "  A@Example.COM  ", password: "hunter22222" });

    expect(res.status).toBe(200);
    const memberSelect = statements.find((s) => s.sql.includes("FROM members WHERE email"));
    expect(memberSelect!.args).toEqual(["a@example.com"]);
  });

  it("密码错误时返回 401 与统一提示", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    const res = await post(app, { email: "a@example.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  // 下面三个用例是同一件事的三个面：这条路由不能变成邮箱枚举器
  it("邮箱不存在时返回与密码错误完全一致的响应", async () => {
    const { app } = makeApp(null, kvStore);

    const res = await post(app, { email: "nobody@example.com", password: "whatever12" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  it("member 存在但从没设过密码时同样返回统一响应", async () => {
    const { app } = makeApp({ ...MEMBER, password_hash: null }, kvStore);

    const res = await post(app, { email: "a@example.com", password: "whatever12" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  // 用 spy 断言哈希确实被算了，而不是断言响应耗时——耗时断言必然不稳定
  it("邮箱不存在时依然烧掉一次哈希的 CPU", async () => {
    const dummy = vi.spyOn(password, "dummyVerify");
    const { app } = makeApp(null, kvStore);

    await post(app, { email: "nobody@example.com", password: "whatever12" });

    expect(dummy).toHaveBeenCalledTimes(1);
  });

  it("连续失败达阈值后直接 429，且不再比对哈希", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    for (let i = 0; i < 5; i++) await post(app, { email: "a@example.com", password: "wrongpassword" });
    verify.mockClear();

    const res = await post(app, { email: "a@example.com", password: "wrongpassword" });

    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });

  it("邮箱不存在时也计入失败次数，达到阈值后同样 429", async () => {
    const { app } = makeApp(null, kvStore);

    for (let i = 0; i < 5; i++) {
      await post(app, { email: "nobody@example.com", password: "whatever12" });
    }
    expect(kvStore.get("login_fail:nobody@example.com")).toBe("5");

    const res = await post(app, { email: "nobody@example.com", password: "whatever12" });

    expect(res.status).toBe(429);
  });

  it("成功登录后失败计数清零", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    for (let i = 0; i < 3; i++) await post(app, { email: "a@example.com", password: "wrongpassword" });
    expect(kvStore.get("login_fail:a@example.com")).toBe("3");

    verify.mockResolvedValue(true);
    await post(app, { email: "a@example.com", password: "hunter22222" });

    expect(kvStore.has("login_fail:a@example.com")).toBe(false);
  });

  it("缺 email 或 password 时返回 400", async () => {
    const { app } = makeApp(MEMBER, kvStore);
    expect((await post(app, { email: "a@example.com" })).status).toBe(400);
    expect((await post(app, { password: "hunter22222" })).status).toBe(400);
  });

  it("请求体缺失时返回 400 而不是 500", async () => {
    const { app } = makeApp(MEMBER, kvStore);

    const res = await app.request(
      "/auth/password-login",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      undefined,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    );

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("Email and password are required");
  });

  it("请求体不是合法 JSON 时返回 400 而不是 500", async () => {
    const { app } = makeApp(MEMBER, kvStore);

    const res = await app.request(
      "/auth/password-login",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid json" },
      undefined,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    );

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("Email and password are required");
  });

  it("email 或 password 不是字符串时返回 400 而不是 500", async () => {
    const { app } = makeApp(MEMBER, kvStore);

    const res = await post(app, { email: { $ne: null }, password: [] });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("Email and password are required");
  });

  it("哈希参数低于当前标准时登录成功后就地重算回写", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3c2FsdG5ld3NhbHQ=$bmV3aGFzaG5ld2hhc2g=");
    const { app, db } = makeApp({ ...MEMBER, password_hash: "scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ==" }, kvStore);

    await post(app, { email: "a@example.com", password: "hunter22222" });

    const updates = db.prepare.mock.calls.map((c: any[]) => c[0]).filter((s: string) => s.startsWith("UPDATE members SET password_hash"));
    expect(updates).toHaveLength(1);
  });

  it("重算哈希写入失败时登录依然成功，返回 200 与 session cookie", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3c2FsdG5ld3NhbHQ=$bmV3aGFzaG5ld2hhc2g=");

    const memberRow = { ...MEMBER, password_hash: "scrypt$1024$8$1$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ==" };
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => (sql.includes("FROM members WHERE email") ? memberRow : null)),
          run: vi.fn(async () => {
            if (sql.startsWith("UPDATE members SET password_hash")) {
              throw new Error("simulated D1 write failure");
            }
            return {};
          }),
        })),
      })),
    };
    const kv = {
      get: async (k: string) => (kvStore.has(k) ? kvStore.get(k)! : null),
      put: async (k: string, v: string) => { kvStore.set(k, v); },
      delete: async (k: string) => { kvStore.delete(k); },
    };
    const app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { WEB_DB: db, KV: kv, WEB_URL: "https://app.example.com" };
      return next();
    });
    app.route("/auth", createAuthRouter());

    const res = await post(app, { email: "a@example.com", password: "hunter22222" });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("session=") && !c.includes("Max-Age=0"))).toBe(true);
  });

  // 按 IP 的限流是第二道闸，跟按邮箱的 LoginThrottle 正交。这四个用例锁住：命中时直接 429 且不碰
  // 数据库/verifyPassword；放行时正常走完；没有 CF-Connecting-IP 时整个跳过而不是共享一个 key；
  // 以及 key 本身带着路由前缀，不会跟别的地方的限流器撞车。
  describe("按 IP 的限流闸", () => {
    it("binding 命中限流且带 CF-Connecting-IP 时返回 429，且不查库、不跑 verifyPassword", async () => {
      const verify = vi.spyOn(password, "verifyPassword");
      const limit = vi.fn(async () => ({ success: false }));
      const { app, db } = makeApp(MEMBER, kvStore, { LOGIN_RATE_LIMITER: { limit } });

      const res = await post(app, { email: "a@example.com", password: "hunter22222" }, { "CF-Connecting-IP": "1.2.3.4" });

      expect(res.status).toBe(429);
      expect((await res.json() as any).error).toBe(
        "Too many failed attempts. Try again in 15 minutes, or sign in with an email link."
      );
      expect(db.prepare).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it("binding 放行（success: true）时正常走完登录", async () => {
      vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
      const limit = vi.fn(async () => ({ success: true }));
      const { app } = makeApp(MEMBER, kvStore, { LOGIN_RATE_LIMITER: { limit } });

      const res = await post(app, { email: "a@example.com", password: "hunter22222" }, { "CF-Connecting-IP": "1.2.3.4" });

      expect(res.status).toBe(200);
      expect(limit).toHaveBeenCalledTimes(1);
    });

    it("缺 CF-Connecting-IP 时不调用 limit()，请求照常放行——避免退化成全局共享一个 key", async () => {
      vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
      const limit = vi.fn(async () => ({ success: false }));
      const { app } = makeApp(MEMBER, kvStore, { LOGIN_RATE_LIMITER: { limit } });

      const res = await post(app, { email: "a@example.com", password: "hunter22222" });

      expect(res.status).toBe(200);
      expect(limit).not.toHaveBeenCalled();
    });

    it("传给 limit() 的 key 由 IP 派生并带上这条路由的前缀，不会跟别处的限流器撞车", async () => {
      vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
      const limit = vi.fn(async () => ({ success: true }));
      const { app } = makeApp(MEMBER, kvStore, { LOGIN_RATE_LIMITER: { limit } });

      await post(app, { email: "a@example.com", password: "hunter22222" }, { "CF-Connecting-IP": "9.8.7.6" });

      expect(limit).toHaveBeenCalledWith({ key: "password-login:9.8.7.6" });
    });
  });
});
