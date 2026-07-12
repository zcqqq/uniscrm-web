import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPostsPage } from "../../src/services/x-posts-api";

describe("fetchPostsPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests exclude=replies,retweets and no expansions param", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await fetchPostsPage("tok", "u1");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/2/users/u1/tweets");
    expect(calledUrl.searchParams.get("exclude")).toBe("replies,retweets");
    expect(calledUrl.searchParams.has("expansions")).toBe(false);
    expect(calledUrl.searchParams.get("tweet.fields")).toContain("public_metrics");
  });

  it("passes pagination_token when provided", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await fetchPostsPage("tok", "u1", "cursor123");

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("pagination_token")).toBe("cursor123");
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await fetchPostsPage("tok", "u1");

    expect(result.rateLimited).toBe(true);
    expect(result.page.data).toEqual([]);
  });

  it("throws on other non-ok statuses", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    await expect(fetchPostsPage("tok", "u1")).rejects.toThrow("X get-posts failed: 500");
  });

  it("parses data and next_token from a successful response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "t1", text: "hi" }], meta: { next_token: "p2" } }), { status: 200 })
    );

    const result = await fetchPostsPage("tok", "u1");

    expect(result.rateLimited).toBe(false);
    expect(result.page.data).toEqual([{ id: "t1", text: "hi" }]);
    expect(result.page.nextToken).toBe("p2");
  });
});
