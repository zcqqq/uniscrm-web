import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";

// members.email 上的唯一索引把 /verify 里「先 SELECT 再 INSERT」的窗口给收窄了：并发点开同一个
// 邮箱的两条 magic link 时，慢的那个请求会撞上唯一约束。它应该重新读到先赢的那一行继续走完登录，
// 而不是把 500 丢给用户。
describe("POST /auth/verify 撞上唯一约束时", () => {
  let db: any;
  let app: Hono;
  let ctx: any;
  let insertAttempts: number;

  beforeEach(() => {
    insertAttempts = 0;
    const raced = {
      id: "member-winner",
      tenant_id: 42,
      email: "race@example.com",
      preferred_location: "global",
      language: "en",
      timezone: "Asia/Shanghai",
    };

    db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.startsWith("SELECT * FROM magic_links")) {
              return {
                token: "t1",
                email: "race@example.com",
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                used: 0,
                trial: null,
                timezone: "Asia/Shanghai",
              };
            }
            if (sql.includes("FROM members WHERE email")) {
              // 第一次查（INSERT 之前）没有；INSERT 撞车后再查，先赢的那行已经在了
              return insertAttempts === 0 ? null : raced;
            }
            if (sql.includes("FROM tenants WHERE email")) return { tenant_id: 42 };
            return null;
          }),
          run: vi.fn(async () => {
            if (sql.startsWith("INSERT INTO members")) {
              insertAttempts++;
              throw new Error("UNIQUE constraint failed: members.email");
            }
            return {};
          }),
        })),
      })),
    };

    ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { WEB_DB: db, KV: {}, WEB_URL: "https://app.example.com" };
      return next();
    });
    app.route("/auth", createAuthRouter());
  });

  it("重新读到先赢的那一行并正常登录", async () => {
    const res = await app.request("/auth/verify?token=t1", {}, undefined, ctx);

    expect(insertAttempts).toBe(1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.member.id).toBe("member-winner");
    expect(body.tenant.id).toBe(42);
  });
});
