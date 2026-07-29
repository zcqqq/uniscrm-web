import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncYouTubeSubscriptionUsers } from "../../src/services/youtube-account";

vi.mock("../../src/services/pollers/youtube-subscriptions", () => ({
  runYouTubeSubscriptionsPoller: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/tenant-db", () => ({
  resolveTenantDb: vi.fn(),
}));
import { runYouTubeSubscriptionsPoller } from "../../src/services/pollers/youtube-subscriptions";
import { resolveTenantDb } from "../../src/services/tenant-db";

function createEnv(channelRow: Record<string, unknown> | null) {
  const runs: { sql: string; params: unknown[] }[] = [];
  const LINK_DB = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: unknown[]) => ({
        first: vi.fn().mockResolvedValue(channelRow),
        run: vi.fn().mockImplementation(async () => { runs.push({ sql, params }); return { success: true }; }),
      })),
    })),
  };
  return { env: { LINK_DB, KV: { get: vi.fn(), put: vi.fn() } } as any, runs };
}

const CHANNEL_ROW = {
  id: "acct-1",
  tenant_id: 42,
  config: JSON.stringify({ access_token: "tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
};

// 故意让 token 已经过期（不像 CHANNEL_ROW 那样还有一小时有效期）—— 如果 tenant-D1 守卫
// 被挪到了 token 刷新之后，getValidToken 会真的走到 forceRefresh 并调用 fetch；只有守卫
// 仍然在最前面时 fetchMock 才会保持零调用。用一个还有一小时有效期的 token 做这个测试，
// 无论守卫顺序对不对 fetch 都不会被调用，测试就失去了区分力（Important 2 review 意见）。
const EXPIRING_CHANNEL_ROW = {
  id: "acct-1",
  tenant_id: 42,
  config: JSON.stringify({
    access_token: "tok",
    refresh_token: "rt",
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }),
};

describe("syncYouTubeSubscriptionUsers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("租户 D1 未 provision 时，在任何 YouTube API 调用前就退出", async () => {
    (resolveTenantDb as any).mockResolvedValue(null);
    // 若 token 刷新真的被调用到，这个 mock 也能让它"成功"完成，这样断言失败时看到的
    // 就是纯粹的"fetch 被调用了"，而不会被一个无关的 undefined-response 崩溃盖住。
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-tok", expires_in: 3600 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv(EXPIRING_CHANNEL_ROW);

    await syncYouTubeSubscriptionUsers(env, "acct-1");

    expect(resolveTenantDb).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runYouTubeSubscriptionsPoller).not.toHaveBeenCalled();
  });

  it("channels 行不存在时静默返回", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    const { env } = createEnv(null);

    await syncYouTubeSubscriptionUsers(env, "missing");

    expect(runYouTubeSubscriptionsPoller).not.toHaveBeenCalled();
  });

  it("正常路径调 poller，并把 sync_status 写成 done", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    vi.stubGlobal("fetch", vi.fn());
    const { env, runs } = createEnv(CHANNEL_ROW);

    await syncYouTubeSubscriptionUsers(env, "acct-1");

    expect(runYouTubeSubscriptionsPoller).toHaveBeenCalledTimes(1);
    const statusWrite = runs.find((r) => r.sql.includes("json_set"));
    expect(statusWrite).toBeTruthy();
    // 整体重写 config 会与 token 刷新互相覆盖 —— 必须是 json_set 定点改
    expect(statusWrite!.sql).toContain("$.sync_status");
    expect(statusWrite!.sql).not.toMatch(/SET\s+config\s*=\s*\?/);
    expect(statusWrite!.params).toContain("done");
  });

  it("poller 抛错时把 sync_status 写成 error 而不是让异常逃逸", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    (runYouTubeSubscriptionsPoller as any).mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", vi.fn());
    const { env, runs } = createEnv(CHANNEL_ROW);

    await expect(syncYouTubeSubscriptionUsers(env, "acct-1")).resolves.toBeUndefined();

    expect(runs.find((r) => r.sql.includes("json_set"))!.params).toContain("error");
  });

  it("sync_status 的 json_set 写入本身抛错时不能让异常逃出函数，但要记录失败", async () => {
    (resolveTenantDb as any).mockResolvedValue({ query: vi.fn() });
    vi.stubGlobal("fetch", vi.fn());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const LINK_DB = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockImplementation(() => ({
          first: vi.fn().mockResolvedValue(CHANNEL_ROW),
          run: vi.fn().mockImplementation(async () => {
            if (sql.includes("json_set")) throw new Error("D1 REST call failed");
            return { success: true };
          }),
        })),
      })),
    };
    const env = { LINK_DB, KV: { get: vi.fn(), put: vi.fn() } } as any;

    // 这里是本用例的核心：即便最后那条 json_set UPDATE 本身抛错（D1 REST 调用确实会
    // 失败），也绝不能让异常从 syncYouTubeSubscriptionUsers 逃出去 —— 它跑在 OAuth
    // 回调的 waitUntil 里，逃逸出去就是一次已经成功的连接却让用户看到报错页。
    await expect(syncYouTubeSubscriptionUsers(env, "acct-1")).resolves.toBeUndefined();

    expect(runYouTubeSubscriptionsPoller).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("youtube_subscriptions_sync_status_write_failed")
    );
    errorSpy.mockRestore();
  });
});
