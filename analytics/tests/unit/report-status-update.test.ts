import { describe, it, expect } from "vitest";
import { handleQueueMessage } from "../../src/index";

// Records every statement handleQueueMessage prepares, so the test can assert on what a
// report row looks like after a run rather than on the query text alone.
function fakeEnv(containerData: unknown[] = [{ value: 3 }]) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const env = {
    ANALYTICS_DB: {
      prepare(sql: string) {
        const record = { sql, params: [] as unknown[] };
        statements.push(record);
        return {
          bind(...params: unknown[]) {
            record.params = params;
            return { run: async () => ({}) };
          },
        };
      },
    },
    ANALYTICS_CONTAINER: {
      getByName() {
        return {
          startAndWaitForPorts: async () => {},
          fetch: async () => new Response(JSON.stringify({ data: containerData }), { status: 200 }),
        };
      },
    },
    R2_CATALOG_TOKEN: "test-token",
  } as never;
  return { env, statements };
}

const MSG = {
  report_id: "r1",
  type: "user",
  params: { measure: "count" },
  tenant_id: "1",
  warehouse: "test_warehouse",
} as never;

describe("handleQueueMessage", () => {
  it("clears error_message when a report succeeds", async () => {
    const { env, statements } = fakeEnv();
    await handleQueueMessage(MSG, env);

    const ready = statements.find((s) => s.sql.includes("status = 'ready'"));
    expect(ready).toBeDefined();
    // The cron re-queue only resets status to 'pending'; without this the previous run's
    // failure text survives a successful recompute and the UI shows it beside fresh data.
    expect(ready!.sql).toContain("error_message = NULL");
  });

  it("marks the report computing before querying the container", async () => {
    const { env, statements } = fakeEnv();
    await handleQueueMessage(MSG, env);

    expect(statements[0].sql).toContain("status = 'computing'");
    expect(statements[0].params).toEqual(["r1"]);
  });

  it("stores results and the report id on the success write", async () => {
    const { env, statements } = fakeEnv([{ value: 2 }, { value: 5 }]);
    await handleQueueMessage(MSG, env);

    const ready = statements.find((s) => s.sql.includes("status = 'ready'"))!;
    const [resultsJson, reportId] = ready.params as [string, string];
    expect(reportId).toBe("r1");
    expect(JSON.parse(resultsJson).summary).toBe(7);
  });

  it("throws without writing a ready row when the container fails", async () => {
    const { env, statements } = fakeEnv();
    (env as never as { ANALYTICS_CONTAINER: { getByName: () => unknown } }).ANALYTICS_CONTAINER.getByName = () => ({
      startAndWaitForPorts: async () => {},
      fetch: async () => new Response("boom", { status: 500 }),
    });

    await expect(handleQueueMessage(MSG, env)).rejects.toThrow("Container query failed");
    expect(statements.find((s) => s.sql.includes("status = 'ready'"))).toBeUndefined();
  });
});
