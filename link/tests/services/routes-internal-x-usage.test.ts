import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

const testSecret = "test-internal-secret";
const testEnv = { ...env, INTERNAL_SECRET: testSecret, X_BEARER_TOKEN: "test-bearer" };

const SAMPLE = {
  data: {
    cap_reset_day: 12,
    project_cap: 10000,
    project_id: "1234567890",
    project_usage: 4321,
    daily_project_usage: {
      project_id: 1234567890,
      usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }],
    },
    daily_client_app_usage: [
      {
        client_app_id: "app-1",
        usage_result_count: 1,
        usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }],
      },
    ],
  },
};

function req(path: string, headers: Record<string, string> = { "X-Internal-Secret": testSecret }) {
  return new Request(`https://link-dev.uni-scrm.com${path}`, { headers });
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /internal/x-usage", () => {
  it("rejects a request without the internal secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage", {}), testEnv);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects days outside 1..90 and non-integers without calling X", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["0", "91", "abc", "7.5", "-3"]) {
      const res = await worker.fetch(req(`/internal/x-usage?days=${bad}`), testEnv);
      expect(res.status, `days=${bad}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls X with the bearer token and the full usage.fields list, and returns data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/internal/x-usage?days=30"), testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: SAMPLE.data });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const u = new URL(String(calledUrl));
    expect(u.origin + u.pathname).toBe("https://api.x.com/2/usage/tweets");
    expect(u.searchParams.get("days")).toBe("30");
    expect(u.searchParams.get("usage.fields")).toBe(
      "cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage"
    );
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-bearer" });
  });

  it("defaults to 30 days when days is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage"), testEnv);
    expect(res.status).toBe(200);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("days")).toBe("30");
  });

  it("maps an X 429 to 502 with upstream_status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_error", upstream_status: 429 });
  });

  it("maps an X 401 to 502 with upstream_status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_error", upstream_status: 401 });
  });

  it("returns 500 when X_BEARER_TOKEN is unset, without calling X", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage?days=7"), { ...testEnv, X_BEARER_TOKEN: "" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "x_bearer_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 200 with unparseable body to 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_bad_json", upstream_status: 200 });
  });

  it("maps a 200 with no data field to 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ title: "boom" }] }), { status: 200 })
    ));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_no_data", upstream_status: 200 });
  });
});
