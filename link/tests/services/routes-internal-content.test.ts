/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

describe("stub content-flow action endpoints", () => {
  // Override env.INTERNAL_SECRET since vitest-pool-workers doesn't pick up [env.dev.vars]
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };
  const testSecret = "test-internal-secret";

  it("POST /internal/x/repost returns 501 not-implemented", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ channelId: "chan-1", contentId: "content-1" }),
      }),
      testEnv
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, notImplemented: true });
  });

  it("POST /internal/content/ai-rewrite-publish returns 501 not-implemented", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/content/ai-rewrite-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ contentId: "content-1", sourceChannelId: "chan-1", targetChannelId: "chan-2" }),
      }),
      testEnv
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, notImplemented: true });
  });

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/x/repost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: "chan-1", contentId: "content-1" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });
});
