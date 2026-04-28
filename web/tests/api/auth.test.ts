import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";

describe("auth routes", () => {
  let db: any;
  let kv: any;
  let app: Hono;

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
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"id":"msg"}', { status: 200 })));
    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = {
        DB: db,
        KV: kv,
        RESEND_API_KEY: "re_test",
        APP_URL: "https://app.example.com",
      };
      return next();
    });
    app.route("/auth", createAuthRouter());
  });

  describe("POST /auth/login", () => {
    it("returns 400 for missing email", async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("creates magic link and sends email", async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      });
      expect(res.status).toBe(200);
      expect(db.prepare).toHaveBeenCalled();
    });
  });

  describe("GET /auth/verify", () => {
    it("returns 400 for missing token", async () => {
      const res = await app.request("/auth/verify");
      expect(res.status).toBe(400);
    });

    it("returns 401 for invalid token", async () => {
      const res = await app.request("/auth/verify?token=bad");
      expect(res.status).toBe(401);
    });

    it("creates session and returns cookie for valid token", async () => {
      const future = new Date(Date.now() + 900000).toISOString();
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn()
            .mockResolvedValueOnce({ token: "tok", email: "u@e.com", expires_at: future, used: 0 })
            .mockResolvedValueOnce({ id: "user-1", email: "u@e.com" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      const res = await app.request("/auth/verify?token=tok");
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("session=");
    });
  });

  describe("POST /auth/logout", () => {
    it("clears session cookie", async () => {
      const res = await app.request("/auth/logout", {
        method: "POST",
        headers: { Cookie: "session=some-session-id" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /auth/me", () => {
    it("returns 401 when no session cookie", async () => {
      const res = await app.request("/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns user data for valid session", async () => {
      kv.get.mockResolvedValue(
        JSON.stringify({ user_id: "user-1", email: "u@e.com", expires_at: new Date(Date.now() + 86400000).toISOString() })
      );
      const res = await app.request("/auth/me", {
        headers: { Cookie: "session=valid-session-id" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toEqual({ id: "user-1", email: "u@e.com" });
    });
  });
});
