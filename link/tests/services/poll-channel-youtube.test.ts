import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/youtube-account", () => ({
  syncYouTubeSubscriptionUsers: vi.fn().mockResolvedValue(undefined),
}));
import { syncYouTubeSubscriptionUsers } from "../../src/services/youtube-account";
import { pollYouTubeChannel } from "../../src/services/pollers/poll-channel";
import { handlePolling, handleYouTubeSubscriptions } from "../../src/cron";

function createEnv(pollState: Record<string, unknown> | null) {
  const runs: string[] = [];
  const LINK_DB = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(sql.includes("channel_poll_state") ? pollState : null),
        run: vi.fn().mockImplementation(async () => { runs.push(sql); return { success: true }; }),
      }),
    })),
  };
  return { env: { LINK_DB } as any, runs };
}

const YT_ROW = { id: "acct-1", tenant_id: 42, config: JSON.stringify({ access_token: "tok" }) };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("pollYouTubeChannel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("距上次同步 24 小时 —— 跑", async () => {
    const { env } = createEnv({ backfill_complete: 1, last_polled_at: hoursAgo(24) });
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledWith(env, "acct-1", expect.any(Number));
  });

  // 每小时的 cron 会反复看到这个频道；23 小时的节流是配额天花板的直接体现
  // （10,000 units/天是整个 Google Cloud 项目共享的，不是每租户）。
  it("距上次同步 22 小时 —— 跳过", async () => {
    const { env } = createEnv({ backfill_complete: 1, last_polled_at: hoursAgo(22) });
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });

  it("从没同步过（last_polled_at 为 null）—— 跑", async () => {
    const { env } = createEnv({ backfill_complete: 0, last_polled_at: null });
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  // poller 自播种，所以「没有 state 行」等价于「从没跑过」，必须跑而不是跳过 ——
  // 这与 X 的语义（没有 state 行 = 未授权 = 跳过）相反，是刻意的。
  it("没有 channel_poll_state 行 —— 跑", async () => {
    const { env } = createEnv(null);
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  it("没有 tenant_id —— 跳过", async () => {
    const { env } = createEnv({ backfill_complete: 1, last_polled_at: hoursAgo(48) });
    await pollYouTubeChannel(env, { ...YT_ROW, tenant_id: null });
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });

  // Important 1：cursor 非空 = 上一轮没跑完、欠着一段续跑。这时 23h 节流必须让路，
  // 否则一个 400 订阅的账号每天只推进一段，要 8 天才跑完一轮 —— 而取消订阅的 diff
  // 只在跑完的那一轮才执行，等于对这类账号永远不生效。
  it("cursor 非空时无视 23h 节流，下一个小时的 tick 就续跑", async () => {
    const { env } = createEnv({ cursor: "150", last_polled_at: hoursAgo(1) });
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  it("cursor 为空时 23h 节流照常生效（22 小时前跑过 —— 跳过）", async () => {
    const { env } = createEnv({ cursor: null, last_polled_at: hoursAgo(22) });
    await pollYouTubeChannel(env, YT_ROW);
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });

  // 这个 SELECT 由 cron 的 handleYouTubeSubscriptions 在逐账号的循环里调用：异常逃出去
  // 会中断整个循环，连带跳过后面所有账号的轮询。
  it("channel_poll_state 的 SELECT 抛错时不外抛，只跳过这个频道", async () => {
    const LINK_DB = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockImplementation(async () => {
            if (sql.includes("channel_poll_state")) throw new Error("D1_ERROR: network");
            return null;
          }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      })),
    };
    const env = { LINK_DB } as any;

    await expect(pollYouTubeChannel(env, YT_ROW)).resolves.toBeUndefined();
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });
});

describe("handlePolling 候选频道", () => {
  it("不再把 YOUTUBE_ACCOUNT 纳入候选 —— 已改由 handleYouTubeSubscriptions 独立调度", async () => {
    const prepare = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    await handlePolling({ LINK_DB: { prepare } } as any);
    expect(String(prepare.mock.calls[0][0])).not.toContain("YOUTUBE_ACCOUNT");
  });
});

describe("handleYouTubeSubscriptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("轮询每一个 active 的 YouTube 账号", async () => {
    const channelRows = [
      { id: "acct-1", config: JSON.stringify({}), tenant_id: 1 },
      { id: "acct-2", config: JSON.stringify({}), tenant_id: 2 },
    ];
    // Every channel_poll_state lookup reports "never synced" so both accounts actually run.
    const LINK_DB = {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        all: vi.fn().mockResolvedValue({ results: channelRows }),
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sql.includes("channel_poll_state") ? null : channelRows[0]),
        }),
      })),
    };
    const env = { LINK_DB } as any;

    await handleYouTubeSubscriptions(env);

    const call = String(LINK_DB.prepare.mock.calls[0][0]);
    expect(call).toContain("YOUTUBE_ACCOUNT");
    expect(call).toContain("is_active = 1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledWith(env, "acct-1", expect.any(Number));
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledWith(env, "acct-2", expect.any(Number));
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(2);
  });
});
