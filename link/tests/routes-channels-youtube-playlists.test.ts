import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const getValidToken = vi.fn(async () => "tok");
vi.mock("../src/services/youtube-token", () => ({
  YouTubeTokenService: class { getValidToken = getValidToken; },
}));

async function buildApp(env: Record<string, unknown>) {
  const { channelsRoutes } = await import("../src/routes-channels");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 1 as never);
    c.set("memberId" as never, "member1" as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  return { app, env };
}

function envWithAccount(hasAccount: boolean) {
  return {
    LINK_DB: { prepare: () => ({ bind: () => ({ first: async () => (hasAccount ? { id: "acc" } : null) }) }) },
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec",
  } as any;
}

describe("GET /api/channels/youtube/playlists", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns connected:false when no YouTube account", async () => {
    const { app, env } = await buildApp(envWithAccount(false));
    const res = await app.request("/api/channels/youtube/playlists", { method: "GET" }, env);
    expect(await res.json()).toMatchObject({ connected: false, playlists: [] });
  });

  it("lists playlists for a connected account", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: "pl1", snippet: { title: "Watch queue" } }],
    }), { status: 200 })));
    const { app, env } = await buildApp(envWithAccount(true));
    const res = await app.request("/api/channels/youtube/playlists", { method: "GET" }, env);
    expect(await res.json()).toEqual({ connected: true, playlists: [{ id: "pl1", title: "Watch queue" }] });
  });
});
