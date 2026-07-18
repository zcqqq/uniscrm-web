import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseISO8601Duration,
  fetchVideoDetails,
  subscribeWebSub,
  unsubscribeWebSub,
  fetchAllSubscriptions,
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

  it("fetchAllSubscriptions returns items from a single page", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [
        { snippet: { resourceId: { channelId: "UCabc" }, title: "Channel A", thumbnails: { default: { url: "https://img/a.jpg" } } } },
        { snippet: { resourceId: { channelId: "UCdef" }, title: "Channel B", thumbnails: { default: { url: "https://img/b.jpg" } } } },
      ],
    }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result).toEqual([
      { channelId: "UCabc", channelName: "Channel A", thumbnailUrl: "https://img/a.jpg" },
      { channelId: "UCdef", channelName: "Channel B", thumbnailUrl: "https://img/b.jpg" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("mine=true");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer access-tok");
  });

  it("fetchAllSubscriptions paginates until nextPageToken is absent", async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse({
        items: [{ snippet: { resourceId: { channelId: "UC1" }, title: "One" } }],
        nextPageToken: "page2",
      }))
      .mockImplementationOnce(() => jsonResponse({
        items: [{ snippet: { resourceId: { channelId: "UC2" }, title: "Two" } }],
      }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result.map((s) => s.channelId)).toEqual(["UC1", "UC2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("pageToken=page2");
  });

  it("fetchAllSubscriptions skips items with no resourceId.channelId", async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({
      items: [{ snippet: { title: "Broken" } }, { snippet: { resourceId: { channelId: "UCok" }, title: "OK" } }],
    }));
    const result = await fetchAllSubscriptions("access-tok");
    expect(result).toEqual([{ channelId: "UCok", channelName: "OK", thumbnailUrl: "" }]);
  });

  it("fetchAllSubscriptions throws on a non-ok response", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("forbidden", { status: 403 })));
    await expect(fetchAllSubscriptions("access-tok")).rejects.toThrow();
  });
});
