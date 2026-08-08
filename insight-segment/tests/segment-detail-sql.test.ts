import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

// The segment detail page renders `segment.sql_query`, and compute executes SQL rebuilt from
// conditions_json — two truths, one of which (the stored sql_query column) went stale whenever
// buildSegmentQuery changed. The column is legacy now: never written on create, and the detail
// route derives sql_query fresh from conditions_json, so what the user sees is exactly what
// compute will run.

function makeEnv(segmentRow: Record<string, unknown> | null) {
  return {
    WEB_URL: "https://web.test",
    CF_ACCOUNT_ID: "acct-1",
    R2_BUCKET: "uniscrm-dev",
    R2_WAREHOUSE: "acct-1_uniscrm-dev",
    R2_CATALOG_TOKEN: "tok-1",
    WEB_DB: {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () =>
            sql.includes("FROM sessions")
              ? { member_id: "m1", tenant_id: 7, email: "m1@example.com", language: "en" }
              : sql.includes("FROM segments")
                ? segmentRow
                : null,
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      }),
    },
    AI: {},
    ASSETS: undefined,
  } as any;
}

function req(path: string) {
  return new Request(`https://insight-segment.test${path}`, { headers: { Cookie: "session=x" } });
}

describe("GET /api/segments/:id — sql_query is derived from conditions_json, not the stored column", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the freshly derived SQL and ignores a stale stored sql_query", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      throw new Error(`unexpected fetch call in test: ${url}`);
    }));

    const res = await worker.fetch(
      req("/api/segments/seg-1"),
      makeEnv({
        id: "seg-1",
        name: "big accounts",
        sql_query: "SELECT stale FROM old_shape -- MUST NOT be served",
        conditions_json: JSON.stringify({
          logic: "AND",
          conditions: [{ field: "followers_count", operator: ">", value: 100 }],
        }),
        status: "ready",
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { segment: { sql_query: string } };
    // Derived, current shape: the QUALIFY dedup subquery with the condition post-dedup.
    expect(body.segment.sql_query).toContain("QUALIFY ROW_NUMBER()");
    expect(body.segment.sql_query).toContain("u.followers_count > 100");
    expect(body.segment.sql_query).toContain("tenant_id = 7");
    expect(body.segment.sql_query).not.toContain("stale");
  });

  it("returns an empty sql_query (not the stale stored one) when conditions_json cannot be rebuilt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      throw new Error(`unexpected fetch call in test: ${url}`);
    }));

    const res = await worker.fetch(
      req("/api/segments/seg-broken"),
      makeEnv({
        id: "seg-broken",
        sql_query: "SELECT stale FROM old_shape",
        conditions_json: "{not json",
        status: "ready",
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { segment: { sql_query: string } };
    expect(body.segment.sql_query).toBe("");
  });
});
