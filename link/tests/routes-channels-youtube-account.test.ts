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
  it("returns connected:false and an empty list when no account is connected", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);

    expect(await res.json()).toEqual({ connected: false, accountChannelId: null, subscriptions: [] });
  });

  it("returns the account's id and its cached subscriptions, with no already_watching field", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify({ subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "" }, { channelId: "UC2", channelName: "Two", thumbnailUrl: "" }] }),
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

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
