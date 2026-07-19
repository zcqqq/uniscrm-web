import { describe, it, expect, vi, afterEach } from "vitest";
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

  it("GET /websub/:accountChannelId/:youtubeChannelId echoes hub.challenge and upserts the lease", async () => {
    const runMock = vi.fn().mockResolvedValue({ success: true });
    const bindSpy = vi.fn().mockReturnValue({ run: runMock, first: vi.fn().mockResolvedValue({ tenant_id: 1 }) });
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: bindSpy }) };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request(
      "/youtube/websub/acct1/UCabc?hub.challenge=abc123&hub.lease_seconds=432000&hub.topic=t&hub.mode=subscribe",
      {},
      env
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    const upsertCall = linkDb.prepare.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO youtube_websub_leases"));
    expect(upsertCall).toBeTruthy();
    expect(upsertCall![0]).toContain("ON CONFLICT(account_channel_id, youtube_channel_id)");
    const bindArgs = bindSpy.mock.calls.find((c: unknown[]) => c.includes("acct1") && c.includes("UCabc"));
    expect(bindArgs).toBeTruthy();
  });

  it("GET /websub/:accountChannelId/:youtubeChannelId returns 400 when hub.challenge is missing", async () => {
    const { app, env } = buildApp({ LINK_DB: { prepare: vi.fn() } });
    const res = await app.request("/youtube/websub/acct1/UCabc", {}, env);
    expect(res.status).toBe(400);
  });

  it("POST /websub/:accountChannelId/:youtubeChannelId extracts videoIds and ingests each one", async () => {
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
    const res = await app.request("/youtube/websub/acct1/UCabc", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy.mock.calls[0][1]).toBe("vid1");
    expect(ingestSpy.mock.calls[0][0]).toMatchObject({ accountChannelId: "acct1", subscriptionChannelId: "UCabc", tenantId: 1 });
  });

  it("POST /websub/:accountChannelId/:youtubeChannelId is a no-op when there's no matching lease", async () => {
    const linkDb = { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) };
    const ingestSpy = vi.spyOn(youtubeContent, "ingestYouTubeVideo").mockResolvedValue(undefined);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const atomBody = `<entry><yt:videoId>vid1</yt:videoId></entry>`;
    const res = await app.request("/youtube/websub/unknown-acct/UCabc", { method: "POST", body: atomBody }, env);

    expect(res.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
