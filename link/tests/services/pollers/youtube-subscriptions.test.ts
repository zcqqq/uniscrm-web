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

// 真正状态化的 KV mock：与生产的 recordYouTubeQuota（读旧值 + units，写回新值）行为一致，
// 不同于「get 永远返回同一个值」的旧 mock —— 那种写法即使实现每次请求各记一次账也会凑巧
// 通过 Math.max 断言（两次都写 "1"，Math.max 仍是 1，不是 2），掩盖了「记了几次账」这个
// 真正要测的东西。这里改用状态化实现后，测试改为断言精确的调用次数与参数。
function createStatefulKV(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const get = vi.fn(async (key: string) => (key in store ? store[key] : null));
  const put = vi.fn(async (key: string, value: string) => { store[key] = value; });
  return { get, put, _store: store };
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

  it("按实际调用次数记配额（读调用 1 unit），且整轮只记账一次", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const kv = createStatefulKV();
    const env = { KV: kv } as any;

    await runYouTubeSubscriptionsPoller(baseCtx({ env }) as any);

    // 1 次 subscriptions.list + 1 次 channels.list = 2 units，绝不是 50 的倍数。
    // 且必须只有一次 KV 写入：YouTube 配额计数器是单个 key 的读-改-写，Cloudflare KV
    // 对同一个 key 有每秒 1 次写入的限流，按请求各记一次账在订阅量大的账号上会直接
    // 撞到这个限流；断言精确次数/参数而不是 Math.max，因为 Math.max 对「记了两次、
    // 每次都是 1」和「只记一次、值是 2」这两种截然不同的实现给出相同结果。
    const quotaPuts = kv.put.mock.calls.filter((c) => String(c[0]).startsWith("yt_quota:"));
    expect(quotaPuts).toHaveLength(1);
    expect(quotaPuts[0][1]).toBe("2");
  });

  // Critical：channels.list 对已删除/终止/地区屏蔽的订阅频道会缄默地漏掉该 id（整体仍是
  // 200），而不是报错。取消订阅的判定必须以 subscriptions.list 的权威结果（walk.ids）
  // 为准，绝不能以「channels.list 这次描述出了哪些 id」为准 —— 否则这类频道会被误判为
  // 取消订阅并置 is_follow=0。
  it("channels.list 对某个仍在订阅的 id 缄默时，该 id 不会被误判为取消订阅", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1", "UC2"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const tenantDb = createMockTenantDb(
      { UC2: { id: "stored-uc2", created_at: "2026-07-01T00:00:00.000Z", is_follow: 1, is_followed: 0 } },
      [{ source_user_id: "UC1" }, { source_user_id: "UC2" }]
    );

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    // UC2 从未出现在 channels.list 的结果里，但它仍在权威订阅列表（walk.ids）中，
    // 不能被 diff 当成取消订阅去写 is_follow=0。
    const touchedUC2 = tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC2"));
    expect(touchedUC2).toBe(false);
  });

  // Important 1 floor guard：即使权威走查号称完整（complete: true），如果它权威地报告
  // 「订阅数为 0」而 D1 里还有一堆 is_follow=1 的行，这个诊断信号本身就反常到应该被怀疑 ——
  // 一次性清空整个账号的关注状态是爆炸半径最大的错误，宁可这一轮跳过 diff。
  it("权威订阅列表为空但仍有频道 is_follow=1 时，跳过 diff 而不是清空整个账号", async () => {
    fetchMock.mockResolvedValueOnce(subsPage([]));
    const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC1" }, { source_user_id: "UC2" }]);

    await runYouTubeSubscriptionsPoller(baseCtx({ tenantDb }) as any);

    const touched = tenantDb.query.mock.calls.some(
      (c: any[]) => (c[1] as unknown[])?.includes?.("UC1") || (c[1] as unknown[])?.includes?.("UC2")
    );
    expect(touched).toBe(false);
  });

  // Important 2 + 3：某一个频道的 D1 写入抛错，既不能让整轮中止（否则这个账号会在
  // 每次 tick 上用同一行卡死），也不能让本轮已经花掉的配额漏记（finally 兜底）。
  it("某个频道 upsert 抛错时不中断其余频道处理，配额仍照常记账", async () => {
    fetchMock
      .mockResolvedValueOnce(subsPage(["UC1", "UC2"]))
      .mockResolvedValueOnce(channelsPage([MKBHD, { ...MKBHD, id: "UC2" }]));
    const kv = createStatefulKV();
    const env = { KV: kv } as any;

    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO user")) {
        const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
        if (params[cols.indexOf("source_user_id")] === "UC1") {
          throw new Error("simulated D1 write failure");
        }
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        return [{ id: row.id, created_at: row.created_at, is_follow: row.is_follow ?? 0, is_followed: row.is_followed ?? 0 }];
      }
      if (sql.includes("is_follow = 1")) return [];
      return [];
    });
    const tenantDb = { query, run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };

    await expect(runYouTubeSubscriptionsPoller(baseCtx({ tenantDb, env }) as any)).resolves.toBeUndefined();

    // UC2 仍然写成功，UC1 的失败没有拖垮整轮
    expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC2"))).toBe(true);
    // 1 次 subscriptions.list + 1 次 channels.list = 2 units，即使中途有一行写入抛错
    const quotaPuts = kv.put.mock.calls.filter((c) => String(c[0]).startsWith("yt_quota:"));
    expect(quotaPuts).toHaveLength(1);
    expect(quotaPuts[0][1]).toBe("2");
  });
});
