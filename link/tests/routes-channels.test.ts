import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return { app, env };
}

describe("GET /api/channels", () => {
  it("does not leak TWITTER rows when querying a non-X type", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    await app.request("/api/channels?type=YOUTUBE", {}, env);

    const sql = linkDb.prepare.mock.calls[0][0] as string;
    expect(sql).not.toContain("TWITTER");
    const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs).toEqual([1, "YOUTUBE"]);
  });

  it("still includes TWITTER rows when querying type=X (legacy migration alias)", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    await app.request("/api/channels?type=X", {}, env);

    const sql = linkDb.prepare.mock.calls[0][0] as string;
    // Fully parametrized query: 'TWITTER' is a bound value, not a SQL literal
    // (a literal would mismatch the bind-arg count against real D1). The
    // second IN-clause placeholder is the signal that the alias was added.
    expect(sql).toContain("IN (?, ?)");
    const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs).toEqual([1, "X", "TWITTER"]);
  });
});
