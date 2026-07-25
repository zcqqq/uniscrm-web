import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listContents, getContent, getUserNames } from "../../src/services/r2-entities";

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
});

describe("getUserNames", () => {
  it("returns an empty map without querying when given no ids", async () => {
    const fetchMock = stubR2([]);
    const map = await getUserNames(ENV, 7, []);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps id to name", async () => {
    stubR2([{ id: "u1", name: "Ann" }]);
    const map = await getUserNames(ENV, 7, ["u1"]);
    expect(map.get("u1")).toBe("Ann");
  });
});
