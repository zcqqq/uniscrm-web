import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseISO8601Duration,
  resolveYouTubeChannelId,
  fetchVideoDetails,
  subscribeWebSub,
  unsubscribeWebSub,
} from "../../src/services/youtube-api";

describe("parseISO8601Duration", () => {
  it("parses hours, minutes, seconds", () => {
    expect(parseISO8601Duration("PT1H2M3S")).toBe(3723);
  });
  it("parses minutes-only", () => {
    expect(parseISO8601Duration("PT4M13S")).toBe(253);
  });
  it("parses seconds-only", () => {
    expect(parseISO8601Duration("PT45S")).toBe(45);
  });
  it("returns 0 for unparseable input", () => {
    expect(parseISO8601Duration("garbage")).toBe(0);
  });
});

describe("youtube-api fetch functions", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it("resolveYouTubeChannelId extracts a /channel/UC... URL without an API call", async () => {
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/channel/UCabc123");
    expect(result?.channelId).toBe("UCabc123");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolveYouTubeChannelId resolves a @handle via channels.list forHandle", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [{ id: "UCxyz789", snippet: { title: "Example Channel", thumbnails: { default: { url: "https://img/thumb.jpg" } } } }],
    }));
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/@examplehandle");
    expect(result).toEqual({ channelId: "UCxyz789", channelName: "Example Channel", thumbnailUrl: "https://img/thumb.jpg" });
    expect(fetchMock.mock.calls[0][0]).toContain("forHandle=%40examplehandle");
  });

  it("resolveYouTubeChannelId returns null when the API finds no channel", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [] }));
    const result = await resolveYouTubeChannelId("key", "https://www.youtube.com/@nobody");
    expect(result).toBeNull();
  });

  it("fetchVideoDetails returns the first item", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [{ id: "vid1", snippet: { title: "Video 1" } }] }));
    const result = await fetchVideoDetails("key", "vid1");
    expect(result).toEqual({ id: "vid1", snippet: { title: "Video 1" } });
  });

  it("fetchVideoDetails returns null when the video no longer exists", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ items: [] }));
    const result = await fetchVideoDetails("key", "deleted-vid");
    expect(result).toBeNull();
  });

  it("subscribeWebSub POSTs form-encoded hub.mode=subscribe", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 202 })));
    await subscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pubsubhubbub.appspot.com/subscribe");
    expect(init.body).toContain("hub.mode=subscribe");
    expect(init.body).toContain("hub.callback=https%3A%2F%2Flink.example%2Fyoutube%2Fwebsub%2Fchan1");
    expect(init.body).toContain(encodeURIComponent("channel_id=UCabc123"));
  });

  it("subscribeWebSub throws on a non-ok hub response", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("bad request", { status: 400 })));
    await expect(subscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123")).rejects.toThrow();
  });

  it("unsubscribeWebSub POSTs hub.mode=unsubscribe", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 202 })));
    await unsubscribeWebSub("https://link.example/youtube/websub/chan1", "UCabc123");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toContain("hub.mode=unsubscribe");
  });
});
