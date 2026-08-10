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
  return {
    emitted,
    seenAll: (ids: string[]) => ids.forEach((i) => seen.add(i)),
    service: {
      async recordTriggerContentSeen(_c: string, _s: string, id: string) {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
      async emitContentTriggerEvent(_c: string, _t: string, _f: string, secondaryValue: string, props: Record<string, unknown>) {
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

  it("seed 阶段只记不发 —— 首次纳入不把历史灌进 flow", async () => {
    // dedup 表是「见过」状态的唯一存放处；seed 时不记录，第一次增量轮询会把整个历史
    // 当成新的发出去（x-list-posts.ts 已经踩过这个坑）
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null, since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 1 }), rel({ id: 2 })], etag: 'W/"a"', rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect(cs.emitted).toHaveLength(0);
    expect(getRepoMock).not.toHaveBeenCalled();
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

  it("content_text 超过 32KB 截断 —— 队列单条消息上限 128KB", async () => {
    const { db } = fakeLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "x", since_id: null });
    const cs = fakeContentService();
    listReleasesMock.mockResolvedValue({ releases: [rel({ id: 6, body: "x".repeat(50_000) })], etag: null, rateLimited: false, notFound: false });
    getRepoMock.mockResolvedValue({ repo: { id: 1, full_name: "o/r", name: "r", owner: {}, stargazers_count: 1 }, rateLimited: false, notFound: false });

    await runGitHubReleasePoller({ ...base(), linkDb: db, contentService: cs.service as never });

    expect((cs.emitted[0].props.content_text as string).length).toBe(32_768);
  });
});
