import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { internalAuthMiddleware } from "../src/middleware";

// Manual trigger for the GitHub release poller. It exists because the unattended path only
// runs hourly, and `wrangler dev --remote` can't substitute — it doesn't support queues, which
// is exactly how this poller emits its events. It must call the SAME handleGitHubReleases the
// cron calls — a manual path that duplicates the logic proves nothing about the path that
// actually runs unattended.

const handleGitHubReleasesMock = vi.fn();
vi.mock("../src/cron", async (importActual) => ({
  ...(await importActual<typeof import("../src/cron")>()),
  handleGitHubReleases: (...args: unknown[]) => handleGitHubReleasesMock(...args),
}));

import { internalRoutes } from "../src/routes-internal";

const SECRET = "s3cret";

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

function post(envOverrides: Record<string, unknown> = {}, secret: string | null = SECRET) {
  const app = makeApp();
  const headers: Record<string, string> = {};
  if (secret !== null) headers["X-Internal-Secret"] = secret;
  return app.request(
    "/internal/github/poll-once",
    { method: "POST", headers },
    { INTERNAL_SECRET: SECRET, ...envOverrides } as never
  );
}

beforeEach(() => {
  handleGitHubReleasesMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /internal/github/poll-once", () => {
  it("calls the same handleGitHubReleases the cron calls, with the request env", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ran: true });
    expect(handleGitHubReleasesMock).toHaveBeenCalledTimes(1);
    const [envArg] = handleGitHubReleasesMock.mock.calls[0];
    expect((envArg as { INTERNAL_SECRET: string }).INTERNAL_SECRET).toBe(SECRET);
  });

  it("rejects a request with no X-Internal-Secret header", async () => {
    const res = await post({}, null);
    expect(res.status).toBe(403);
    expect(handleGitHubReleasesMock).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong secret", async () => {
    const res = await post({}, "wrong-secret");
    expect(res.status).toBe(403);
    expect(handleGitHubReleasesMock).not.toHaveBeenCalled();
  });

  it("does not run when the kill switch is off, and says so", async () => {
    const res = await post({ GITHUB_RELEASES_ENABLED: "0" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ran: false, reason: "disabled" });
    expect(handleGitHubReleasesMock).not.toHaveBeenCalled();
  });

  it("honors the case/whitespace-insensitive 'false' spelling of the kill switch too", async () => {
    const res = await post({ GITHUB_RELEASES_ENABLED: " FALSE " });
    expect(await res.json()).toMatchObject({ ran: false, reason: "disabled" });
    expect(handleGitHubReleasesMock).not.toHaveBeenCalled();
  });
});
