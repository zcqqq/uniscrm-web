import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listContents, getContent, getUserDisplayNames, getUserDisplayNamesMixed, listUsers } from "../../src/services/r2-entities";

const ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_CATALOG_TOKEN: "t" };

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

// list_users.user_id (link/src/routes-lists.ts) is a MIXED population: a uuid for UI-added
// members, an X numeric id for members flow's addToList action added — see this function's own
// doc comment in r2-entities.ts (final review I3) for why getUserDisplayNames's single
// `id IN (...)` lookup left flow-added rows blank.
describe("getUserDisplayNamesMixed", () => {
  it("returns an empty map without querying when given no ids", async () => {
    const fetchMock = stubR2([]);
    const map = await getUserDisplayNamesMixed(ENV, 7, []);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries both id domains in one round trip", async () => {
    const fetchMock = stubR2([]);
    await getUserDisplayNamesMixed(ENV, 7, ["uuid-1", "x-42"]);
    const q = sentQuery(fetchMock);
    expect(q).toContain("id IN ('uuid-1', 'x-42')");
    expect(q).toContain("source_user_id IN ('uuid-1', 'x-42')");
    expect(q).toContain(" OR ");
  });

  it("resolves a uuid-keyed row by id and an X-id-keyed row by source_user_id in the same call", async () => {
    stubR2([
      { id: "uuid-1", source_user_id: "src-1", name: "Ann", username: "ann_x" },
      { id: "uuid-2", source_user_id: "x-42", name: "Bob", username: "bob_x" },
    ]);
    // "uuid-1" is a UI-added member (matches by id); "x-42" is a flow-added member (matches by
    // source_user_id, since it was never assigned uniscrm.user's uuid).
    const map = await getUserDisplayNamesMixed(ENV, 7, ["uuid-1", "x-42"]);
    expect(map.get("uuid-1")).toEqual({ name: "Ann", username: "ann_x" });
    expect(map.get("x-42")).toEqual({ name: "Bob", username: "bob_x" });
  });

  it("prefers an id match over a source_user_id match for the same requested value", async () => {
    // A pathological row where one user's id equals another user's source_user_id — the id match
    // must win, since `id` is the stable, collision-free identity.
    stubR2([
      { id: "shared-1", source_user_id: "unrelated", name: "IdMatch", username: "id_match" },
      { id: "other", source_user_id: "shared-1", name: "SourceMatch", username: "source_match" },
    ]);
    const map = await getUserDisplayNamesMixed(ENV, 7, ["shared-1"]);
    expect(map.get("shared-1")).toEqual({ name: "IdMatch", username: "id_match" });
  });

  it("leaves a requested id unresolved (absent from the map) when neither domain matches", async () => {
    stubR2([]);
    const map = await getUserDisplayNamesMixed(ENV, 7, ["nope"]);
    expect(map.has("nope")).toBe(false);
  });
});
