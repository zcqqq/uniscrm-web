import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPostsPage, createPost, repostPost, fetchOwnedLists, fetchListPostsPage } from "../../src/services/x-posts-api";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPostsPage", () => {

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

describe("createPost", () => {
  it("posts text-only to /2/tweets and returns the new tweet id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { id: "tweet-123", text: "hello" } }), { status: 201 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: true, id: "tweet-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/tweets");
    expect((init as Record<string, any>).headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ text: "hello world" });
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok:false on other non-ok statuses without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    const result = await createPost("tok", "hello world");

    expect(result).toEqual({ ok: false });
  });
});

describe("repostPost", () => {
  it("posts tweet_id to /2/users/:id/retweets and returns ok:true", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { retweeted: true } }), { status: 200 }));

    const result = await repostPost("tok", "x-user-1", "tweet-999");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x.com/2/users/x-user-1/retweets");
    expect((init as Record<string, any>).headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse((init as Record<string, any>).body)).toEqual({ tweet_id: "tweet-999" });
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    const result = await repostPost("tok", "x-user-1", "tweet-999");
    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok:false on other non-ok statuses without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));
    const result = await repostPost("tok", "x-user-1", "tweet-999");
    expect(result).toEqual({ ok: false });
  });
});

describe("fetchOwnedLists", () => {
  it("returns id/name pairs from get-owned-lists", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "list1", name: "Competitors" }, { id: "list2", name: "Influencers" }] }), { status: 200 })
    );

    const lists = await fetchOwnedLists("tok", "x-user-1");

    expect(lists).toEqual([{ id: "list1", name: "Competitors" }, { id: "list2", name: "Influencers" }]);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toContain("/2/users/x-user-1/owned_lists");
  });

  it("returns an empty array when the account owns no lists", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const lists = await fetchOwnedLists("tok", "x-user-1");

    expect(lists).toEqual([]);
  });

  it("throws XUnauthorizedError on 401", async () => {
    const { XUnauthorizedError } = await import("../../src/services/x-errors");
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));

    await expect(fetchOwnedLists("tok", "x-user-1")).rejects.toBeInstanceOf(XUnauthorizedError);
  });
});

describe("fetchListPostsPage", () => {
  it("requests /2/lists/:id/tweets with the list id and pagination token", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "t1", text: "hi" }], meta: { next_token: "p2" } }), { status: 200 })
    );

    const { page, rateLimited } = await fetchListPostsPage("tok", "listA", "p1");

    expect(rateLimited).toBe(false);
    expect(page).toEqual({ data: [{ id: "t1", text: "hi" }], nextToken: "p2" });
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toContain("/2/lists/listA/tweets");
    expect(calledUrl.searchParams.get("pagination_token")).toBe("p1");
  });

  it("returns rateLimited:true on 429 without throwing", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));

    const { rateLimited } = await fetchListPostsPage("tok", "listA");

    expect(rateLimited).toBe(true);
  });
});
