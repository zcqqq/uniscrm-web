import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { tmsXUsageRoute } from "../../src/routes/tms-x-usage";

const SAMPLE = {
  data: {
    cap_reset_day: 12,
    project_cap: 10000,
    project_id: "1234567890",
    project_usage: 4321,
    daily_project_usage: { project_id: 1234567890, usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }] },
    daily_client_app_usage: [
      { client_app_id: "app-1", usage_result_count: 1, usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }] },
    ],
  },
};

const baseEnv = { LINK_URL: "https://link-dev.uni-scrm.com", INTERNAL_SECRET: "dev-internal-secret" };

// caches.default 在 Node vitest 下不存在，路由会走无缓存分支；缓存命中/写入路径由
// 下面的 stubCaches 显式注入验证。
function makeApp() {
  const app = new Hono();
  app.get("/tms/api/x-usage", tmsXUsageRoute as never);
  return app;
}

function stubCaches(match: Response | undefined) {
  const put = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(match), put } });
  return put;
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /tms/api/x-usage", () => {
  it("proxies to link with the internal secret and returns the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeApp().request("/tms/api/x-usage?days=30", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://link-dev.uni-scrm.com/internal/x-usage?days=30");
    expect((init as RequestInit).headers).toMatchObject({ "X-Internal-Secret": "dev-internal-secret" });
  });

  it("defaults to 30 days", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await makeApp().request("/tms/api/x-usage", {}, baseEnv);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://link-dev.uni-scrm.com/internal/x-usage?days=30");
  });

  it("rejects days outside 1..90 without calling link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["0", "91", "abc", "7.5", "-3"]) {
      const res = await makeApp().request(`/tms/api/x-usage?days=${bad}`, {}, baseEnv);
      expect(res.status, `days=${bad}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through link's inner error and X's real upstream_status, keeping link's own status separate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "x_api_error", upstream_status: 429 }), { status: 502 })
    ));
    const res = await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_error", link_status: 502, upstream_status: 429 });
  });

  it("falls back to link_status as upstream_status when link's body isn't JSON (e.g. internalAuth's plain-text 403)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })));
    const res = await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_error", link_status: 403, upstream_status: 403 });
  });

  it("serves a cache hit without calling link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubCaches(new Response(JSON.stringify(SAMPLE), { headers: { "Content-Type": "application/json" } }));

    const res = await makeApp().request("/tms/api/x-usage?days=30", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(await res.json()).toEqual(SAMPLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes to the cache on a miss, keyed by days", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 })));
    const put = stubCaches(undefined);

    const res = await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(put).toHaveBeenCalledTimes(1);
    expect(String((put.mock.calls[0][0] as Request).url)).toBe("https://cache.internal/x-usage?days=7");
  });

  it("does not cache an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    const put = stubCaches(undefined);
    await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(put).not.toHaveBeenCalled();
  });
});
