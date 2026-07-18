import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { youtubeWebhookRoutes } from "../src/webhook-youtube";
import * as youtubeContent from "../src/services/pollers/youtube-content";

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.route("/youtube", youtubeWebhookRoutes());
  return { app, env };
}

describe("youtubeWebhookRoutes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("GET /websub/:channelId echoes hub.challenge and stores the lease expiry", async () => {
    const updateBind = vi.fn().mockReturnValue({ run: vi.fn().mockResolvedValue({ success: true }) });
    const selectFirst = vi.fn().mockResolvedValue({ config: JSON.stringify({ youtube_channel_id: "UCabc" }) });
    const linkDb = {
      prepare: vi.fn((sql: string) =>
        sql.startsWith("SELECT")
          ? { bind: vi.fn().mockReturnValue({ first: selectFirst }) }
          : { bind: updateBind }
      ),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request(
      "/youtube/websub/chan1?hub.challenge=abc123&hub.lease_seconds=432000&hub.topic=t&hub.mode=subscribe",
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    expect(updateBind).toHaveBeenCalled();
    const configArg = updateBind.mock.calls[0][0] as string;
    expect(JSON.parse(configArg).websub_lease_expires_at).toBeTruthy();
  });

  it("GET /websub/:channelId returns 400 when hub.challenge is missing", async () => {
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() } });
    const res = await app.request("/youtube/websub/chan1", {}, env);
    expect(res.status).toBe(400);
  });

  it("POST /websub/:channelId extracts videoIds and ingests each one", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ tenant_id: 1 }),
        }),
      }),
    };
    const webDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ d1_database_id: "db-1" }),
        }),
      }),
    };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);

    const { app, env } = buildApp({
      LINK_DB: linkDb, WEB_DB: webDb, CF_ACCOUNT_ID: "acc", CF_D1_API_TOKEN: "tok",
      AI: {}, VECTORIZE: {}, YOUTUBE_API_KEY: "key",
    });

    const atomBody = `<?xml version="1.0"?><feed xmlns:yt="ns"><entry><yt:videoId>vid1</yt:videoId></entry></feed>`;
    const res = await app.request("/youtube/websub/chan1", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy.mock.calls[0][1]).toBe("vid1");
    expect(ingestSpy.mock.calls[0][0]).toMatchObject({ channelId: "chan1", tenantId: 1 });
  });

  it("POST /websub/:channelId is a no-op when the channel is unknown", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const atomBody = `<entry><yt:videoId>vid1</yt:videoId></entry>`;
    const res = await app.request("/youtube/websub/unknown-chan", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
