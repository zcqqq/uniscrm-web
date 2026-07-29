import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/youtube-account", () => ({
  syncYouTubeSubscriptionUsers: vi.fn().mockResolvedValue(undefined),
}));
import { syncYouTubeSubscriptionUsers } from "../../src/services/youtube-account";
import { pollChannelOnce } from "../../src/services/pollers/poll-channel";
import { handlePolling } from "../../src/cron";

function createEnv(channelRow: Record<string, unknown> | null, pollState: Record<string, unknown> | null) {
  const runs: string[] = [];
  const LINK_DB = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(sql.includes("channel_poll_state") ? pollState : channelRow),
        run: vi.fn().mockImplementation(async () => { runs.push(sql); return { success: true }; }),
      }),
    })),
  };
  return { env: { LINK_DB } as any, runs };
}

const YT_ROW = { id: "acct-1", tenant_id: 42, config: JSON.stringify({ access_token: "tok" }) };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

describe("pollChannelOnce YOUTUBE_ACCOUNT", () => {
  beforeEach(() => vi.clearAllMocks());

  it("距上次同步 24 小时 —— 跑", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 1, last_polled_at: hoursAgo(24) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledWith(env, "acct-1", expect.any(Number));
  });

  // 每小时的 cron 会反复看到这个频道；23 小时的节流是配额天花板的直接体现
  // （10,000 units/天是整个 Google Cloud 项目共享的，不是每租户）。
  it("距上次同步 22 小时 —— 跳过", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 1, last_polled_at: hoursAgo(22) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });

  it("从没同步过（last_polled_at 为 null）—— 跑", async () => {
    const { env } = createEnv(YT_ROW, { backfill_complete: 0, last_polled_at: null });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  // poller 自播种，所以「没有 state 行」等价于「从没跑过」，必须跑而不是跳过 ——
  // 这与 X 的语义（没有 state 行 = 未授权 = 跳过）相反，是刻意的。
  it("没有 channel_poll_state 行 —— 跑", async () => {
    const { env } = createEnv(YT_ROW, null);
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).toHaveBeenCalledTimes(1);
  });

  it("没有 tenant_id —— 跳过", async () => {
    const { env } = createEnv({ ...YT_ROW, tenant_id: null }, { backfill_complete: 1, last_polled_at: hoursAgo(48) });
    await pollChannelOnce(env, "YOUTUBE_ACCOUNT", "acct-1");
    expect(syncYouTubeSubscriptionUsers).not.toHaveBeenCalled();
  });
});

describe("handlePolling 候选频道", () => {
  it("把 YOUTUBE_ACCOUNT 纳入候选", async () => {
    const prepare = vi.fn().mockReturnValue({ all: vi.fn().mockResolvedValue({ results: [] }) });
    await handlePolling({ LINK_DB: { prepare } } as any);
    expect(String(prepare.mock.calls[0][0])).toContain("'YOUTUBE_ACCOUNT'");
  });
});
