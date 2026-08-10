import { describe, it, expect, vi, beforeEach } from "vitest";

const listReleasesMock = vi.fn();
const getRepoMock = vi.fn();
vi.mock("../../../src/services/github-api", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  listReleases: (...a: unknown[]) => listReleasesMock(...a),
  getRepo: (...a: unknown[]) => getRepoMock(...a),
}));

import { runGitHubReleasePoller, buildReleaseHistory, pollerNameFor } from "../../../src/services/pollers/github-releases";

const NOW = Date.parse("2026-08-10T00:00:00Z");

function rel(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, tag_name: "v1", name: "v1", body: "notes", html_url: "https://gh/r/v1",
    draft: false, prerelease: false,
    published_at: "2026-08-09T00:00:00Z", created_at: "2026-08-09T00:00:00Z",
    ...over,
  };
}

/** channel_poll_state 的最小假实现：记录写入、按需返回已有行。 */
function fakeLinkDb(row: Record<string, unknown> | null) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async run() { writes.push({ sql, binds }); return { success: true }; },
            async first() { return sql.startsWith("SELECT") ? row : null; },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, writes };
}

function fakeContentService() {
  const seen = new Set<string>();
  const emitted: Array<{ secondaryValue: string; props: Record<string, unknown> }> = [];
  // 让某几条 release 的 emit 抛错，用来验证一条失败不会连坐后面的。
  const failEmitFor = new Set<string>();
  return {
    emitted,
    failEmitFor,
    seenAll: (ids: string[]) => ids.forEach((i) => seen.add(i)),
    /** dedup 表里现在记着哪些 id —— seed 阶段「只记不发」的「记」必须能被断言到。 */
    seenIds: () => [...seen],
    service: {
      async recordTriggerContentSeen(_c: string, _s: string, id: string) {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
      async emitContentTriggerEvent(_c: string, _t: string, _f: string, secondaryValue: string, props: Record<string, unknown>) {
        if (failEmitFor.has(String(props.source_content_id))) throw new Error("queue send exploded");
        emitted.push({ secondaryValue, props });
      },
    },
  };
}

beforeEach(() => { listReleasesMock.mockReset(); getRepoMock.mockReset(); });

describe("buildReleaseHistory", () => {
  it("只留 30 天内、有 published_at 的条目，最多 100 条", () => {
    const h = buildReleaseHistory(
      [
        rel({ published_at: "2026-08-09T00:00:00Z" }),
        rel({ published_at: "2026-06-01T00:00:00Z" }),   // 30 天以外
        rel({ published_at: null }),                      // 无发布时间
        rel({ published_at: "2026-08-01T00:00:00Z", prerelease: true }),
      ] as never,
      NOW
    );
    expect(h).toEqual([
      { published_at: "2026-08-09T00:00:00Z", prerelease: false },
      { published_at: "2026-08-01T00:00:00Z", prerelease: true },
    ]);
  });
});

describe("pollerNameFor", () => {
  it("每个 repo 一行 poll state", () => {
    expect(pollerNameFor("oven-sh/bun")).toBe("github-releases:oven-sh/bun");
  });
});

describe("runGitHubReleasePoller", () => {
  const base = () => ({
    channelId: "chan-1", fullName: "oven-sh/bun", token: "tok",
    tenantId: 7, now: NOW,
  });

  it("seed 阶段只记不发，且真的记进了 dedup —— 下一轮增量必须一条都不发", async () => {
    // dedup 表是「见过」状态的唯一存放处；seed 时不记录，第一次增量轮询会把整个历史
    // 当成新的发出去（x-list-posts.ts 已经踩过这个坑）。
    // 只断言「没发出」是不够的：一个在 !emitFlowEvent 时直接 return 0 的实现（正是代码
    // 注释所警告的那个 bug）同样能通过。所以既断言 dedup 收到了 id，又真的跑第二轮。
    const row = { cursor: null as string | null, backfill_complete: 0, last_polled_at: null as string | null, since_id: null };
    const { db } = fakeLinkDb(row);
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 1 }), rel({ id: 2 })], etag: 'W/"a"', rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(0);
    expect(getRepoMock).not.toHaveBeenCalled();
    expect(cs.seenIds().sort()).toEqual(["1", "2"]);

    // 第二轮：seed 已完成，同一页历史再来一次 —— 全都该被 dedup 挡下。
    row.backfill_complete = 1;
    row.last_polled_at = "2026-08-09T00:00:00Z";
    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(0);
    expect(getRepoMock).not.toHaveBeenCalled();
  });

  it("seed 轮不发 If-None-Match —— 一个 304 会让空页被当成 seed 完成", async () => {
    // cursor 在 seed 时通常是 NULL，但不是必然（上一轮 seed 写了 ETag 却在 upsertPage
    // 抛了，ETag 就留在 cursor 里）。带着它去 seed 正好可能撞上 304 拿到空页。
    const { db } = fakeLinkDb({ cursor: 'W/"leftover"', backfill_complete: 0, last_polled_at: null, since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 1 })], etag: 'W/"a"', rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(listReleasesMock).toHaveBeenCalledWith("tok", "oven-sh/bun", null);
  });

  it("seed 轮读不到 repo 时不得标记 seed 完成 —— 否则下一轮把整个历史灌进 flow", async () => {
    // 这是最贵的一个 bug：一次瞬时 404/403 把 (channel, repo) 以**空的 seen 集合**标成
    // 已 seed，下一轮最多 100 条历史 release 一次性涌进用户的 flow。
    const { db, writes } = fakeLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null, since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: false, notFound: true });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(writes.some((w) => w.sql.includes("backfill_complete = 1"))).toBe(false);
    expect(writes.some((w) => w.sql.includes("last_polled_at = datetime"))).toBe(false);
    expect(cs.seenIds()).toEqual([]);
  });

  it("增量阶段发新 release，并带上 repo 作者字段与 release_history", async () => {
    const { db } = fakeLinkDb({ cursor: 'W/"old"', backfill_complete: 1, last_polled_at: "2026-08-09T00:00:00Z", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 9, name: "Bun v1", body: "hello" })], etag: 'W/"b"', rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: { id: 357728969, full_name: "oven-sh/bun", name: "bun", description: "fast", owner: { avatar_url: "https://a/o.png" }, stargazers_count: 70000 }, rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(1);
    const { secondaryValue, props } = cs.emitted[0];
    expect(secondaryValue).toBe("oven-sh/bun");                // envelope 用全名，节点里存的也是全名
    expect(props.content_type).toBe("RELEASE");
    expect(props.content_text).toBe("hello");
    expect(props.title).toBe("Bun v1");
    expect(props.is_prerelease).toBe(0);                       // 布尔归一成 ENUM_INT
    expect(props["user.followers_count"]).toBe(70000);         // star → followers_count
    expect(props["user.name"]).toBe("oven-sh/bun");
    expect(props.release_history).toHaveLength(1);
  });

  it("title 为空时回退 tag_name", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 3, name: null, tag_name: "bun-v1.3.14" })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: { id: 1, full_name: "o/r", name: "r", owner: {}, stargazers_count: 1 }, rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted[0].props.title).toBe("bun-v1.3.14");
  });

  it("draft 跳过；本轮无新 release 时一次 getRepo 都不打", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    cs.seenAll(["5"]);
    listReleasesMock.mockResolvedValue({
      releases: [rel({ id: 4, draft: true }), rel({ id: 5 })],   // 4 是草稿，5 已见过
      etag: null, rateLimited: false, notFound: false,
    });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(0);
    // 作者字段只在真有新版那一轮才拉 —— 绝大多数轮次是「没有新版」，白打就是白烧配额
    expect(getRepoMock).not.toHaveBeenCalled();
  });

  it("304 不改变任何状态", async () => {
    const { db } = fakeLinkDb({ cursor: 'W/"same"', backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: null, etag: 'W/"same"', rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(0);
  });

  it("notFound 不抛 —— 单个 repo 失联不该拖垮整轮", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: false, notFound: true });

    await expect(runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never })).resolves.toBeUndefined();
    expect(cs.emitted).toHaveLength(0);
  });

  it("拿不到 repo 时照发，只是没有作者字段 —— dedup 已消费，跳过就是永久丢失", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 77 })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: null, rateLimited: true, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(1);
    expect(cs.emitted[0].props["user.followers_count"]).toBeUndefined();
    expect(cs.emitted[0].props.content_text).toBe("notes");
  });

  it("getRepo 抛错也照发 —— 异常逃出去等于本轮 fresh 全部永久丢失", async () => {
    // getRepo 在 401/403/404/429 之外（如 500）和网络故障时会抛，而此刻两条 release
    // 都已经被 recordTriggerContentSeen 永久标记成见过了。
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 11 }), rel({ id: 12 })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockRejectedValue(new Error("getRepo(o/r) failed 500: boom"));

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(2);
    expect(cs.emitted[0].props["user.followers_count"]).toBeUndefined();
    expect(cs.emitted[0].props.content_type).toBe("RELEASE");
  });

  it("一条 emit 失败不连坐后面的 —— 每条都已标记见过，中断就是整批丢失", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    cs.failEmitFor.add("21");
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 21 }), rel({ id: 22 }), rel({ id: 23 })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: { id: 1, full_name: "o/r", name: "r", owner: {}, stargazers_count: 1 }, rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted.map((e) => e.props.source_content_id)).toEqual([22, 23]);
  });

  it("content_text 超过 32KB 截断 —— 队列单条消息上限 128KB", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 6, body: "x".repeat(50_000) })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: { id: 1, full_name: "o/r", name: "r", owner: {}, stargazers_count: 1 }, rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect((cs.emitted[0].props.content_text as string).length).toBe(32_768);
  });
});
