import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { internalAuthMiddleware } from "../../src/middleware";
import { internalRoutes } from "../../src/routes-internal";

// Mirrors index.ts's real wiring (`app.use("/internal/*", internalAuthMiddleware)` before
// `app.route("/internal", internalRoutes())`) rather than hitting internalRoutes() bare, so the
// auth-rejection test actually exercises the guard this route relies on instead of asserting
// something the route itself doesn't do.
function makeApp() {
  const app = new Hono<{ Bindings: any }>();
  app.use("/internal/*", internalAuthMiddleware);
  app.route("/internal", internalRoutes());
  return app;
}

const SECRET = "test-secret";

function makeEnv(overrides: Partial<{ PIPELINE_USER: any; PIPELINE_CONTENT: any; PIPELINE_EVENT: any }> = {}) {
  return {
    INTERNAL_SECRET: SECRET,
    PIPELINE_USER: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_CONTENT: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_EVENT: { send: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

// secret defaults to SECRET when the arg is omitted; pass `null` explicitly to send no
// X-Internal-Secret header at all — passing `undefined` here would just re-trigger the default
// (JS default-parameter semantics activate on an explicit `undefined` too), which is exactly the
// bug that silently no-op'd the "no header" test the first time this was written.
function post(env: ReturnType<typeof makeEnv>, body: unknown, secret: string | null = SECRET) {
  const app = makeApp();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Internal-Secret"] = secret;
  return app.request("/internal/backfill/pipeline", { method: "POST", headers, body: JSON.stringify(body) }, env as any);
}

describe("POST /internal/backfill/pipeline", () => {
  it("rejects a request with no X-Internal-Secret header", async () => {
    const env = makeEnv();
    const res = await post(env, { table: "user", records: [{ id: "u1" }] }, null);
    expect(res.status).toBe(403);
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    const env = makeEnv();
    const res = await post(env, { table: "user", records: [{ id: "u1" }] }, "wrong-secret");
    expect(res.status).toBe(403);
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("400s on a table outside the whitelist", async () => {
    const env = makeEnv();
    const res = await post(env, { table: "channel", records: [{ id: "c1" }] });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("user, content, event");
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("400s when table is missing", async () => {
    const env = makeEnv();
    const res = await post(env, { records: [{ id: "c1" }] });
    expect(res.status).toBe(400);
  });

  it("400s on an empty records array", async () => {
    const env = makeEnv();
    const res = await post(env, { table: "user", records: [] });
    expect(res.status).toBe(400);
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("400s when records is missing or not an array", async () => {
    const env = makeEnv();
    const res = await post(env, { table: "user" });
    expect(res.status).toBe(400);
  });

  it("413s above the 200-record cap", async () => {
    const env = makeEnv();
    const records = Array.from({ length: 201 }, (_, i) => ({ id: `u${i}` }));
    const res = await post(env, { table: "user", records });
    expect(res.status).toBe(413);
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("accepts exactly the 200-record cap", async () => {
    const env = makeEnv();
    const records = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}` }));
    const res = await post(env, { table: "user", records });
    expect(res.status).toBe(200);
    expect(env.PIPELINE_USER.send).toHaveBeenCalledWith(records);
  });

  it("forwards user records to PIPELINE_USER and returns {ok:true, sent}", async () => {
    const env = makeEnv();
    const records = [{ id: "u1" }, { id: "u2" }];
    const res = await post(env, { table: "user", records });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, sent: 2 });
    expect(env.PIPELINE_USER.send).toHaveBeenCalledWith(records);
    expect(env.PIPELINE_CONTENT.send).not.toHaveBeenCalled();
    expect(env.PIPELINE_EVENT.send).not.toHaveBeenCalled();
  });

  it("forwards content records to PIPELINE_CONTENT", async () => {
    const env = makeEnv();
    const records = [{ id: "c1" }];
    const res = await post(env, { table: "content", records });
    expect(res.status).toBe(200);
    expect(env.PIPELINE_CONTENT.send).toHaveBeenCalledWith(records);
    expect(env.PIPELINE_USER.send).not.toHaveBeenCalled();
  });

  it("forwards event records to PIPELINE_EVENT", async () => {
    const env = makeEnv();
    const records = [{ id: "e1" }];
    const res = await post(env, { table: "event", records });
    expect(res.status).toBe(200);
    expect(env.PIPELINE_EVENT.send).toHaveBeenCalledWith(records);
  });

  it("502s and surfaces the error string when the binding rejects, instead of swallowing it", async () => {
    const env = makeEnv({ PIPELINE_USER: { send: vi.fn().mockRejectedValue(new Error("stream unavailable")) } });
    const res = await post(env, { table: "user", records: [{ id: "u1" }] });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("stream unavailable");
  });
});
