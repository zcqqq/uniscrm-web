import { describe, it, expect } from "vitest";
import { youtubeActionRequest } from "../../src/index";

describe("youtubeActionRequest", () => {
  const base = { env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" }, channelId: "ch", contentId: "c", flowId: "f", payload: { source_content_id: "vid" } };

  it("routes rate-like to /internal/youtube/rate", () => {
    const req = youtubeActionRequest({ ...base, action: { type: "youtubeContentAction", operation: "rate-like" } as any });
    expect(req.url).toBe("https://link/internal/youtube/rate");
    expect(JSON.parse(req.body)).toEqual({ channelId: "ch", contentId: "c", videoId: "vid", flowId: "f" });
  });

  it("routes save-to-playlist to /internal/youtube/playlist-insert with playlistId", () => {
    const req = youtubeActionRequest({ ...base, action: { type: "youtubeContentAction", operation: "save-to-playlist", playlistId: "pl1" } as any });
    expect(req.url).toBe("https://link/internal/youtube/playlist-insert");
    expect(JSON.parse(req.body)).toEqual({ channelId: "ch", contentId: "c", videoId: "vid", playlistId: "pl1", flowId: "f" });
  });
});
