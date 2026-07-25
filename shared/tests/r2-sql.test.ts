import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sqlStr, sqlInt, latestRowsSql, r2Query, R2SqlError } from "../r2-sql";

const ENV = {
  CF_ACCOUNT_ID: "acct1",
  R2_BUCKET: "uniscrm-dev",
  R2_WAREHOUSE: "wh_uniscrm-dev",
  R2_SQL_TOKEN: "tok1",
};

describe("sqlStr", () => {
  it("wraps in single quotes and doubles embedded quotes", () => {
    expect(sqlStr("o'brien")).toBe("'o''brien'");
  });

  it("rejects NUL bytes rather than emitting them", () => {
    expect(() => sqlStr("a\0b")).toThrow(/NUL/);
  });
});

describe("sqlInt", () => {
  it("renders a safe integer", () => {
    expect(sqlInt(42)).toBe("42");
  });

  it("rejects non-integers so nothing can smuggle SQL through a number field", () => {
    expect(() => sqlInt(1.5)).toThrow(/integer/);
    expect(() => sqlInt(NaN)).toThrow(/integer/);
  });
});

describe("latestRowsSql", () => {
  it("emits a QUALIFY window that keeps one row per business key", () => {
    const sql = latestRowsSql({
      table: "uniscrm.user",
      columns: ["id", "name"],
      partitionBy: ["channel_id", "source_user_id"],
      where: ["tenant_id = 7", "is_deleted = 0"],
      limit: 100,
    });
    expect(sql).toContain("SELECT id, name FROM uniscrm.user");
    expect(sql).toContain("WHERE tenant_id = 7 AND is_deleted = 0");
    expect(sql).toContain(
      "QUALIFY ROW_NUMBER() OVER (PARTITION BY channel_id, source_user_id ORDER BY updated_at DESC) = 1"
    );
    expect(sql).toContain("LIMIT 100");
  });

  it("refuses to build a query with no tenant_id filter (budget gate + tenant isolation)", () => {
    expect(() =>
      latestRowsSql({
        table: "uniscrm.user",
        columns: ["id"],
        partitionBy: ["channel_id", "source_user_id"],
        where: ["is_deleted = 0"],
      })
    ).toThrow(/tenant_id/);
  });
});

describe("r2Query", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rows on success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ result: { rows: [{ id: "u1" }] } }), { status: 200 })
    );
    const rows = await r2Query<{ id: string }>(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1");
    expect(rows).toEqual([{ id: "u1" }]);
  });

  it("throws R2SqlError on a non-2xx response instead of returning an empty list", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "80011: Unauthenticated" }), { status: 401 })
    );
    await expect(
      r2Query(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1")
    ).rejects.toBeInstanceOf(R2SqlError);
  });

  it("throws when the body carries an error even though HTTP status is 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: "40010: iceberg table not found" }), { status: 200 })
    );
    await expect(
      r2Query(ENV, "SELECT id FROM uniscrm.user WHERE tenant_id = 1")
    ).rejects.toThrow(/40010/);
  });
});
