import { describe, it, expect } from "vitest";
import { compactTable } from "../../src/index";

// The compactor's own stdout is unreachable (Cloudflare Container), so the compaction_runs
// row is the only evidence a run ever happened. These tests pin both halves: the row is
// claimed as 'running' before the container is called, and resolved to ok/error after.
type Stmt = { sql: string; params: unknown[] };

function fakeEnv(container: { startAndWaitForPorts?: () => Promise<void>; fetch: () => Promise<Response> }) {
  const stmts: Stmt[] = [];
  let requestBody: Record<string, unknown> | null = null;
  let fetchedAfter = -1;
  const env = {
    ANALYTICS_DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              run: async () => {
                stmts.push({ sql, params });
                return { meta: { last_row_id: 77 } };
              },
            };
          },
        };
      },
    },
    COMPACTOR_CONTAINER: {
      getByName: () => ({
        startAndWaitForPorts: container.startAndWaitForPorts ?? (async () => {}),
        fetch: async (_url: string, init?: { body?: string }) => {
          requestBody = init?.body ? JSON.parse(init.body) : null;
          fetchedAfter = stmts.length;
          return container.fetch();
        },
      }),
    },
    R2_CATALOG_URI: "https://catalog.example/uniscrm-dev",
    R2_WAREHOUSE: "wh",
    R2_CATALOG_TOKEN: "tok",
  } as never;

  const claim = () => stmts.find((s) => s.sql.includes("INSERT INTO compaction_runs"));
  const resolve = () => stmts.find((s) => s.sql.includes("UPDATE compaction_runs"));
  return { env, stmts, claim, resolve, body: () => requestBody, statementsBeforeFetch: () => fetchedAfter };
}

// UPDATE param order: status, rows_before, rows_after, duration_ms, error_message, id
const STATUS = 0, BEFORE = 1, AFTER = 2, ERR = 4, ID = 5;

const OK_BODY = JSON.stringify({ rows_before: 980, rows_after: 410, removed: 570 });

describe("compactTable", () => {
  it("claims a 'running' row before the container is called", async () => {
    const f = fakeEnv({ fetch: async () => new Response(OK_BODY, { status: 200 }) });

    await compactTable(f.env, "user");

    // Exactly one statement — the claim — had run before the container was reached. This
    // is what leaves evidence behind when the invocation is killed mid-compaction.
    expect(f.statementsBeforeFetch()).toBe(1);
    expect(f.claim()!.params).toEqual(["user", expect.any(String)]);
    expect(f.claim()!.sql).toContain("'running'");
  });

  it("resolves the claimed row to ok with the counts the container reported", async () => {
    const f = fakeEnv({ fetch: async () => new Response(OK_BODY, { status: 200 }) });

    await compactTable(f.env, "user");

    const r = f.resolve()!.params;
    expect(r[STATUS]).toBe("ok");
    expect(r[BEFORE]).toBe(980);
    expect(r[AFTER]).toBe(410);
    expect(r[ERR]).toBeNull();
    expect(r[ID]).toBe(77);
  });

  it("resolves to error, with the body, when the container returns non-2xx", async () => {
    const f = fakeEnv({ fetch: async () => new Response('{"error":"NoSuchTableError"}', { status: 500 }) });

    await compactTable(f.env, "user");

    expect(f.resolve()!.params[STATUS]).toBe("error");
    expect(f.resolve()!.params[ERR]).toContain("NoSuchTableError");
    expect(f.resolve()!.params[BEFORE]).toBeNull();
  });

  it("resolves to error when the container never starts", async () => {
    const f = fakeEnv({
      startAndWaitForPorts: async () => { throw new Error("container boot timeout"); },
      fetch: async () => new Response("{}", { status: 200 }),
    });

    await compactTable(f.env, "user");

    expect(f.resolve()!.params[STATUS]).toBe("error");
    expect(f.resolve()!.params[ERR]).toContain("container boot timeout");
  });

  it("sends key_columns only when the caller supplies them", async () => {
    const withKeys = fakeEnv({ fetch: async () => new Response("{}", { status: 200 }) });
    await compactTable(withKeys.env, "content", ["tenant_id", "channel_id", "list_id", "source_content_id"]);
    expect(withKeys.body()!.key_columns).toEqual(["tenant_id", "channel_id", "list_id", "source_content_id"]);
    expect(withKeys.body()!.table).toBe("content");

    const withoutKeys = fakeEnv({ fetch: async () => new Response("{}", { status: 200 }) });
    await compactTable(withoutKeys.env, "user");
    // Omitted so the container keeps its own user default rather than receiving undefined.
    expect("key_columns" in withoutKeys.body()!).toBe(false);
  });

  it("keeps the run as ok when the container returns an unparseable 200", async () => {
    const f = fakeEnv({ fetch: async () => new Response("not json", { status: 200 }) });

    await compactTable(f.env, "user");

    expect(f.resolve()!.params[STATUS]).toBe("ok");
    expect(f.resolve()!.params[ERR]).toContain("unparseable body");
  });
});
