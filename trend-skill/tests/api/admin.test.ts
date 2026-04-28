import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createAdminRouter } from "../../src/api/admin";
import type { Env } from "../../src/types";

const makeApp = (adminSecret = "test-secret") => {
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({}),
        first: vi.fn().mockResolvedValue({ key: "sk_trend_abc", tier: "free", is_active: 1 }),
      }),
    }),
  };

  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    (c.env as any) = { TREND_DB: mockDb, ADMIN_SECRET: adminSecret };
    await next();
  });
  app.route("/admin", createAdminRouter());
  return app;
};

describe("Admin API", () => {
  it("rejects requests without valid Bearer token", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("creates a key with valid auth", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier: "free", owner_name: "test" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.key).toMatch(/^sk_trend_/);
  });

  it("gets key info", async () => {
    const app = makeApp();
    const res = await app.request("/admin/keys/sk_trend_abc", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
  });
});
