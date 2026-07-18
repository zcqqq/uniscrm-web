import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";
import * as youtubeApi from "../src/services/youtube-api";

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

describe("POST /api/channels/youtube/watch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the URL, creates a channel row, and subscribes WebSub", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg",
    });
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const snippetSpy = vi.spyOn(youtubeApi, "fetchChannelSnippet");

    const runMock = vi.fn().mockResolvedValue({ success: true });
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: runMock }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    const res = await app.request(
      "/api/channels/youtube/watch",
      { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg" });
    expect(subscribeSpy).toHaveBeenCalledWith(expect.stringContaining("/youtube/websub/"), "UCabc123");
    expect(snippetSpy).not.toHaveBeenCalled();

    const insertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO channels"));
    expect(insertCall![0]).toContain("YOUTUBE");
  });

  it("scopes source_channel_id by tenant so two tenants can watch the same external channel", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "",
    });
    vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    const bindMock = vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindMock }) };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) }, env);

    // 'YOUTUBE' is hardcoded in the INSERT's SQL text (see the "YOUTUBE" assertion in the
    // previous test), not passed as a bind parameter, so we can't find the INSERT bind call
    // by looking for a literal "YOUTUBE" element among its bound args. Instead assert directly
    // on what this test actually cares about: some bind() call carried the tenant-scoped
    // source_channel_id ("{tenantId}:{youtubeChannelId}").
    const allBindArgs = bindMock.mock.calls.flat();
    expect(allBindArgs).toContain("1:UCabc123"); // tenantId:youtubeChannelId
  });

  it("returns 400 when the URL cannot be resolved", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue(null);
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() }, YOUTUBE_API_KEY: "key" });

    const res = await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "not a url" }) }, env);
    expect(res.status).toBe(400);
  });

  it("reuses the existing row and does not re-subscribe when already watching this channel", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "Example Channel", thumbnailUrl: "",
    });
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);

    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ id: "existing-chan" }), run: vi.fn().mockResolvedValue({ success: true }) }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    const res = await app.request("/api/channels/youtube/watch", { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/@examplehandle" }) }, env);

    expect((await res.json() as any).channelId).toBe("existing-chan");
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  it("backfills channelName/thumbnailUrl via fetchChannelSnippet when resolution returns an empty name (direct /channel/UC... URL)", async () => {
    vi.spyOn(youtubeApi, "resolveYouTubeChannelId").mockResolvedValue({
      channelId: "UCabc123", channelName: "", thumbnailUrl: "",
    });
    const subscribeSpy = vi.spyOn(youtubeApi, "subscribeWebSub").mockResolvedValue(undefined);
    const snippetSpy = vi.spyOn(youtubeApi, "fetchChannelSnippet").mockResolvedValue({
      channelName: "Backfilled Channel", thumbnailUrl: "https://img/backfilled.jpg",
    });

    const bindMock = vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue({ success: true }) });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindMock }) };
    const { app, env } = buildApp({ LINK_DB: linkDb, YOUTUBE_API_KEY: "key", LINK_URL: "https://link.example" });

    const res = await app.request(
      "/api/channels/youtube/watch",
      { method: "POST", body: JSON.stringify({ channelUrl: "https://www.youtube.com/channel/UCabc123" }) },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ channelName: "Backfilled Channel", thumbnailUrl: "https://img/backfilled.jpg" });
    expect(snippetSpy).toHaveBeenCalledWith("key", "UCabc123");

    const insertBindArgs = bindMock.mock.calls.find((args: unknown[]) => typeof args[1] === "string" && (args[1] as string).includes("Backfilled Channel"));
    expect(insertBindArgs).toBeTruthy();
  });
});
