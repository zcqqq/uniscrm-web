import { describe, it, expect, vi, afterEach } from "vitest";
import { listRecentTenantContent } from "../../src/services/tenant-content";

afterEach(() => vi.unstubAllGlobals());

const envWith = (d1: string | null) => ({
  CF_ACCOUNT_ID: "acct",
  CF_D1_API_TOKEN: "tok",
  WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => (d1 ? { d1_database_id: d1 } : null) }) }) },
}) as never;

describe("listRecentTenantContent", () => {
  // 新租户还没开库是常态，不是错误 —— 起草会退化成从白纸开始。
  it("租户没有 per-tenant 库时返回空数组，不抛错", async () => {
    expect(await listRecentTenantContent(envWith(null), 1)).toEqual([]);
  });

  it("按 created_at 倒序取，带 limit，映射成扁平结构", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: [{ results: [{ channel_type: "X", title: "T", content_text: "B" }] }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const rows = await listRecentTenantContent(envWith("db-1"), 42, 5);

    expect(rows).toEqual([{ channelType: "X", title: "T", contentText: "B" }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sql).toContain("ORDER BY created_at DESC");
    expect(body.params).toEqual([5]);
  });

  // 起草是"锦上添花"的信号来源，租户库抽风不该让整个起草端点 500。
  it("查询失败时返回空数组而不是抛错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 200 })
    ));
    expect(await listRecentTenantContent(envWith("db-1"), 42)).toEqual([]);
  });

  // WEB_DB 定位租户库这一步本身也可能抛错（D1_ERROR、瞬时绑定失败），
  // 不能只护住 db.query() —— 整个函数的承诺是永不抛错。
  it("WEB_DB 查询租户库时抛错，也返回空数组而不是抛错", async () => {
    const env = {
      CF_ACCOUNT_ID: "acct",
      CF_D1_API_TOKEN: "tok",
      WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR"); } }) }) },
    } as never;

    await expect(listRecentTenantContent(env, 1)).resolves.toEqual([]);
  });
});
