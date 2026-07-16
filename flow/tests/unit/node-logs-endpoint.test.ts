import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryNodeLogRows } from "../../src/index";

function mockR2Response(rows: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ success: true, result: { rows } }), { status: 200 });
}

describe("queryNodeLogRows", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function baseEnv() {
    return { CF_ACCOUNT_ID: "acct-1", R2_SQL_TOKEN: "tok-1", R2_BUCKET: "uniscrm-dev", R2_WAREHOUSE: "acct-1_uniscrm-dev" } as any;
  }

  it("queries uniscrm.flow_log filtered by tenant/flow/node/direction=enter, ordered and limited", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ user_id: "u1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");

    expect(rows).toEqual([{ subjectId: "u1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.flow_log");
    expect(body.query).toContain("tenant_id = 42");
    expect(body.query).toContain("flow_id = 'flow-1'");
    expect(body.query).toContain("node_id = 'node-1'");
    expect(body.query).toContain("direction = 'enter'");
    expect(body.query).toContain("ORDER BY created_at DESC");
    expect(body.query).toContain("LIMIT 50");
  });

  it("queries uniscrm.content_flow_log with content_id as the subject column", async () => {
    fetchMock.mockResolvedValue(mockR2Response([{ content_id: "c1", created_at: "2026-01-01T00:00:00.000Z" }]));

    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.content_flow_log", "content_id", 42, "flow-2", "node-2");

    expect(rows).toEqual([{ subjectId: "c1", created_at: "2026-01-01T00:00:00.000Z" }]);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("FROM uniscrm.content_flow_log");
  });

  it("returns an empty array when the R2 query is unsuccessful", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const rows = await queryNodeLogRows(baseEnv(), "uniscrm.flow_log", "user_id", 42, "flow-1", "node-1");
    expect(rows).toEqual([]);
  });
});
