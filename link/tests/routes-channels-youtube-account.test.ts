import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";

function buildApp(env: Record<string, unknown>, tenantDataDb?: { query: ReturnType<typeof vi.fn> }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    c.set("memberId" as never, "member1" as never);
    c.set("tenantDataDb" as never, tenantDataDb as never);
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

  it("returns account details when connected, with subscription_count from the per-tenant D1 user table", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify({ email: "a@b.com", sync_status: "done" }),
            created_at: "2026-07-18T00:00:00.000Z",
          }),
        }),
      }),
    };
    // subscription_count is no longer read from config — it comes from a live COUNT query
    // against the per-tenant D1 `user` table (is_follow=1 YOUTUBE rows written by the poller).
    const query = vi.fn().mockResolvedValue([{ c: 2 }]);
    const { app, env } = buildApp({ LINK_DB: linkDb }, { query });

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(await res.json()).toEqual({
      connected: true, email: "a@b.com", sync_status: "done", subscription_count: 2, created_at: "2026-07-18T00:00:00.000Z",
    });
    expect(query.mock.calls[0][1]).toEqual(["acct1"]);
  });

  it("returns subscription_count 0 (not an error) when the tenant has no provisioned D1", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify({ email: "a@b.com", sync_status: "done" }),
            created_at: "2026-07-18T00:00:00.000Z",
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb }, undefined);

    const res = await app.request("/api/channels/youtube/status", {}, env);

    expect(res.status).toBe(200);
    expect((await res.json() as any).subscription_count).toBe(0);
  });
});

describe("GET /api/channels/youtube/subscriptions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  function tokenConfig(extra: Record<string, unknown> = {}) {
    return { access_token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString(), ...extra };
  }

  it("returns connected:false and an empty list when no account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs" });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);

    expect(await res.json()).toEqual({ connected: false, accountChannelId: null, subscriptions: [] });
  });

  it("returns the account's id and its live subscriptions (fetched from the YouTube API, not a cached snapshot), with no already_watching field", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify(tokenConfig()),
          }),
        }),
      }),
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      items: [
        { snippet: { resourceId: { channelId: "UC1" }, title: "One", thumbnails: { default: { url: "" } } } },
        { snippet: { resourceId: { channelId: "UC2" }, title: "Two", thumbnails: { default: { url: "" } } } },
      ],
    }), { status: 200 }));
    const { app, env } = buildApp({ LINK_DB: linkDb, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs" });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body).toEqual({
      connected: true,
      accountChannelId: "acct1",
      subscriptions: [
        { channelId: "UC1", channelName: "One", thumbnailUrl: "" },
        { channelId: "UC2", channelName: "Two", thumbnailUrl: "" },
      ],
    });
  });

  it("includes the connected account's email alongside its live subscriptions", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify(tokenConfig({ email: "creator@example.com" })),
          }),
        }),
      }),
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      items: [{ snippet: { resourceId: { channelId: "UC1" }, title: "One", thumbnails: { default: { url: "" } } } }],
    }), { status: 200 }));
    const { app, env } = buildApp({ LINK_DB: linkDb, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs" });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.email).toBe("creator@example.com");
  });
});

describe("DELETE /api/channels/youtube_account (disconnect isolation)", () => {
  it("only deactivates the YOUTUBE_ACCOUNT row — never touches WebSub leases", async () => {
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
    const allUpdateCalls = linkDb.prepare.mock.calls.filter((c: unknown[]) => (c[0] as string).startsWith("UPDATE channels"));
    expect(allUpdateCalls).toHaveLength(1);
  });
});
