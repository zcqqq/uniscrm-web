import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";

describe("auth routes", () => {
  let db: any;
  let emailSend: any;
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
    emailSend = vi.fn().mockResolvedValue({ messageId: "msg-1" });
    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = {
        WEB_DB: db,
        EMAIL_WEB: { send: emailSend },
        WEB_URL: "https://app.example.com",
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

    it("creates magic link and sends email via EMAIL_WEB binding", async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      });
      expect(res.status).toBe(200);
      expect(db.prepare).toHaveBeenCalled();
      expect(emailSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "UniSCRM <noreply@uni-scrm.com>",
          to: "user@example.com",
          subject: "Sign in to UniSCRM",
        })
      );
    });

    it("returns 500 when email send fails", async () => {
      emailSend.mockRejectedValue(new Error("send failed"));
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      });
      expect(res.status).toBe(500);
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
            .mockResolvedValueOnce({ token: "tok", email: "u@e.com", expires_at: future, used: 0, trial: null, timezone: null })
            .mockResolvedValueOnce({ id: "member-1", tenant_id: 1, email: "u@e.com", preferred_location: "global", language: "en", timezone: "UTC" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      const res = await app.request("/auth/verify?token=tok");
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("session=");
      expect(res.headers.get("set-cookie")).toContain("lang=en");
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

    it("returns member data for valid session", async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn()
            .mockResolvedValueOnce({ member_id: "member-1", tenant_id: 1, email: "u@e.com", language: "en", expires_at: future })
            .mockResolvedValueOnce({ id: "member-1", tenant_id: 1, email: "u@e.com", preferred_location: "global", language: "en", timezone: "UTC" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });
      const res = await app.request("/auth/me", {
        headers: { Cookie: "session=valid-session-id" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.member).toEqual({ id: "member-1", email: "u@e.com", preferred_location: "global", language: "en", timezone: "UTC" });
    });
  });
});
