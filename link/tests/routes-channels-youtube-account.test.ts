import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    c.set("memberId" as never, "member1" as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return { app, env };
}

describe("GET /api/channels/youtube/status", () => {
  it("returns connected:false when no YOUTUBE_ACCOUNT row exists", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(await res.json()).toEqual({ connected: false });
  });

  it("returns account details when connected", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ email: "a@b.com", sync_status: "done", subscriptions: [{ channelId: "UC1" }, { channelId: "UC2" }] }),
            created_at: "2026-07-18T00:00:00.000Z",
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(await res.json()).toEqual({
      connected: true, email: "a@b.com", sync_status: "done", subscription_count: 2, created_at: "2026-07-18T00:00:00.000Z",
    });
  });
});

describe("GET /api/channels/youtube/subscriptions", () => {
  it("returns an empty list when no account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);

    expect(await res.json()).toEqual({ subscriptions: [] });
  });

  it("annotates already_watching against existing YOUTUBE rows", async () => {
    const linkDb = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("YOUTUBE_ACCOUNT")) {
          return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "" }, { channelId: "UC2", channelName: "Two", thumbnailUrl: "" }] }),
          }) }) };
        }
        return { bind: vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({
          results: [{ config: JSON.stringify({ youtube_channel_id: "UC1" }) }],
        }) }) };
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.subscriptions).toEqual([
      { channelId: "UC1", channelName: "One", thumbnailUrl: "", already_watching: true },
      { channelId: "UC2", channelName: "Two", thumbnailUrl: "", already_watching: false },
    ]);
  });
});
