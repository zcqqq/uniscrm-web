import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/auth/middleware";

// authMiddleware 从 WEB_DB 的 sessions 表读会话，不是 KV。本文件先前测的是那版
// KV 实现（env 里塞 { KV: kv }），实现换成 D1 后一直没跟上，2026-08-01 按真实实现重写。
function fakeWebDb(sessionRow: Record<string, unknown> | null) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(sessionRow),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    })),
  } as unknown as D1Database;
}

const validRow = {
  member_id: "member-1",
  tenant_id: 42,
  email: "test@example.com",
  language: "zh",
  expires_at: "2030-01-01T00:00:00.000Z",
};

function makeApp(sessionRow: Record<string, unknown> | null) {
  const app = new Hono();
  app.use("/*", (c, next) => {
    (c.env as never) = { WEB_DB: fakeWebDb(sessionRow) } as never;
    return next();
  });
  app.use("/*", authMiddleware);
  app.get("/test", (c) =>
    c.json({
      memberId: c.get("memberId" as never),
      tenantId: c.get("tenantId" as never),
      email: c.get("email" as never),
      hasDb: !!c.get("db" as never),
    })
  );
  return app;
}

describe("authMiddleware", () => {
  it("returns 401 when there is no session cookie", async () => {
    const res = await makeApp(validRow).request("/test");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the session row does not exist", async () => {
    const res = await makeApp(null).request("/test", {
      headers: { Cookie: "session=invalid-id" },
    });
    expect(res.status).toBe(401);
  });

  it("attaches member, tenant, email and a tenant-scoped db when the session is valid", async () => {
    const res = await makeApp(validRow).request("/test", {
      headers: { Cookie: "session=valid-id" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memberId: "member-1",
      tenantId: 42,
      email: "test@example.com",
      // 每个请求都必须拿到按本会话 tenant 作用域化的 db —— 少了它下游查询就没有租户隔离。
      hasDb: true,
    });
  });
});
