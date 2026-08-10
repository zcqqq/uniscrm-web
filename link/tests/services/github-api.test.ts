import { describe, it, expect, vi, afterEach } from "vitest";
import { listWatchedRepos, listReleases, getRepo, GitHubUnauthorizedError } from "../../src/services/github-api";

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }));
  return calls;
}

describe("listWatchedRepos", () => {
  it("翻页直到拿不满一页", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, full_name: `o/r${i}`, name: `r${i}`, description: null, private: false }));
    const calls = stub((url) =>
      new Response(JSON.stringify(url.includes("page=2") ? [{ id: 999, full_name: "o/last", name: "last", description: null, private: false }] : page1), { status: 200 })
    );

    const repos = await listWatchedRepos("tok");

    expect(repos).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/user/subscriptions?per_page=100&page=1");
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("401 抛 GitHubUnauthorizedError —— 上游据此标记 channel 需重连", async () => {
    stub(() => new Response("bad credentials", { status: 401 }));
    await expect(listWatchedRepos("tok")).rejects.toBeInstanceOf(GitHubUnauthorizedError);
  });
});

describe("listReleases", () => {
  it("带 If-None-Match，304 时 releases 为 null 且保留旧 etag", async () => {
    const calls = stub(() => new Response(null, { status: 304 }));

    const r = await listReleases("tok", "o/r", 'W/"abc"');

    expect(r.releases).toBeNull();
    expect(r.etag).toBe('W/"abc"');
    expect(r.rateLimited).toBe(false);
    expect((calls[0].init!.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
  });

  it("200 时回传新 etag", async () => {
    stub(() => new Response(JSON.stringify([{ id: 1, tag_name: "v1", name: "v1", body: "", html_url: "u", draft: false, prerelease: false, published_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z" }]), {
      status: 200,
      headers: { ETag: 'W/"new"' },
    }));

    const r = await listReleases("tok", "o/r", null);

    expect(r.releases).toHaveLength(1);
    expect(r.etag).toBe('W/"new"');
  });

  it("404 标 notFound（repo 删除/转私有），不抛 —— 单个 repo 不该拖垮整轮", async () => {
    stub(() => new Response("{}", { status: 404 }));
    const r = await listReleases("tok", "o/gone", null);
    expect(r.notFound).toBe(true);
    expect(r.releases).toBeNull();
  });

  it("403 且 x-ratelimit-remaining=0 标 rateLimited；403 但余额非 0 标 notFound（无权访问）", async () => {
    stub(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    expect((await listReleases("tok", "o/r", null)).rateLimited).toBe(true);

    vi.unstubAllGlobals();
    stub(() => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "42" } }));
    const r = await listReleases("tok", "o/r", null);
    expect(r.rateLimited).toBe(false);
    expect(r.notFound).toBe(true);
  });

  it("403 + Retry-After（二级限流）也标 rateLimited，即使 x-ratelimit-remaining > 0", async () => {
    stub(() => new Response("{}", { status: 403, headers: { "Retry-After": "60", "x-ratelimit-remaining": "42" } }));
    const r = await listReleases("tok", "o/r", null);
    expect(r.rateLimited).toBe(true);
    expect(r.notFound).toBe(false);
  });

  it("429 也算 rateLimited", async () => {
    stub(() => new Response("{}", { status: 429 }));
    expect((await listReleases("tok", "o/r", null)).rateLimited).toBe(true);
  });
});

describe("getRepo", () => {
  it("404 返 notFound（repo 删除/无权访问）", async () => {
    stub(() => new Response("{}", { status: 404 }));
    const r = await getRepo("tok", "o/gone");
    expect(r.notFound).toBe(true);
    expect(r.repo).toBeNull();
    expect(r.rateLimited).toBe(false);
  });

  it("200 返回 repo 对象", async () => {
    stub(() => new Response(JSON.stringify({ id: 7, full_name: "o/r", stargazers_count: 42 }), { status: 200 }));
    const r = await getRepo("tok", "o/r");
    expect(r.repo).toMatchObject({ id: 7, stargazers_count: 42 });
    expect(r.rateLimited).toBe(false);
    expect(r.notFound).toBe(false);
  });

  it("403 + Retry-After（二级限流）标 rateLimited，caller 可据此决定是否降级发出内容", async () => {
    stub(() => new Response("{}", { status: 403, headers: { "Retry-After": "60" } }));
    const r = await getRepo("tok", "o/r");
    expect(r.rateLimited).toBe(true);
    expect(r.repo).toBeNull();
    expect(r.notFound).toBe(false);
  });
});
