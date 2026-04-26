import { describe, it, expect, vi } from "vitest";
import { createAdminRouter } from "../../src/api/admin";
import { Hono } from "hono";
import type { Env } from "../../src/types";

function createTestApp() {
  const keys: Record<string, { key: string; tier: string }> = {};
  const mockDB = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        run: vi.fn(async () => {
          if (sql.startsWith("INSERT")) {
            keys[args[0] as string] = { key: args[0] as string, tier: args[1] as string };
          }
          return { success: true };
        }),
        first: vi.fn(async () => keys[args[0] as string] ?? null),
      })),
    })),
  } as unknown as D1Database;

  const app = new Hono<{ Bindings: Env }>();
  app.route("/admin", createAdminRouter());

  const env = { TREND_DB: mockDB, ADMIN_SECRET: "test-secret" } as unknown as Env;

  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init ?? {}, env),
  };
}

describe("Admin API", () => {
  it("rejects requests without admin secret", async () => {
    const { request } = createTestApp();
    const res = await request("/admin/keys", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("creates a key with correct auth", async () => {
    const { request } = createTestApp();
    const res = await request("/admin/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tier: "premium", owner_name: "Test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_trend_/);
  });
});
