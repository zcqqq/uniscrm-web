import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Manual trigger for the subscription repair. It exists because the unattended path only runs
// hourly AND only inside the token-refresh window, so every diagnosis of this chain used to
// cost a two-hour wait. It must call the SAME ensureXSubscriptions the cron calls — a repair
// that only works by hand proves nothing about the path that runs unattended.

const ensureMock = vi.fn();
vi.mock("../src/services/x-subscription-repair", () => ({
  ensureXSubscriptions: (...args: unknown[]) => ensureMock(...args),
}));

const getValidTokenMock = vi.fn();
vi.mock("../src/services/x-token", () => ({
  XTokenService: class {
    getValidToken(...args: unknown[]) { return getValidTokenMock(...args); }
    updateConfig = vi.fn();
  },
}));

vi.mock("../src/services/app-credentials", async (importActual) => ({
  ...(await importActual<typeof import("../src/services/app-credentials")>()),
  getAppCredentials: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "csec", bearerToken: "bearer" }),
}));

import { internalRoutes } from "../src/routes-internal";

const CHANNEL_ID = "chan-1";

function db(row: Record<string, unknown> | null) {
  return { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database;
}
const CHANNEL_ROW = { id: CHANNEL_ID, config: JSON.stringify({ is_byok: true, x_user_id: "3245609912" }) };

function post(query: string, database: D1Database) {
  const app = new Hono();
  app.route("/internal", internalRoutes());
  return app.request(`/internal/x/repair-subscriptions${query}`, { method: "POST", headers: { "X-Internal-Secret": "s3cret" } },
    { LINK_DB: database, INTERNAL_SECRET: "s3cret", LINK_URL: "https://link-dev.uni-scrm.com" } as never);
}

beforeEach(() => {
  ensureMock.mockReset().mockResolvedValue({ ok: true, webhookId: "wh-1", webhookUrl: "https://link-dev.uni-scrm.com/x/webhook/3245609912", subscriptionIds: ["s1", "s2"] });
  getValidTokenMock.mockReset().mockResolvedValue("user-token");
});

describe("POST /internal/x/repair-subscriptions", () => {
  it("runs the shared repair with a valid user token and returns what it built", async () => {
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, webhookId: "wh-1", subscriptionIds: ["s1", "s2"] });

    expect(getValidTokenMock).toHaveBeenCalledWith(CHANNEL_ID);
    // Same function the cron calls, and the user token is the one getValidToken vouched for.
    const [, channelId, config, , token] = ensureMock.mock.calls[0];
    expect(channelId).toBe(CHANNEL_ID);
    expect((config as { x_user_id: string }).x_user_id).toBe("3245609912");
    expect(token).toBe("user-token");
  });

  it("400s a repair the shared function declined (e.g. channel never authorized)", async () => {
    ensureMock.mockResolvedValue({ ok: false, error: "channel has no x_user_id — it has not been authorized yet" });
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain("x_user_id");
  });

  // getValidToken refuses deactivated and frozen channels; that refusal must surface, not 200.
  it("502s when the token is unavailable, without attempting the repair", async () => {
    getValidTokenMock.mockRejectedValue(new Error("channel_frozen: X locked the account"));
    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toContain("channel_frozen");
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("400s without a channelId and 404s an unknown or inactive channel", async () => {
    expect((await post("", db(null))).status).toBe(400);
    expect((await post("?channelId=nope", db(null))).status).toBe(404);
  });
});

// ?rebuild=<event_type> 是换 filter.direction 的唯一手段：X 只在创建订阅时接受 direction，
// PUT 改不了，GET 又不回显，所以代码无从判断该不该重建——必须由操作者点名。
describe("POST /internal/x/repair-subscriptions?rebuild=", () => {
  function mockXList(subs: Array<{ subscription_id: string; event_type: string; filter: { user_id: string } }>) {
    const deletes: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes.push({ url, auth: (init.headers as Record<string, string>).Authorization });
        return Promise.resolve(new Response(JSON.stringify({ data: { deleted: true } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: subs }), { status: 200 }));
    }));
    return deletes;
  }

  const MINE = { subscription_id: "legacy-like", event_type: "like.create", filter: { user_id: "3245609912" } };

  it("只删点名的那个 event_type，再交给 ensure 按 metadata 重建", async () => {
    const deletes = mockXList([
      MINE,
      { subscription_id: "keep-follow", event_type: "follow.follow", filter: { user_id: "3245609912" } },
    ]);

    const res = await post(`?channelId=${CHANNEL_ID}&rebuild=like.create`, db(CHANNEL_ROW));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, rebuilt: "like.create", deleted: ["legacy-like"] });
    expect(deletes.map((d) => d.url)).toEqual(["https://api.x.com/2/activity/subscriptions/legacy-like"]);
    // 删除只收 app-only bearer，用户 token 会被 403。
    expect(deletes[0].auth).toBe("Bearer bearer");
    // 重建仍然走和 cron 同一个 ensureXSubscriptions。
    expect(ensureMock).toHaveBeenCalled();
  });

  it("不碰别的 X 用户的同类型订阅——共享 webhook 的列表跨租户", async () => {
    const deletes = mockXList([
      MINE,
      { subscription_id: "other-like", event_type: "like.create", filter: { user_id: "other-user" } },
    ]);

    await post(`?channelId=${CHANNEL_ID}&rebuild=like.create`, db(CHANNEL_ROW));

    expect(deletes.map((d) => d.url.split("/").pop())).toEqual(["legacy-like"]);
  });

  it("不带 rebuild 时一条都不删（默认幂等修复，不是破坏性操作）", async () => {
    const deletes = mockXList([MINE]);

    const res = await post(`?channelId=${CHANNEL_ID}`, db(CHANNEL_ROW));

    expect(deletes).toEqual([]);
    expect(await res.json()).not.toHaveProperty("rebuilt");
  });
});
