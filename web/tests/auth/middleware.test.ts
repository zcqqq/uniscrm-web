import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/auth/middleware";

describe("authMiddleware", () => {
  let kv: any;
  let app: Hono;

  beforeEach(() => {
    kv = {
      get: vi.fn().mockResolvedValue(null),
    };
    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { KV: kv };
      return next();
    });
    app.use("/*", authMiddleware);
    app.get("/test", (c) => {
      const userId = c.get("userId" as never);
      return c.json({ userId });
    });
  });

  it("returns 401 when no session cookie", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 401 when session not found in KV", async () => {
    const res = await app.request("/test", {
      headers: { Cookie: "session=invalid-id" },
    });
    expect(res.status).toBe(401);
  });

  it("attaches userId to context when session valid", async () => {
    kv.get.mockResolvedValue(
      JSON.stringify({
        user_id: "user-1",
        email: "test@example.com",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
    );
    const res = await app.request("/test", {
      headers: { Cookie: "session=valid-id" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
  });
});
