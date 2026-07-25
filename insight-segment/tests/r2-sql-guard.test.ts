import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { checkR2SqlToken } from "../src/index";

// R2_CATALOG_TOKEN is the repo-level R2 Data Catalog token analytics already uses for R2 SQL
// queries and PyIceberg compaction; insight-segment declares it in its own .secrets.json (like
// link and flow) so it is CI-managed via both deploy workflows' sync-secrets job. That doesn't
// make a missing/misconfigured secret impossible on a given worker deploy, so this guard stays:
// it fires before r2Query ever sends `Bearer undefined`, naming the actual cause instead of a
// generic 401.

describe("checkR2SqlToken", () => {
  it("fails when R2_CATALOG_TOKEN is missing, naming the secret", () => {
    const result = checkR2SqlToken({ R2_CATALOG_TOKEN: "" } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("R2_CATALOG_TOKEN");
  });

  it("fails when R2_CATALOG_TOKEN is undefined", () => {
    const result = checkR2SqlToken({} as any);
    expect(result.ok).toBe(false);
  });

  it("passes when R2_CATALOG_TOKEN is set", () => {
    expect(checkR2SqlToken({ R2_CATALOG_TOKEN: "tok-1" } as any)).toEqual({ ok: true });
  });
});

describe("R2-SQL-calling routes fail loudly (500, naming R2_CATALOG_TOKEN) instead of sending Bearer undefined", () => {
  afterEach(() => vi.unstubAllGlobals());

  function baseEnv(overrides: Record<string, unknown> = {}) {
    return {
      WEB_URL: "https://web.test",
      CF_ACCOUNT_ID: "acct-1",
      R2_BUCKET: "uniscrm-dev",
      R2_WAREHOUSE: "acct-1_uniscrm-dev",
      // R2_CATALOG_TOKEN deliberately omitted
      WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }) }) },
      AI: {},
      ASSETS: undefined,
      ...overrides,
    } as any;
  }

  function authedFetchMock(extra?: (url: string, init?: any) => Response | undefined) {
    return vi.fn(async (url: string, init?: any) => {
      if (String(url).includes("/api/auth/me")) {
        return new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "7" } }), { status: 200 });
      }
      const custom = extra?.(url, init);
      if (custom) return custom;
      throw new Error(`unexpected fetch call in test: ${url}`);
    });
  }

  it("POST /api/segments/preview: 500 naming R2_CATALOG_TOKEN, and never reaches r2Query", async () => {
    const fetchMock = authedFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request("https://insight-segment.test/api/segments/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "session=x" },
      body: JSON.stringify({ nl_query: "followers > 100" }),
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("R2_CATALOG_TOKEN");
    // Only the /api/auth/me call happened — no r2-sql call, no AI-backed parse call.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://web.test/api/auth/me"]);
  });

  it("POST /api/segments/:id/compute: 500 naming R2_CATALOG_TOKEN, and never reaches r2Query", async () => {
    const fetchMock = authedFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const env = baseEnv({
      WEB_DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => (sql.startsWith("SELECT id, sql_query") ? { id: "seg-1", sql_query: "SELECT 1", conditions_json: "{}" } : null),
            all: async () => ({ results: [] }),
            run: async () => ({}),
          }),
        }),
      },
    });

    const req = new Request("https://insight-segment.test/api/segments/seg-1/compute", {
      method: "POST",
      headers: { Cookie: "session=x" },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("R2_CATALOG_TOKEN");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://web.test/api/auth/me"]);
  });

  it("does not block when R2_CATALOG_TOKEN is set (guard is transparent on the happy path)", async () => {
    const fetchMock = authedFetchMock((url) => {
      if (String(url).includes("r2-sql")) {
        return new Response(JSON.stringify({ result: { rows: [{ cnt: 0 }] } }), { status: 200 });
      }
      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);

    // Bypass the AI-backed NL parser (not this guard's concern) by hitting compute with a
    // pre-stored, already-valid sql_query/conditions_json instead of preview.
    const env = baseEnv({
      R2_CATALOG_TOKEN: "tok-1",
      WEB_DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            first: async () => (sql.startsWith("SELECT id, sql_query") ? { id: "seg-1", sql_query: "SELECT id FROM uniscrm.user", conditions_json: "{\"logic\":\"AND\",\"conditions\":[]}" } : null),
            all: async () => ({ results: [] }),
            run: async () => ({}),
            batch: async () => ({}),
          }),
          batch: async () => ({}),
        }),
        batch: async (stmts: unknown[]) => ({}),
      },
    });

    const req = new Request("https://insight-segment.test/api/segments/seg-1/compute", {
      method: "POST",
      headers: { Cookie: "session=x" },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).not.toBe(500);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("r2-sql"))).toBe(true);
  });
});
