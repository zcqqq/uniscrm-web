import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getUserDisplayNamesMixed, listUsers } from "../../src/services/r2-entities";

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

describe("listUsers", () => {
  it("filters is_deleted after the QUALIFY window, not in the pre-dedup WHERE", async () => {
    const fetchMock = stubR2([]);
    await listUsers(ENV, 7, 100);
    const q = sentQuery(fetchMock);
    expect(q.indexOf("is_deleted = 0")).toBeGreaterThan(q.indexOf("QUALIFY"));
  });
});

// list_users.user_id (link/src/routes-lists.ts) is a MIXED population: a uuid for UI-added
// members, an X numeric id for members flow's addToList action added — see this function's own
// doc comment in r2-entities.ts (final review I3) for why the now-deleted single-domain
// getUserDisplayNames's `id IN (...)` lookup left flow-added rows blank.
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
