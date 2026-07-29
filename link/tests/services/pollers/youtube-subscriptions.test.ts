import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runYouTubeSubscriptionsPoller } from "../../../src/services/pollers/youtube-subscriptions";

function createMockLinkDb() {
  const runs: { sql: string; params: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...params: unknown[]) => ({
      run: vi.fn().mockImplementation(async () => { runs.push({ sql, params }); return { success: true }; }),
    })),
  }));
  return { prepare, _runs: runs };
}

// 与 x-followers.test.ts 的 mock 同构：INSERT INTO user 回一行（模拟 RETURNING），
// 其余 SELECT 按 existingBySourceId 返回既有行；is_follow = 1 那条专为本 poller 的
// 取消订阅 diff 查询新增。
function createMockTenantDb(
  existingBySourceId: Record<string, Record<string, unknown>> = {},
  followRows: { source_user_id: string }[] = []
) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO user")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      const prior = existingBySourceId[String(row.source_user_id)];
      return [{
        id: prior ? prior.id : row.id,
        created_at: prior ? prior.created_at : row.created_at,
        is_follow: row.is_follow ?? prior?.is_follow ?? 0,
        is_followed: row.is_followed ?? prior?.is_followed ?? 0,
      }];
    }
    // 取消订阅 diff 用的那条查询
    if (sql.includes("is_follow = 1")) return followRows;
    const prior = existingBySourceId[String(params[1])];
    return prior ? [prior] : [];
  });
  return { query, run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };
}

function createMockEntityState() {
  return { ensureEntity: vi.fn().mockResolvedValue(undefined), setFollow: vi.fn().mockResolvedValue(undefined) };
}

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    env: { KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) } } as any,
    accountChannelId: "acct-1",
    accessToken: "tok",
    linkDb: createMockLinkDb() as any,
    tenantDb: createMockTenantDb() as any,
    entityState: createMockEntityState() as any,
    tenantId: 42,
    pipelineUser: undefined,
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

function subsPage(ids: string[], nextPageToken?: string) {
  return new Response(JSON.stringify({
    items: ids.map((id) => ({ snippet: { resourceId: { channelId: id } } })),
    nextPageToken,
  }), { status: 200 });
}

function channelsPage(items: Record<string, unknown>[]) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

const MKBHD = {
  id: "UC1",
  snippet: { title: "Marques Brownlee", customUrl: "@mkbhd", description: "tech",
             thumbnails: { default: { url: "https://img/1.jpg" } }, country: "US" },
  statistics: { subscriberCount: "19500000", videoCount: "1680", viewCount: "4321000000", hiddenSubscriberCount: false },
};

describe("runYouTubeSubscriptionsPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  function insertOf(tenantDb: any) {
    const call = tenantDb.query.mock.calls.find((c: any[]) => String(c[0]).includes("INSERT INTO user"))!;
    const sql = String(call[0]);
    const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s: string) => s.trim());
    const params = call[1] as unknown[];
    return { sql, get: (col: string) => params[cols.indexOf(col)] };
  }

  it("把订阅频道写成 channel_type=YOUTUBE 的 user 行，字段按 metadata 映射", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.get("source_user_id")).toBe("UC1");
    expect(ins.get("channel_type")).toBe("YOUTUBE");
    expect(ins.get("name")).toBe("Marques Brownlee");
    expect(ins.get("username")).toBe("@mkbhd");
    expect(ins.get("profile_image_url")).toBe("https://img/1.jpg");
    expect(ins.get("is_follow")).toBe(1);
  });

  // subscriberCount / videoCount 是 API 返回的字符串，D1 列是 INT。
  it("followers_count / post_count 存为数值而不是字符串", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.get("followers_count")).toBe(19500000);
    expect(ins.get("post_count")).toBe(1680);
  });

  // 不知道 ≠ 是零。
  it("hiddenSubscriberCount 的频道不写 followers_count（保持 null，不写 0）", async () => {
    const hidden = { ...MKBHD, statistics: { videoCount: "12", viewCount: "1", hiddenSubscriberCount: true } };
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([hidden]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const ins = insertOf(tenantDb);
    expect(ins.sql).not.toContain("followers_count");
    expect(ins.get("post_count")).toBe(12);
  });

  it("未映射的 viewCount / country 落进 raw_data，已映射的不重复存", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const raw = JSON.parse(String(insertOf(tenantDb).get("raw_data")));
    expect(raw.statistics.viewCount).toBe("4321000000");
    expect(raw.snippet.country).toBe("US");
    expect(raw.statistics.subscriberCount).toBeUndefined();
    expect(raw.snippet.title).toBeUndefined();
  });

  it("120 个订阅分成 3 批 channels.list", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `UC${i}`);
    fetchMock
      .mockResolvedValueOnce(subsPage(ids))
      .mockResolvedValueOnce(channelsPage([]))
      .mockResolvedValueOnce(channelsPage([]))
      .mockResolvedValueOnce(channelsPage([]));

    await runYouTubeSubscriptionsPoller(baseCtx() as any);

    const channelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"));
    expect(channelCalls).toHaveLength(3);
    expect(String(channelCalls[0][0]).split("id=")[1].split("&")[0].split("%2C")).toHaveLength(50);
    expect(String(channelCalls[2][0]).split("id=")[1].split("&")[0].split("%2C")).toHaveLength(20);
  });

  it("没有 channel_poll_state 行时自播种，并更新 last_polled_at", async () => {
    fetchMock.mockResolvedValueOnce(subsPage([])).mockResolvedValue(channelsPage([]));
    const linkDb = createMockLinkDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ linkDb }) as any);

    expect(linkDb._runs.some((r) => r.sql.includes("INSERT OR IGNORE INTO channel_poll_state"))).toBe(true);
    expect(linkDb._runs.some((r) => r.sql.includes("last_polled_at = datetime('now')"))).toBe(true);
  });

  it("消失的频道置 is_follow = 0，行不删除", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb(
      { UC_GONE: { id: "stored-gone", created_at: "2026-07-01T00:00:00.000Z", is_follow: 1, is_followed: 0 } },
      [{ source_user_id: "UC1" }, { source_user_id: "UC_GONE" }]
    );

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const unfollow = tenantDb.query.mock.calls.find(
      (c: any[]) => String(c[0]).includes("INSERT INTO user") && (c[1] as unknown[]).includes("UC_GONE")
    );
    expect(unfollow).toBeTruthy();
    const sql = String(unfollow![0]);
    expect(sql).toContain("is_follow = excluded.is_follow");
    expect(sql).not.toContain("name = excluded.name");
    expect(tenantDb.query.mock.calls.every((c: any[]) => !String(c[0]).includes("DELETE"))).toBe(true);
  });

  // 本 plan 里最重要的一条：半份列表做 diff 会把仍在订阅的频道误置 is_follow = 0。
  it("subscriptions.list 中途失败时不做 diff", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1"], "p2"))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC1" }, { source_user_id: "UC_GONE" }]);

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const touchedGone = tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"));
    expect(touchedGone).toBe(false);
  });

  it("channels.list 某一批失败时跳过该批且不做 diff", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `UC${i}`);
    fetchMock
      .mockResolvedValueOnce(subsPage(ids))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC_GONE" }]);

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    // 第二批成功了，所以 UC1 被写入；但整轮不完整，UC_GONE 不能被置 0
    expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC1"))).toBe(true);
    expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
  });

  it("按实际调用次数记配额（读调用 1 unit）", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { KV: { get: vi.fn().mockResolvedValue("0"), put } } as any;

    await runYouTubeSubscriptionsPoller(baseCtx({ env }) as any);

    // 1 次 subscriptions.list + 1 次 channels.list = 2 units，绝不是 50 的倍数
    const written = put.mock.calls.filter((c) => String(c[0]).startsWith("yt_quota:")).map((c) => Number(c[1]));
    expect(Math.max(...written)).toBe(2);
  });
});
