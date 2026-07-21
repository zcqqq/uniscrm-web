import { describe, it, expect, vi, beforeEach } from "vitest";

const getValidToken = vi.fn(async () => "tok");
const forceRefresh = vi.fn(async () => "tok2");
vi.mock("../../src/services/youtube-token", () => ({
  YouTubeTokenService: class { getValidToken = getValidToken; forceRefresh = forceRefresh; },
}));
const rateVideo = vi.fn();
const insertPlaylistItem = vi.fn();
vi.mock("../../src/services/youtube-actions", () => ({ rateVideo, insertPlaylistItem, nextPacificMidnightISO: () => "2026-07-22T07:00:00.000Z" }));
const recordYouTubeWriteQuota = vi.fn(async () => {});
vi.mock("../../src/services/youtube-quota", () => ({ recordYouTubeWriteQuota, pacificDateKey: () => "2026-07-21" }));

function makeEnv() {
  return {
    LINK_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config: JSON.stringify({ google_user_id: "g" }) }) }) }) },
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", KV: {},
  } as any;
}

async function callRate(env: any, body: any) {
  const { internalRoutes } = await import("../../src/routes-internal");
  const app = internalRoutes();
  return app.request("/youtube/rate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, env);
}

describe("POST /internal/youtube/rate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok and records quota on success", async () => {
    rateVideo.mockResolvedValue({ ok: true });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: true });
    expect(recordYouTubeWriteQuota).toHaveBeenCalled();
  });

  it("propagates rateLimited without recording quota", async () => {
    rateVideo.mockResolvedValue({ ok: false, rateLimited: true, rateLimitReset: "2026-07-22T07:00:00.000Z" });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: false, rateLimited: true, rateLimitReset: "2026-07-22T07:00:00.000Z" });
    expect(recordYouTubeWriteQuota).not.toHaveBeenCalled();
  });

  it("retries once after unauthorized", async () => {
    rateVideo.mockResolvedValueOnce({ ok: false, unauthorized: true }).mockResolvedValueOnce({ ok: true });
    const res = await callRate(makeEnv(), { channelId: "ch", contentId: "c", videoId: "v" });
    expect(await res.json()).toEqual({ ok: true });
    expect(forceRefresh).toHaveBeenCalledTimes(1);
  });
});
