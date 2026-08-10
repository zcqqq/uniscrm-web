import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only the poller is stubbed. resolveTenantDb / ContentService / EntityStateStore are left real
// (their constructors are plain field assignments), so the fake WEB_DB below is all it takes to
// get past the "tenant has a database" gate and reach the poller call.
const runPollerMock = vi.fn();
vi.mock("../../src/services/pollers/github-releases", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  runGitHubReleasePoller: (...args: unknown[]) => runPollerMock(...args),
}));

import { handleGitHubReleases } from "../../src/cron";

type Pair = { channelId: string; fullName: string };

/**
 * LINK_DB stand-in. cron_state lives in a Map the caller owns, so several handleGitHubReleases
 * runs in one test share the rotation offset exactly the way consecutive cron ticks do.
 */
function fakeLinkDb(cronState: Map<string, string>, channels: Record<string, { config: string; tenant_id: number | null }>) {
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM cron_state")) {
                const v = cronState.get(String(binds[0]));
                return v === undefined ? null : { value: v };
              }
              if (sql.includes("FROM channels")) return channels[String(binds[0])] ?? null;
              if (sql.includes("FROM tenants")) return { d1_database_id: "db-1" };
              return null;
            },
            async run() {
              runs.push({ sql, binds });
              if (sql.includes("INTO cron_state")) cronState.set(String(binds[0]), String(binds[1]));
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, runs };
}

function makeEnv(watches: Pair[], cronState: Map<string, string>, overrides: Record<string, unknown> = {}) {
  const channels: Record<string, { config: string; tenant_id: number | null }> = {};
  for (const w of watches) {
    channels[w.channelId] ??= { config: JSON.stringify({ access_token: `tok-${w.channelId}` }), tenant_id: 1 };
  }
  const { db } = fakeLinkDb(cronState, channels);
  const webDb = { prepare: () => ({ bind: () => ({ first: async () => ({ d1_database_id: "db-1" }) }) }) };
  return {
    LINK_DB: db, WEB_DB: webDb, FLOW_URL: "https://flow.test", INTERNAL_SECRET: "s",
    CF_ACCOUNT_ID: "acct", CF_D1_API_TOKEN: "tok",
    ...overrides,
  } as never;
}

function stubWatches(watches: Pair[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ watches }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function pair(channelId: string, fullName: string): Pair {
  return { channelId, fullName };
}

beforeEach(() => {
  runPollerMock.mockReset().mockResolvedValue({ rateLimited: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// CRITICAL 1 — no tenant may be permanently starved
// ---------------------------------------------------------------------------
describe("handleGitHubReleases 的轮转（不饿死任何租户）", () => {
  // 每对 15s、预算 50s ⇒ 一轮考察 4 对。清单有 5 对，所以每一轮必然有一对轮不到。
  // 关键是「轮不到」必须是**这一轮**，不是永远：没有轮转位点时，SELECT 的顺序在多轮之间
  // 稳定，第 5 对将一次都不会被轮询 —— 那个租户已发布的 flow 静默地永不触发。
  const FIVE = [
    pair("c1", "o/r1"), pair("c1", "o/r2"), pair("c1", "o/r3"), pair("c1", "o/r4"), pair("c1", "o/r5"),
  ];

  function slowPoller() {
    runPollerMock.mockImplementation(async () => {
      vi.advanceTimersByTime(15_000);
      return { rateLimited: false };
    });
  }

  it("连续三轮之后，排在预算边界之外的那一对也被轮询过（没有轮转则永远轮不到）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    slowPoller();

    const cronState = new Map<string, string>();
    const polledPerRound: string[][] = [];

    for (let round = 0; round < 3; round++) {
      runPollerMock.mockClear();
      // 每轮都把清单顺序打乱：位点靠 pairKey 定位，不靠数组下标，顺序抖动不能破坏轮转。
      stubWatches([...FIVE].reverse());
      await handleGitHubReleases(makeEnv(FIVE, cronState));
      polledPerRound.push(runPollerMock.mock.calls.map((c) => (c[0] as { fullName: string }).fullName));
    }

    // 每轮都只处理得下 4 对（预算所限），但三轮的并集必须覆盖全部 5 对。
    expect(polledPerRound.every((r) => r.length === 4)).toBe(true);
    const everPolled = new Set(polledPerRound.flat());
    expect([...everPolled].sort()).toEqual(["o/r1", "o/r2", "o/r3", "o/r4", "o/r5"]);
    // 第一轮停在 o/r4，所以第二轮必须从 o/r5 起手 —— 这正是「不再从头开始」。
    expect(polledPerRound[0]).toEqual(["o/r1", "o/r2", "o/r3", "o/r4"]);
    expect(polledPerRound[1][0]).toBe("o/r5");
  });

  it("把本轮最后考察过的那一对写进 cron_state，供下一轮接着走", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    slowPoller();

    const cronState = new Map<string, string>();
    stubWatches(FIVE);
    await handleGitHubReleases(makeEnv(FIVE, cronState));

    expect(cronState.get("github_releases_rotation")).toBe("c1|o/r4");
  });

  it("预算用尽时报出本轮跳过了多少对（MINOR 10：调预算需要的就是这个数）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    slowPoller();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stubWatches(FIVE);
    await handleGitHubReleases(makeEnv(FIVE, new Map()));

    const line = logSpy.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a === "string" && a.includes("github_releases_budget_exhausted")) as string;
    expect(line, "expected a budget_exhausted log line").toBeDefined();
    const parsed = JSON.parse(line);
    expect(parsed.skipped).toBe(1);
    expect(parsed.examined).toBe(4);
    expect(parsed.total).toBe(5);
    logSpy.mockRestore();
  });

  it("cron_state 读不出来时降级成「从头开始」而不是整个 handler 挂掉", async () => {
    // 最现实的触发条件：迁移 0010 还没跑（手工部署跳过了 migrate）。让异常逃进 allSettled
    // 等于 GitHub 轮询整个停摆；退化成不轮转、但仍然轮询，明显更好 —— 前提是留下日志。
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first() {
                if (sql.includes("cron_state")) throw new Error("no such table: cron_state");
                if (sql.includes("FROM channels")) return { config: JSON.stringify({ access_token: "t" }), tenant_id: 1 };
                return { d1_database_id: "db-1" };
              },
              async run() {
                if (sql.includes("cron_state")) throw new Error("no such table: cron_state");
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const env = {
      LINK_DB: db,
      WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ d1_database_id: "db-1" }) }) }) },
      FLOW_URL: "https://flow.test", INTERNAL_SECRET: "s", CF_ACCOUNT_ID: "a", CF_D1_API_TOKEN: "t",
    } as never;
    stubWatches([pair("c1", "o/r1")]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handleGitHubReleases(env);

    expect(runPollerMock).toHaveBeenCalledTimes(1);
    const events = errSpy.mock.calls.map((c) => String(c[0]));
    expect(events.some((e) => e.includes("cron_state_read_failed"))).toBe(true);
    expect(events.some((e) => e.includes("cron_state_write_failed"))).toBe(true);
    errSpy.mockRestore();
  });

  it("一个每轮都抛错的 pair 照样推进位点，不会把轮转钉死在原地", async () => {
    // 失败也推进是保证成立的前提：否则一个坏 repo 就能让它后面的所有租户重新被饿死。
    runPollerMock.mockRejectedValue(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cronState = new Map<string, string>();

    stubWatches([pair("c1", "o/r1"), pair("c1", "o/r2")]);
    await handleGitHubReleases(makeEnv([pair("c1", "o/r1"), pair("c1", "o/r2")], cronState));

    expect(cronState.get("github_releases_rotation")).toBe("c1|o/r2");
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 2 — a rate-limited tenant must not burn the shared budget
// ---------------------------------------------------------------------------
describe("handleGitHubReleases 的限流早停", () => {
  it("一个 channel 报限流后，跳过它本轮剩下的 repo，但别的租户照常轮询", async () => {
    const watches = [
      pair("c1", "o/r1"), pair("c1", "o/r2"), pair("c1", "o/r3"), pair("c2", "o/r9"),
    ];
    runPollerMock.mockImplementation(async (ctx: { channelId: string }) =>
      ({ rateLimited: ctx.channelId === "c1" })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stubWatches(watches);

    await handleGitHubReleases(makeEnv(watches, new Map()));

    // 没有这个早停，c1 剩下的两个 repo 会各自再打一次 GitHub、各换回一个 403，
    // 每次约 300ms 全从共享预算里扣 —— 一个限流租户就能把一小时占满。
    const polled = runPollerMock.mock.calls.map((c) => `${(c[0] as any).channelId}|${(c[0] as any).fullName}`);
    expect(polled).toEqual(["c1|o/r1", "c2|o/r9"]);

    const line = logSpy.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a === "string" && a.includes("github_channel_rate_limited")) as string;
    expect(line).toBeDefined();
    expect(JSON.parse(line).channel_id).toBe("c1");
    logSpy.mockRestore();
  });

  it("限流不停用 channel（限流是暂时的，401 才停用）", async () => {
    const watches = [pair("c1", "o/r1"), pair("c1", "o/r2")];
    runPollerMock.mockResolvedValue({ rateLimited: true });
    const cronState = new Map<string, string>();
    const channels = { c1: { config: JSON.stringify({ access_token: "t" }), tenant_id: 1 } };
    const { db, runs } = fakeLinkDb(cronState, channels);
    const env = {
      LINK_DB: db,
      WEB_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ d1_database_id: "db-1" }) }) }) },
      FLOW_URL: "https://flow.test", INTERNAL_SECRET: "s", CF_ACCOUNT_ID: "a", CF_D1_API_TOKEN: "t",
    } as never;
    stubWatches(watches);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handleGitHubReleases(env);

    expect(runs.some((r) => r.sql.includes("is_active = 0"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 7 — config-level kill switch
// ---------------------------------------------------------------------------
describe("handleGitHubReleases 的总开关", () => {
  it('GITHUB_RELEASES_ENABLED="0" 时什么都不做，连 watch 清单都不拉', async () => {
    const watches = [pair("c1", "o/r1")];
    const fetchMock = stubWatches(watches);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleGitHubReleases(makeEnv(watches, new Map(), { GITHUB_RELEASES_ENABLED: "0" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(runPollerMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => c[0]).some((a) => typeof a === "string" && a.includes("github_releases_disabled"))).toBe(true);
    logSpy.mockRestore();
  });

  it('"false" 同样关闭', async () => {
    const watches = [pair("c1", "o/r1")];
    const fetchMock = stubWatches(watches);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGitHubReleases(makeEnv(watches, new Map(), { GITHUB_RELEASES_ENABLED: "FALSE" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("不设置这个变量时行为与加开关之前完全一致（缺省即开启）", async () => {
    const watches = [pair("c1", "o/r1")];
    stubWatches(watches);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await handleGitHubReleases(makeEnv(watches, new Map()));
    expect(runPollerMock).toHaveBeenCalledTimes(1);
  });
});
