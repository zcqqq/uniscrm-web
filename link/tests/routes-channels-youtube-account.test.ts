import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";
import * as youtubeAccount from "../src/services/youtube-account";

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

describe("POST /api/channels/youtube/subscriptions/:id/watch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("looks up the subscription from the cached list and calls findOrCreateWatchedChannel", async () => {
    const findOrCreateSpy = vi.spyOn(youtubeAccount, "findOrCreateWatchedChannel").mockResolvedValue({
      channelId: "new-chan", channelName: "One", thumbnailUrl: "https://img/1.jpg",
    });
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "https://img/1.jpg" }] }),
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UC1/watch", { method: "POST" }, env);
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toEqual({ channelId: "new-chan", channelName: "One", thumbnailUrl: "https://img/1.jpg" });
    expect(findOrCreateSpy).toHaveBeenCalledWith(env, 1, "member1", "UC1", "One", "https://img/1.jpg");
  });

  it("returns 404 when the channelId is not in the tenant's cached subscription list", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ config: JSON.stringify({ subscriptions: [] }) }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UCnotmine/watch", { method: "POST" }, env);

    expect(res.status).toBe(404);
  });

  it("returns 400 when no YouTube account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions/UC1/watch", { method: "POST" }, env);

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/channels/youtube_account (disconnect isolation)", () => {
  it("only deactivates the YOUTUBE_ACCOUNT row — never touches YOUTUBE watched-channel rows or WebSub", async () => {
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindSpy = vi.fn().mockReturnValue({ run: runMock });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindSpy }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube_account", { method: "DELETE" }, env);

    expect(res.status).toBe(200);
    const updateSql = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"))![0] as string;
    expect(updateSql).toContain("channel_type = ?");
    const bindArgs = bindSpy.mock.calls.find((c: unknown[]) => c.includes("YOUTUBE_ACCOUNT"));
    expect(bindArgs).toBeTruthy();
    // Only one UPDATE call total — nothing separately touches channel_type = 'YOUTUBE' rows.
    const allUpdateCalls = linkDb.prepare.mock.calls.filter((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"));
    expect(allUpdateCalls).toHaveLength(1);
  });
});
