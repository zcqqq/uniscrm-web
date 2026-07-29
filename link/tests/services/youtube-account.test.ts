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

describe("syncYouTubeSubscriptionUsers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("租户 D1 未 provision 时，在任何 YouTube API 调用前就退出", async () => {
    (resolveTenantDb as any).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv(CHANNEL_ROW);

    await syncYouTubeSubscriptionUsers(env, "acct-1");

    expect(runYouTubeSubscriptionsPoller).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
});
