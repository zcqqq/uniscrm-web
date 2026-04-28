import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionService } from "../../worker/auth/session";

describe("SessionService", () => {
  let kv: any;
  let service: SessionService;

  beforeEach(() => {
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    service = new SessionService(kv);
  });

  describe("create", () => {
    it("stores session in KV with 7-day TTL", async () => {
      const session = await service.create("user-1", "test@example.com");

      expect(session).toMatch(/^[a-z0-9-]+$/);
      expect(kv.put).toHaveBeenCalledWith(
        `session:${session}`,
        expect.stringContaining('"user_id":"user-1"'),
        { expirationTtl: 604800 }
      );
    });
  });

  describe("get", () => {
    it("returns session data when valid", async () => {
      const data = JSON.stringify({
        user_id: "user-1",
        email: "test@example.com",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
      kv.get.mockResolvedValue(data);

      const result = await service.get("session-id");

      expect(result).toEqual(expect.objectContaining({ user_id: "user-1" }));
    });

    it("returns null when session not found", async () => {
      const result = await service.get("missing");
      expect(result).toBeNull();
    });
  });

  describe("destroy", () => {
    it("deletes session from KV", async () => {
      await service.destroy("session-id");
      expect(kv.delete).toHaveBeenCalledWith("session:session-id");
    });
  });
});
