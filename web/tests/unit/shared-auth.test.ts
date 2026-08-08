import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  getCookieValue,
  resolveSession,
  resolveAuthMe,
  createInternalAuthMiddleware,
  spaLoginGuard,
} from "../../../shared/auth";

// shared/auth.ts is the single session/internal-auth implementation adopted by every worker
// (web, link, content, analytics, insight-segment, flow, admin). These tests exercise it
// against web's real WEB_DB test binding so the SQL-level expiry check is genuinely tested,
// not mocked away.

const WEB_DB = (env as { WEB_DB: D1Database }).WEB_DB;

beforeAll(async () => {
  // vitest-pool-workers does not auto-apply migrations/ — create the two tables
  // shared/auth.ts reads, matching web's schema columns it selects.
  await WEB_DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY,
       member_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL,
       email TEXT NOT NULL DEFAULT '',
       language TEXT NOT NULL DEFAULT 'en',
       expires_at TEXT NOT NULL
     )`
  ).run();
  await WEB_DB.prepare(
    `CREATE TABLE IF NOT EXISTS members (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       email TEXT NOT NULL,
       preferred_location TEXT,
       language TEXT,
       timezone TEXT
     )`
  ).run();

  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  await WEB_DB.batch([
    WEB_DB.prepare(
      `INSERT OR REPLACE INTO sessions (id, member_id, tenant_id, email, language, expires_at) VALUES ('sa-valid', 'sa-m1', 71, 'sa@example.com', 'zh', ?)`
    ).bind(future),
    WEB_DB.prepare(
      `INSERT OR REPLACE INTO sessions (id, member_id, tenant_id, email, language, expires_at) VALUES ('sa-expired', 'sa-m1', 71, 'sa@example.com', 'zh', ?)`
    ).bind(past),
    WEB_DB.prepare(
      `INSERT OR REPLACE INTO sessions (id, member_id, tenant_id, email, language, expires_at) VALUES ('sa-orphan', 'sa-gone', 72, 'gone@example.com', 'en', ?)`
    ).bind(future),
    WEB_DB.prepare(
      `INSERT OR REPLACE INTO members (id, tenant_id, email, preferred_location, language, timezone) VALUES ('sa-m1', 71, 'sa@example.com', 'global', 'zh', 'Asia/Shanghai')`
    ),
  ]);
});

describe("getCookieValue", () => {
  it("returns null for a missing header", () => {
    expect(getCookieValue(null, "session")).toBeNull();
    expect(getCookieValue(undefined, "session")).toBeNull();
    expect(getCookieValue("", "session")).toBeNull();
  });

  it("finds the cookie at the start, middle and end of the header", () => {
    expect(getCookieValue("session=abc", "session")).toBe("abc");
    expect(getCookieValue("a=1; session=abc; b=2", "session")).toBe("abc");
    expect(getCookieValue("a=1; session=abc", "session")).toBe("abc");
  });

  it("does not match a cookie whose name merely ends with the wanted name", () => {
    expect(getCookieValue("xsession=evil", "session")).toBeNull();
    expect(getCookieValue("xsession=evil; session=good", "session")).toBe("good");
  });

  it("URL-decodes the value and handles empty values", () => {
    expect(getCookieValue("session=a%3Db", "session")).toBe("a=b");
    expect(getCookieValue("session=", "session")).toBe("");
  });
});

describe("resolveSession", () => {
  it("resolves a valid session to camelCase fields", async () => {
    const session = await resolveSession(WEB_DB, "session=sa-valid");
    expect(session).toEqual({ memberId: "sa-m1", tenantId: 71, email: "sa@example.com", language: "zh" });
  });

  it("returns null without a session cookie", async () => {
    expect(await resolveSession(WEB_DB, null)).toBeNull();
    expect(await resolveSession(WEB_DB, "other=1")).toBeNull();
  });

  it("returns null for an unknown session id", async () => {
    expect(await resolveSession(WEB_DB, "session=sa-nope")).toBeNull();
  });

  it("enforces expiry in SQL: an expired row resolves to null", async () => {
    expect(await resolveSession(WEB_DB, "session=sa-expired")).toBeNull();
  });
});

describe("resolveAuthMe", () => {
  it("returns web's full /me payload for a valid session", async () => {
    const me = await resolveAuthMe(WEB_DB, "session=sa-valid");
    expect(me).toEqual({
      member: { id: "sa-m1", email: "sa@example.com", preferred_location: "global", language: "zh", timezone: "Asia/Shanghai" },
      tenant: { id: 71, email: "sa@example.com" },
    });
  });

  it("returns null when the session is valid but the member row is gone", async () => {
    expect(await resolveAuthMe(WEB_DB, "session=sa-orphan")).toBeNull();
  });

  it("returns null for missing/expired sessions", async () => {
    expect(await resolveAuthMe(WEB_DB, null)).toBeNull();
    expect(await resolveAuthMe(WEB_DB, "session=sa-expired")).toBeNull();
  });
});

describe("createInternalAuthMiddleware", () => {
  function run(middleware: (c: any, next: () => Promise<void>) => Promise<unknown>, envVars: Record<string, unknown>, headers: Record<string, string>) {
    const next = vi.fn(async () => {});
    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    const c = {
      req: { header: (name: string) => headers[name] },
      env: envVars,
      json,
    };
    return middleware(c, next).then((result) => ({ result, next, json }));
  }

  it("rejects when INTERNAL_SECRET is unset, even with a matching-looking header (fail closed)", async () => {
    const { next, json } = await run(createInternalAuthMiddleware(), {}, { "X-Internal-Secret": "anything" });
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ error: "Unauthorized" }, 401);
  });

  it("rejects when INTERNAL_SECRET is unset and the header is missing", async () => {
    const { next, json } = await run(createInternalAuthMiddleware(), { INTERNAL_SECRET: "" }, {});
    expect(next).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ error: "Unauthorized" }, 401);
  });

  it("rejects a wrong secret and a missing header when the secret is set", async () => {
    const envVars = { INTERNAL_SECRET: "right" };
    const wrong = await run(createInternalAuthMiddleware(), envVars, { "X-Internal-Secret": "wrong" });
    expect(wrong.next).not.toHaveBeenCalled();
    const missing = await run(createInternalAuthMiddleware(), envVars, {});
    expect(missing.next).not.toHaveBeenCalled();
  });

  it("passes through on a correct secret", async () => {
    const { next, json } = await run(createInternalAuthMiddleware(), { INTERNAL_SECRET: "right" }, { "X-Internal-Secret": "right" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it("honors the link/content 403 Forbidden shape via opts", async () => {
    const { json } = await run(createInternalAuthMiddleware({ status: 403, error: "Forbidden" }), {}, {});
    expect(json).toHaveBeenCalledWith({ error: "Forbidden" }, 403);
  });
});

describe("spaLoginGuard", () => {
  const WEB_URL = "https://web.test";

  function htmlReq(path: string, cookie?: string) {
    return new Request(`https://worker.test${path}`, {
      headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
    });
  }

  it("ignores non-HTML requests", async () => {
    const req = new Request("https://worker.test/page", { headers: { Accept: "application/json" } });
    expect(await spaLoginGuard(req, WEB_DB, WEB_URL)).toBeNull();
  });

  it("ignores excluded path prefixes (default /api, plus caller extras)", async () => {
    expect(await spaLoginGuard(htmlReq("/api/anything"), WEB_DB, WEB_URL)).toBeNull();
    expect(await spaLoginGuard(htmlReq("/internal/x"), WEB_DB, WEB_URL, ["/api", "/internal", "/public"])).toBeNull();
    expect(await spaLoginGuard(htmlReq("/public/media/k"), WEB_DB, WEB_URL, ["/api", "/internal", "/public"])).toBeNull();
  });

  it("redirects an HTML navigation without a session cookie to WEB_URL/login", async () => {
    const res = await spaLoginGuard(htmlReq("/flows"), WEB_DB, WEB_URL);
    expect(res?.status).toBe(302);
    expect(res?.headers.get("Location")).toBe("https://web.test/login");
  });

  it("redirects when the session is unknown or expired", async () => {
    const unknown = await spaLoginGuard(htmlReq("/flows", "session=sa-nope"), WEB_DB, WEB_URL);
    expect(unknown?.status).toBe(302);
    const expired = await spaLoginGuard(htmlReq("/flows", "session=sa-expired"), WEB_DB, WEB_URL);
    expect(expired?.status).toBe(302);
  });

  it("lets a valid session through", async () => {
    expect(await spaLoginGuard(htmlReq("/flows", "session=sa-valid"), WEB_DB, WEB_URL)).toBeNull();
  });
});
