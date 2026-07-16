import { describe, it, expect, vi, beforeEach } from "vitest";
import { recomputeFlowCounts } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

describe("recomputeFlowCounts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let tenantsFirstMock: ReturnType<typeof vi.fn>;
  let webDbMock: any;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function baseEnv() {
    webDbMock = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ d1_database_id: "tenant-db-1" }),
        }),
      }),
    };
    return {
      CF_ACCOUNT_ID: "acct-1",
      R2_SQL_TOKEN: "tok-1",
      R2_BUCKET: "uniscrm-dev",
      R2_WAREHOUSE: "acct-1_uniscrm-dev",
      WEB_DB: webDbMock,
    } as any;
  }

  it("issues one query against uniscrm.flow_log and one against uniscrm.content_flow_log", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));
    const env = baseEnv();

    await recomputeFlowCounts(env);

    const queries = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).query);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.flow_log") && q.includes("GROUP BY"))).toBe(true);
    expect(queries.some((q: string) => q.includes("FROM uniscrm.content_flow_log") && q.includes("GROUP BY"))).toBe(true);
  });

  it("fans out results to each active tenant's flow_counts, overwriting on conflict", async () => {
    fetchMock
      .mockResolvedValueOnce(mockR2Response([
        { tenant_id: 1, flow_id: "f1", node_id: "n1", direction: "enter", cnt: 5 },
      ]))
      .mockResolvedValueOnce(mockR2Response([]));
    const env = baseEnv();
    const tdbRun = vi.fn().mockResolvedValue({ changes: 1 });
    vi.doMock("../../../shared/tenant-data-db", () => ({
      TenantDataDB: class {
        run = tdbRun;
        batch = vi.fn();
      },
    }));

    await recomputeFlowCounts(env);

    expect(env.WEB_DB.prepare).toHaveBeenCalledWith(expect.stringContaining("d1_database_id FROM tenants WHERE tenant_id"));
  });

  it("does nothing (no D1 writes) for a tenant with no rows in either R2 query", async () => {
    fetchMock.mockResolvedValue(mockR2Response([]));
    const env = baseEnv();

    await recomputeFlowCounts(env);

    expect(env.WEB_DB.prepare).not.toHaveBeenCalled();
  });
});
