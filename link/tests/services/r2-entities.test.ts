import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listContents, getContent, getUserDisplayNames, listUsers } from "../../src/services/r2-entities";

const ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };

function stubR2(rows: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>): string {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string).query as string;
}

afterEach(() => vi.unstubAllGlobals());

describe("listContents", () => {
  it("filters by tenant, hides logically deleted rows, and keeps one row per business key", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7);
    const q = sentQuery(fetchMock);
    expect(q).toContain("tenant_id = 7");
    expect(q).toContain("is_deleted = 0");
    expect(q).toContain("PARTITION BY channel_id, list_id, source_content_id");
  });

  it("escapes channel_type instead of interpolating it raw", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7, "O'X");
    expect(sentQuery(fetchMock)).toContain("channel_type = 'O''X'");
  });

  // C1: is_deleted must be a post-dedup (outerWhere) filter, not folded into the pre-QUALIFY
  // WHERE — otherwise a deleted row's tombstone gets pruned before the window runs, and the
  // window falls back to the older pre-delete row (the delete becomes a permanent no-op).
  it("filters is_deleted after the QUALIFY window, not in the pre-dedup WHERE (C1)", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7);
    const q = sentQuery(fetchMock);
    const qualifyIdx = q.indexOf("QUALIFY");
    const outerFilterIdx = q.indexOf(") WHERE is_deleted = 0");
    expect(qualifyIdx).toBeGreaterThan(-1);
    expect(outerFilterIdx).toBeGreaterThan(qualifyIdx);
    // the pre-QUALIFY WHERE carries only tenant scoping (and channel_type when given)
    expect(q.slice(0, qualifyIdx)).not.toContain("is_deleted = 0");
  });

  // M2: source_updated_at is null on every poller-ingested row (nothing in
  // CONTENT_COLUMN_MAP maps to it), so ordering by it alone sorted most rows into one
  // undefined-order block.
  it("orders by COALESCE(source_updated_at, source_created_at, created_at) DESC", async () => {
    const fetchMock = stubR2([]);
    await listContents(ENV, 7);
    expect(sentQuery(fetchMock)).toContain(
      "ORDER BY COALESCE(source_updated_at, source_created_at, created_at) DESC"
    );
  });
});

describe("getContent", () => {
  it("returns null when no row matches", async () => {
    stubR2([]);
    expect(await getContent(ENV, 7, "c1")).toBeNull();
  });

  it("escapes the id", async () => {
    const fetchMock = stubR2([]);
    await getContent(ENV, 7, "a'b");
    expect(sentQuery(fetchMock)).toContain("id = 'a''b'");
  });

  // I1: getContent previously had no is_deleted filter at all, so callers reading through it
  // (e.g. a plain "show me this item" lookup) would render a deleted row as if it were live.
  it("filters out logically deleted rows by default, after the dedup window", async () => {
    const fetchMock = stubR2([]);
    await getContent(ENV, 7, "c1");
    const q = sentQuery(fetchMock);
    expect(q).toContain("is_deleted = 0");
    expect(q.indexOf("is_deleted = 0")).toBeGreaterThan(q.indexOf("QUALIFY"));
  });

  // I1: update()/delete() legitimately need to see a deleted row (to distinguish "not found"
  // from "found but deleted", and to let delete() be idempotent) — includeDeleted opts out of
  // the default filter for exactly those callers.
  it("includes logically deleted rows when includeDeleted is true, with no outer filter at all", async () => {
    const fetchMock = stubR2([]);
    await getContent(ENV, 7, "c1", { includeDeleted: true });
    const q = sentQuery(fetchMock);
    expect(q).not.toContain("is_deleted = 0");
    expect(q).not.toContain("FROM (");
  });
});

describe("listUsers", () => {
  it("filters is_deleted after the QUALIFY window, not in the pre-dedup WHERE", async () => {
    const fetchMock = stubR2([]);
    await listUsers(ENV, 7, 100);
    const q = sentQuery(fetchMock);
    expect(q.indexOf("is_deleted = 0")).toBeGreaterThan(q.indexOf("QUALIFY"));
  });
});

describe("getUserDisplayNames", () => {
  it("returns an empty map without querying when given no ids", async () => {
    const fetchMock = stubR2([]);
    const map = await getUserDisplayNames(ENV, 7, []);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps id to both name and username", async () => {
    stubR2([{ id: "u1", name: "Ann", username: "ann_x" }]);
    const map = await getUserDisplayNames(ENV, 7, ["u1"]);
    expect(map.get("u1")).toEqual({ name: "Ann", username: "ann_x" });
  });

  it("selects username, not just name, in the R2 query", async () => {
    const fetchMock = stubR2([{ id: "u1", name: "Ann", username: "ann_x" }]);
    await getUserDisplayNames(ENV, 7, ["u1"]);
    const q = sentQuery(fetchMock);
    expect(q).toContain("username");
  });

  it("filters out logically deleted users after the dedup window", async () => {
    const fetchMock = stubR2([{ id: "u1", name: "Ann", username: "ann_x" }]);
    await getUserDisplayNames(ENV, 7, ["u1"]);
    const q = sentQuery(fetchMock);
    expect(q.indexOf("is_deleted = 0")).toBeGreaterThan(q.indexOf("QUALIFY"));
  });
});
