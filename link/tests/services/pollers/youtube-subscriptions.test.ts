import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runYouTubeSubscriptionsPoller } from "../../../src/services/pollers/youtube-subscriptions";

// state = channel_poll_state 里已有的行（poller 只 SELECT cursor 一列做断点续跑）。
function createMockLinkDb(state: { cursor: string | null } | null = null) {
  const runs: { sql: string; params: unknown[] }[] = [];
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: vi.fn().mockImplementation((...params: unknown[]) => ({
      first: vi.fn().mockResolvedValue(state),
      run: vi.fn().mockImplementation(async () => { runs.push({ sql, params }); return { success: true }; }),
    })),
  }));
  return { prepare, _runs: runs };
}

// channel_poll_state 的那条收尾 UPDATE（cursor + last_polled_at 同一条语句）。
function stateWriteOf(linkDb: { _runs: { sql: string; params: unknown[] }[] }) {
  return linkDb._runs.find((r) => r.sql.includes("UPDATE channel_poll_state SET cursor"));
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

  it("跑完一整轮后把 cursor 清成 NULL（重新受 23h 节流管辖）", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const linkDb = createMockLinkDb();
    await runYouTubeSubscriptionsPoller(baseCtx({ linkDb }) as any);

    expect(stateWriteOf(linkDb)!.params[0]).toBeNull();
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

  // Important 2：last_polled_at 是 23h 节流的唯一依据。它原来写在函数末尾且没有 finally，
  // 走查之后任何一处抛出都会让它停住，于是每小时的 cron 都判定「从没跑过」并全量走查一次 ——
  // 24 倍于设计值地消耗一个整个 GCP 项目共享的配额池，而且是持续的失效开放。
  it("diff 的 SELECT 抛错时，last_polled_at 仍然写入", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const linkDb = createMockLinkDb();
    const tenantDb = createMockTenantDb();
    const inner = tenantDb.query;
    // 老租户库缺列时这条 SELECT 真的会抛（本轮 review 的 Important 2 场景）。
    tenantDb.query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("is_follow = 1")) throw new Error("no such column: is_follow");
      return inner(sql, params);
    }) as any;

    await expect(runYouTubeSubscriptionsPoller(baseCtx({ linkDb, tenantDb }) as any)).rejects.toThrow();

    const write = stateWriteOf(linkDb);
    expect(write).toBeTruthy();
    expect(write!.sql).toContain("last_polled_at = datetime('now')");
  });

  // 同上：配额记账在 finally 里，KV 写失败（同 key 每秒 1 次的限流真的会打到）不能顶替
  // 掉真正的根因、更不能把 last_polled_at 的写入整个跳过。
  it("配额记账 KV 失败时不逃逸，也不阻断 last_polled_at 的写入", async () => {
    fetchMock.mockResolvedValueOnce(subsPage(["UC1"])).mockResolvedValueOnce(channelsPage([MKBHD]));
    const linkDb = createMockLinkDb();
    const env = {
      KV: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockRejectedValue(new Error("KV rate limited")) },
    } as any;

    await expect(runYouTubeSubscriptionsPoller(baseCtx({ linkDb, env }) as any)).resolves.toBeUndefined();

    expect(stateWriteOf(linkDb)!.sql).toContain("last_polled_at = datetime('now')");
  });

  // Important 1：20s 的 per-channel 预算下，大账号一轮跑不完全部批次。没有 cursor 的旧实现
  // 每轮都从 walk.ids[0] 重来，永远跑不到列表末尾 —— 取消订阅的 diff 因此**永远不执行**，
  // 恰恰在最需要它的账号上静默失效。
  describe("断点续跑（channel_poll_state.cursor）", () => {
    const IDS_120 = Array.from({ length: 120 }, (_, i) => `UC${i}`);

    // 受控时钟：让「每批 channels.list + 写库」花掉真实感的时间，从而可确定地撞 deadline。
    function stubClock(startAt = 1_700_000_000_000) {
      let now = startAt;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      return { start: startAt, advance: (ms: number) => { now += ms; } };
    }
    afterEach(() => vi.restoreAllMocks());

    function idsOfChannelsCall(call: unknown[]): string[] {
      return decodeURIComponent(String(call[0]).split("id=")[1].split("&")[0]).split(",");
    }

    it("撞 deadline 时把批次起点写进 cursor，且本轮绝不 diff", async () => {
      const clock = stubClock();
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/subscriptions")) return subsPage(IDS_120);
        clock.advance(400); // 每批详情 + 写库 400ms
        return channelsPage(idsOfChannelsCall([u]).map((id) => ({ ...MKBHD, id })));
      });
      const linkDb = createMockLinkDb();
      // UC_GONE 在库里仍是 is_follow=1，且不在本次走查结果里 —— 只有跑完整轮才允许置 0。
      const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC0" }, { source_user_id: "UC_GONE" }]);

      await runYouTubeSubscriptionsPoller(baseCtx({
        linkDb, tenantDb, deadline: clock.start + 1000,
      }) as any);

      // 第三批（i=100）的详情已拉回，但写第一条之前时钟就越过了 deadline：
      // cursor 停在本批起点 100（不是 150），下一轮从这里续跑。
      const write = stateWriteOf(linkDb);
      expect(write!.params[0]).toBe("100");
      // 走查本身是完整的（subsPage 一页给全 120 个），但本轮没跑到尾 —— 绝不能 diff。
      expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
    });

    // Important（本轮修复）：零进度的一轮必须把 cursor 清成 NULL，而不是原样存下没有
    // 挪动过的下标（哪怕那个下标恰好是 "0"）。"0" 不携带任何续跑信息 —— parseCursor 对
    // NULL/空串/"0" 一视同仁地从下标 0 开始 —— 它唯一的效果是让 pollYouTubeChannel 的
    // resumePending 判断永久为真，从而永久关掉 23h 节流，把这个账号退化成每小时全量重跑，
    // 且没有任何自愈路径（每小时都撞同一堵墙，永远零进度）。这正是断点续跑机制本来要修的
    // fail-open 从另一个入口回来，量级比原来的 192 units/天/账号还大。
    it("批次循环一批都没处理完就撞 deadline 时，cursor 清成 NULL 而不是 \"0\"", async () => {
      const clock = stubClock();
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/subscriptions")) {
          // 走查本身在真实场景里也会占用时间：这一页拿全了 120 个订阅、complete=true，
          // 但耗时已经把预算的 1000ms 吃光了（deadline 检查只在分页 do-while 的页边界，
          // 单页走查不会再撞一次，所以 walk.complete 仍然是 true）。
          clock.advance(2000);
          return subsPage(IDS_120);
        }
        return channelsPage(idsOfChannelsCall([u]).map((id) => ({ ...MKBHD, id })));
      });
      const linkDb = createMockLinkDb();
      const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC_GONE" }]);

      await runYouTubeSubscriptionsPoller(baseCtx({
        linkDb, tenantDb, deadline: clock.start + 1000,
      }) as any);

      // 批次循环在 i=0（本轮的 startIndex）上第一次检查 deadline 就已经越过，一批
      // channels.list 都没发出、一行都没写。
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"))).toHaveLength(0);
      // 修复前：resumeIndex 停在初始值 0，finally 原样存 String(0) = "0"，
      // 之后每小时都会被 pollYouTubeChannel 当成「有断点续跑」而无视 23h 节流。
      // 修复后：resumeIndex(0) <= startIndex(0)，视为零进度，落成 NULL。
      expect(stateWriteOf(linkDb)!.params[0]).toBeNull();
      // 零进度这一轮当然也不能 diff。
      expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
    });

    // 同一形状不止发生在 0：已经带着断点续跑（startIndex = 100）的一轮如果同样一批都没
    // 推进，也必须清空 cursor，而不是把 "100" 原样存回去（那样和上面 "0" 的情形一样，
    // 会让这个账号永久跳过 23h 节流，卡在同一个断点上重复重跑）。
    it("已带断点续跑（startIndex > 0）但一批都没推进时，cursor 同样清成 NULL", async () => {
      const clock = stubClock();
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/subscriptions")) {
          clock.advance(2000); // 走查本身吃光预算，但仍然完整拿到 120 个
          return subsPage(IDS_120);
        }
        return channelsPage(idsOfChannelsCall([u]).map((id) => ({ ...MKBHD, id })));
      });
      const linkDb = createMockLinkDb({ cursor: "100" });
      const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC_GONE" }]);

      await runYouTubeSubscriptionsPoller(baseCtx({
        linkDb, tenantDb, deadline: clock.start + 1000,
      }) as any);

      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"))).toHaveLength(0);
      // 修复前：resumeIndex 停在 startIndex(100)，finally 原样存 "100" —— 和上一轮存的
      // 一模一样，账号从此每小时重跑同一个断点、23h 节流永久失效。
      // 修复后：resumeIndex(100) <= startIndex(100)，同样视为零进度，落成 NULL。
      expect(stateWriteOf(linkDb)!.params[0]).toBeNull();
      expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
    });

    it("下一轮从 cursor 续跑，跑完才做 diff（且 cursor 清空）", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/subscriptions")) return subsPage(IDS_120);
        return channelsPage(idsOfChannelsCall([u]).map((id) => ({ ...MKBHD, id })));
      });
      const linkDb = createMockLinkDb({ cursor: "100" });
      const tenantDb = createMockTenantDb(
        { UC_GONE: { id: "stored-gone", created_at: "2026-07-01T00:00:00.000Z", is_follow: 1, is_followed: 0 } },
        [{ source_user_id: "UC0" }, { source_user_id: "UC_GONE" }]
      );

      await runYouTubeSubscriptionsPoller(baseCtx({ linkDb, tenantDb }) as any);

      // 只补跑最后一批（20 个），不重头再来。
      const channelCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"));
      expect(channelCalls).toHaveLength(1);
      const ids = idsOfChannelsCall(channelCalls[0]);
      expect(ids).toHaveLength(20);
      expect(ids[0]).toBe("UC100");

      // 续跑跑到尾 = 一次完整通过：diff 这时才允许执行，依据是本轮现拉的 walk.ids。
      const unfollow = tenantDb.query.mock.calls.find(
        (c: any[]) => String(c[0]).includes("INSERT INTO user") && (c[1] as unknown[]).includes("UC_GONE")
      );
      expect(unfollow).toBeTruthy();
      expect(String(unfollow![0])).toContain("is_follow = excluded.is_follow");
      // Minor 1：UC0 在本轮现拉的 walk.ids 里（IDS_120 包含 UC0），diff 必须以完整的
      // walk.ids 为准而不是「续跑之后剩下的那一小段」——否则一个把 authoritative 集合
      // 建在续跑切片上的回归会把 UC0 也误判成取消订阅，而这里如果只断言 UC_GONE 被处理，
      // 那样的回归仍会通过。UC0 绝不能出现在任何一条 INSERT INTO user 调用的参数里。
      const touchedUC0 = tenantDb.query.mock.calls.some(
        (c: any[]) => String(c[0]).includes("INSERT INTO user") && (c[1] as unknown[]).includes("UC0")
      );
      expect(touchedUC0).toBe(false);
      // 跑完了 → cursor 清空 → 重新回到 23h 节流的节奏。
      expect(stateWriteOf(linkDb)!.params[0]).toBeNull();
    });

    it("cursor 越过列表末尾（期间大量退订）时不跳过 diff，也不重头重跑", async () => {
      fetchMock.mockResolvedValueOnce(subsPage(["UC1"]));
      const linkDb = createMockLinkDb({ cursor: "999" });
      const tenantDb = createMockTenantDb(
        { UC_GONE: { id: "stored-gone", created_at: "2026-07-01T00:00:00.000Z", is_follow: 1, is_followed: 0 } },
        [{ source_user_id: "UC1" }, { source_user_id: "UC_GONE" }]
      );

      await runYouTubeSubscriptionsPoller(baseCtx({ linkDb, tenantDb }) as any);

      // 没有可做的批次了（下标被夹到列表长度），但 walk.ids 是新鲜且完整的 —— 允许 diff。
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/channels?"))).toHaveLength(0);
      expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(true);
      expect(stateWriteOf(linkDb)!.params[0]).toBeNull();
    });

    it("走查中途失败时，即使有断点也不 diff", async () => {
      fetchMock
        .mockResolvedValueOnce(subsPage(["UC100"], "p2"))
        .mockResolvedValueOnce(new Response("boom", { status: 500 }));
      const linkDb = createMockLinkDb({ cursor: "100" });
      const tenantDb = createMockTenantDb({}, [{ source_user_id: "UC_GONE" }]);

      await runYouTubeSubscriptionsPoller(baseCtx({ linkDb, tenantDb }) as any);

      expect(tenantDb.query.mock.calls.some((c: any[]) => (c[1] as unknown[])?.includes?.("UC_GONE"))).toBe(false);
    });
  });
});
