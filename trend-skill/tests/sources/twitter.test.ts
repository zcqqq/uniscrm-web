import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwitterTrendSource, generateTrendId } from "../../src/sources/twitter";

describe("generateTrendId", () => {
  it("produces deterministic ID from date+platform+location+title", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "AI Revolution");
    const id2 = generateTrendId("2026-04-28", "twitter", "global", "AI Revolution");
    expect(id1).toBe(id2);
  });

  it("follows format date:platform_short:location_short:hash8", () => {
    const id = generateTrendId("2026-04-28", "twitter", "global", "Test Topic");
    expect(id).toMatch(/^2026-04-28:tw:gl:[a-f0-9]{8}$/);
  });

  it("different titles produce different IDs", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "Topic A");
    const id2 = generateTrendId("2026-04-28", "twitter", "global", "Topic B");
    expect(id1).not.toBe(id2);
  });

  it("different days produce different IDs", () => {
    const id1 = generateTrendId("2026-04-28", "twitter", "global", "Same Topic");
    const id2 = generateTrendId("2026-04-29", "twitter", "global", "Same Topic");
    expect(id1).not.toBe(id2);
  });
});

describe("TwitterTrendSource", () => {
  const WOEID_CONFIGS = [
    { woeid: 1, location: "global", language: "en" },
    { woeid: 23424781, location: "china", language: "zh" },
  ] as const;

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("fetches trends for all WOEIDs and maps to TrendItems", async () => {
    const mockResponse = (trends: object[]) => ({
      ok: true,
      json: () => Promise.resolve(trends),
    });

    fetchMock
      .mockResolvedValueOnce(
        mockResponse([
          { trend_name: "AI Revolution", tweet_count: 50000, trend_url: "https://x.com/trend/1" },
          { trend_name: "Climate Summit", tweet_count: 30000, trend_url: "https://x.com/trend/2" },
        ])
      )
      .mockResolvedValueOnce(
        mockResponse([
          { trend_name: "人工智能", tweet_count: 40000, trend_url: "https://x.com/trend/3" },
        ])
      );

    const source = new TwitterTrendSource("test-bearer-token");
    const items = await source.fetchTrends();

    expect(items).toHaveLength(3);
    expect(items[0].platform).toBe("twitter");
    expect(items[0].location).toBe("global");
    expect(items[0].language).toBe("en");
    expect(items[0].title).toBe("AI Revolution");
    expect(items[0].metrics.tweet_volume).toBe(50000);

    expect(items[2].location).toBe("china");
    expect(items[2].language).toBe("zh");
    expect(items[2].title).toBe("人工智能");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.x.com/2/trends/by/woeid/1",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-bearer-token" },
      })
    );
  });

  it("returns empty array when API fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" });

    const source = new TwitterTrendSource("test-token");
    const items = await source.fetchTrends();
    expect(items).toEqual([]);
  });

  it("isAvailable returns true when token is non-empty", async () => {
    const source = new TwitterTrendSource("some-token");
    expect(await source.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when token is empty", async () => {
    const source = new TwitterTrendSource("");
    expect(await source.isAvailable()).toBe(false);
  });
});
