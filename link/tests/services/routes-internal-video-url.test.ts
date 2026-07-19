import { describe, it, expect } from "vitest";
import { internalRoutes } from "../../src/routes-internal";

function makeEnv(channelRow: { channel_type: string; config: string } | null) {
  return {
    INTERNAL_SECRET: "test-secret",
    LINK_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => channelRow,
        }),
      }),
    },
  } as any;
}

describe("POST /internal/content/video-url", () => {
  it("returns a youtube watch URL for a YouTube channel", async () => {
    const router = internalRoutes();
    const env = makeEnv({ channel_type: "YOUTUBE_ACCOUNT", config: "{}" });
    const res = await router.request(
      "/content/video-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: "c1", channelId: "ch1", sourceContentId: "abc123" }),
      },
      env
    );
    const body = await res.json() as { url: string | null };
    expect(body.url).toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("returns an x status URL for an X channel", async () => {
    const router = internalRoutes();
    const env = makeEnv({ channel_type: "X", config: JSON.stringify({ x_username: "jack" }) });
    const res = await router.request(
      "/content/video-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: "c1", channelId: "ch1", sourceContentId: "999" }),
      },
      env
    );
    const body = await res.json() as { url: string | null };
    expect(body.url).toBe("https://x.com/jack/status/999");
  });

  it("returns null for an X channel with no x_username in config", async () => {
    const router = internalRoutes();
    const env = makeEnv({ channel_type: "X", config: "{}" });
    const res = await router.request(
      "/content/video-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: "c1", channelId: "ch1", sourceContentId: "999" }),
      },
      env
    );
    const body = await res.json() as { url: string | null };
    expect(body.url).toBeNull();
  });

  it("returns null when the channel is not found", async () => {
    const router = internalRoutes();
    const env = makeEnv(null);
    const res = await router.request(
      "/content/video-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: "c1", channelId: "ch1", sourceContentId: "abc123" }),
      },
      env
    );
    const body = await res.json() as { url: string | null };
    expect(body.url).toBeNull();
  });

  it("returns null for an unsupported channel type", async () => {
    const router = internalRoutes();
    const env = makeEnv({ channel_type: "TIKTOK", config: "{}" });
    const res = await router.request(
      "/content/video-url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentId: "c1", channelId: "ch1", sourceContentId: "abc123" }),
      },
      env
    );
    const body = await res.json() as { url: string | null };
    expect(body.url).toBeNull();
  });
});
