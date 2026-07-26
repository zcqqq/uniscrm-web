import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createOAuthRouter } from "../../worker/api/oauth";
import { OAuthService } from "../../worker/services/oauth";
import { PendingTaskService } from "../../worker/services/pending-tasks";
import * as taskExecutor from "../../worker/services/task-executor";

// X never returns an email from /2/users/me (it needs elevated access), so every X signup
// lands in the no-email branch: callback -> /auth/complete-profile -> POST /auth/verify-code.
// That branch used to hardcode "UTC", which is why X signups all had timezone='UTC' in prod
// while Google signups carried the real browser zone.
describe("POST /auth/verify-code", () => {
  let db: any;
  let kv: any;
  let app: Hono;
  let ctx: any;
  let resolveUser: any;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({}),
        }),
      }),
    };
    kv = {
      get: vi.fn(async (key: string) => {
        if (key === "pending_oauth:pending-1") {
          return JSON.stringify({ provider: "x", providerUserId: "x-123", timezone: "Asia/Shanghai" });
        }
        if (key === "email_code:new@example.com") {
          return JSON.stringify({ code: "123456", attempts: 0 });
        }
        return null;
      }),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

    // isNew=false keeps the assertion on the timezone argument rather than on the
    // provisioning side effects that a brand-new tenant would kick off.
    resolveUser = vi
      .spyOn(OAuthService.prototype, "resolveUser")
      .mockResolvedValue({ memberId: "member-1", tenantId: 7, isNew: false });

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { WEB_DB: db, KV: kv, WEB_URL: "https://app.example.com", LINK_URL: "https://link.example.com", INTERNAL_SECRET: "s" };
      return next();
    });
    app.route("/auth", createOAuthRouter());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function post() {
    return app.request(
      "/auth/verify-code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "pending_oauth=pending-1" },
        body: JSON.stringify({ email: "new@example.com", code: "123456" }),
      },
      undefined,
      ctx
    );
  }

  it("carries the timezone captured at the OAuth start into the member it creates", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(resolveUser).toHaveBeenCalledWith("x", "x-123", "new@example.com", "Asia/Shanghai");
  });

  it("falls back to UTC when the pending record has no timezone", async () => {
    kv.get.mockImplementation(async (key: string) => {
      if (key === "pending_oauth:pending-1") return JSON.stringify({ provider: "x", providerUserId: "x-123" });
      if (key === "email_code:new@example.com") return JSON.stringify({ code: "123456", attempts: 0 });
      return null;
    });

    await post();

    expect(resolveUser).toHaveBeenCalledWith("x", "x-123", "new@example.com", "UTC");
  });

  it("kicks off provision-db and activate-trial tasks when the signup is brand-new", async () => {
    resolveUser.mockResolvedValue({ memberId: "member-2", tenantId: 99, isNew: true });
    const createCalls: [string, object][] = [];
    vi.spyOn(PendingTaskService.prototype, "create").mockImplementation(async (taskType: string, payload: object) => {
      createCalls.push([taskType, payload]);
      return `task-${taskType}`;
    });
    const execSpy = vi.spyOn(taskExecutor, "executePendingTask").mockResolvedValue(undefined);

    await post();

    expect(createCalls).toEqual([
      ["provision-db", { tenant_id: 99 }],
      ["activate-trial", { tenant_id: 99, tier: "basic", days: 30 }],
    ]);
    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });
});
