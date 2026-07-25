import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { checkR2SqlToken } from "../src/index";

// I2 (final review): R2_SQL_TOKEN is bound but declared in no wrangler.toml var, no
// .secrets.json, and neither deploy workflow's sync-secrets env — it is hand-set per worker
// today (see .superpowers/sdd/2026-07-25-tenant-db-removal/progress.md's "R2_SQL_TOKEN is not
// CI-managed" note). Adding it to insight-segment/.secrets.json breaks CI
// (scripts/secrets-sync.test.mjs), so the deliberate fix here is a loud, early guard instead —
// this file pins that the guard actually fires before r2Query ever sends `Bearer undefined`.

describe("checkR2SqlToken", () => {
  it("fails when R2_SQL_TOKEN is missing, naming the secret", () => {
    const result = checkR2SqlToken({ R2_SQL_TOKEN: "" } as any);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("R2_SQL_TOKEN");
  });

  it("fails when R2_SQL_TOKEN is undefined", () => {
    const result = checkR2SqlToken({} as any);
    expect(result.ok).toBe(false);
  });

  it("passes when R2_SQL_TOKEN is set", () => {
    expect(checkR2SqlToken({ R2_SQL_TOKEN: "tok-1" } as any)).toEqual({ ok: true });
  });
});

describe("R2-SQL-calling routes fail loudly (500, naming R2_SQL_TOKEN) instead of sending Bearer undefined", () => {
  afterEach(() => vi.unstubAllGlobals());

  function baseEnv(overrides: Record<string, unknown> = {}) {
    return {
      WEB_URL: "https://web.test",
      CF_ACCOUNT_ID: "acct-1",
      R2_BUCKET: "uniscrm-dev",
      R2_WAREHOUSE: "acct-1_uniscrm-dev",
      // R2_SQL_TOKEN deliberately omitted
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

  it("POST /api/segments/preview: 500 naming R2_SQL_TOKEN, and never reaches r2Query", async () => {
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
    expect(body.error).toContain("R2_SQL_TOKEN");
    // Only the /api/auth/me call happened — no r2-sql call, no AI-backed parse call.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://web.test/api/auth/me"]);
  });

  it("POST /api/segments/:id/compute: 500 naming R2_SQL_TOKEN, and never reaches r2Query", async () => {
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
    expect(body.error).toContain("R2_SQL_TOKEN");
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://web.test/api/auth/me"]);
  });

  it("does not block when R2_SQL_TOKEN is set (guard is transparent on the happy path)", async () => {
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
      R2_SQL_TOKEN: "tok-1",
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
