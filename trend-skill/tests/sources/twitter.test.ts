import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwitterTrendSource } from "../../src/sources/twitter";
import type { TrendItem } from "../../src/types";

const MOCK_TRENDS_RESPONSE = {
  data: [
    {
      trend_name: "#AIRevolution",
      tweet_count: 125000,
    },
    {
      trend_name: "Climate Summit",
      tweet_count: 89000,
    },
  ],
};

describe("TwitterTrendSource", () => {
  let source: TwitterTrendSource;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    source = new TwitterTrendSource("test-bearer-token", mockFetch);
  });

  it("has platform set to twitter", () => {
    expect(source.platform).toBe("twitter");
  });

  it("fetches and transforms trends into TrendItem format", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(MOCK_TRENDS_RESPONSE), { status: 200 })
    );

    const items = await source.fetchTrends({ limit: 10 });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      platform: "twitter",
      title: "#AIRevolution",
      rawMetrics: { tweet_volume: 125000 },
    });
    expect(items[0].id).toMatch(/^twitter:/);
    expect(items[0].url).toContain("x.com");
    expect(items[0].timestamp).toBeDefined();
  });

  it("returns empty array when API returns error", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const items = await source.fetchTrends();
    expect(items).toEqual([]);
  });

  it("isAvailable returns true when API responds 200", async () => {
    mockFetch.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await source.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when API responds non-200", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await source.isAvailable()).toBe(false);
  });

  it("respects limit option", async () => {
    const largeTrends = {
      data: Array.from({ length: 20 }, (_, i) => ({
        trend_name: `Trend${i}`,
        tweet_count: 1000 * (20 - i),
      })),
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(largeTrends), { status: 200 })
    );

    const items = await source.fetchTrends({ limit: 5 });
    expect(items).toHaveLength(5);
  });
});
