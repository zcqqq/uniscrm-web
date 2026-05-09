import { describe, it, expect, vi, beforeEach } from "vitest";
import { OAuthService } from "../../worker/services/oauth";

function createMockDb() {
  const mockRun = vi.fn().mockResolvedValue({ success: true });
  const mockFirst = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue({ results: [] });
  const mockBind = vi.fn().mockReturnValue({
    run: mockRun,
    first: mockFirst,
    all: mockAll,
  });
  const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });

  return {
    prepare: mockPrepare,
    _bind: mockBind,
    _first: mockFirst,
    _run: mockRun,
    _all: mockAll,
  };
}

function createMockKv() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OAuthService", () => {
  let db: ReturnType<typeof createMockDb>;
  let kv: ReturnType<typeof createMockKv>;
  let service: OAuthService;

  beforeEach(() => {
    db = createMockDb();
    kv = createMockKv();
    service = new OAuthService(db as any, kv as any);
  });

  describe("storeState", () => {
    it("stores state in KV with 5min TTL", async () => {
      const data = { codeVerifier: "verifier123", mode: "login" as const };
      await service.storeState("state-abc", data);

      expect(kv.put).toHaveBeenCalledWith(
        "oauth_state:state-abc",
        JSON.stringify(data),
        { expirationTtl: 300 }
      );
    });
  });

  describe("getState", () => {
    it("retrieves state and deletes it (one-time use)", async () => {
      const data = { codeVerifier: "verifier123", mode: "login" };
      kv.get.mockResolvedValue(JSON.stringify(data));

      const result = await service.getState("state-abc");

      expect(kv.get).toHaveBeenCalledWith("oauth_state:state-abc");
      expect(kv.delete).toHaveBeenCalledWith("oauth_state:state-abc");
      expect(result).toEqual(data);
    });

    it("returns null if state not found", async () => {
      kv.get.mockResolvedValue(null);

      const result = await service.getState("nonexistent");

      expect(result).toBeNull();
      expect(kv.delete).not.toHaveBeenCalled();
    });
  });

  describe("resolveUser", () => {
    it("returns existing user if oauth_account found", async () => {
      // First query: oauth_accounts lookup returns a user_id
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ user_id: "existing-user-id" }),
        }),
      });

      const result = await service.resolveUser("google", "goog-123", "user@test.com");

      expect(result).toEqual({ userId: "existing-user-id", isNew: false });
      expect(db.prepare).toHaveBeenCalledWith(
        "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
      );
    });

    it("links to existing user if email matches", async () => {
      // First query: oauth_accounts lookup returns null
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });
      // Second query: users lookup by email returns a user
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "email-user-id" }),
        }),
      });
      // Third query: INSERT into oauth_accounts
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });

      const result = await service.resolveUser("google", "goog-456", "existing@test.com");

      expect(result).toEqual({ userId: "email-user-id", isNew: false });
      expect(db.prepare).toHaveBeenCalledWith(
        "SELECT id FROM users WHERE email = ?"
      );
      expect(db.prepare).toHaveBeenCalledWith(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      );
    });

    it("creates new user if neither oauth_account nor email match", async () => {
      // First query: oauth_accounts lookup returns null
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });
      // Second query: users lookup by email returns null
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });
      // Third query: INSERT into users
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });
      // Fourth query: INSERT into oauth_accounts
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });

      const result = await service.resolveUser("google", "goog-789", "new@test.com");

      expect(result.isNew).toBe(true);
      expect(result.userId).toBeDefined();
      expect(db.prepare).toHaveBeenCalledWith(
        "INSERT INTO users (id, email, preferred_location, created_at) VALUES (?, ?, ?, ?)"
      );
    });
  });

  describe("linkAccount", () => {
    it("inserts oauth_account entry", async () => {
      // First query: check existing returns null
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });
      // Second query: INSERT
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });

      await service.linkAccount("user-1", "github", "gh-123");

      expect(db.prepare).toHaveBeenCalledWith(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      );
    });

    it("throws if already linked to a different user", async () => {
      // Check existing returns a different user
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ user_id: "other-user" }),
        }),
      });

      await expect(
        service.linkAccount("user-1", "github", "gh-123")
      ).rejects.toThrow("already linked");
    });
  });

  describe("unlinkAccount", () => {
    it("deletes oauth_account entry", async () => {
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });

      await service.unlinkAccount("user-1", "google");

      expect(db.prepare).toHaveBeenCalledWith(
        "DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?"
      );
    });
  });

  describe("getLinkedAccounts", () => {
    it("returns provider list for user", async () => {
      const accounts = [
        { provider: "google", created_at: "2025-01-01T00:00:00.000Z" },
        { provider: "github", created_at: "2025-01-02T00:00:00.000Z" },
      ];
      db.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: accounts }),
        }),
      });

      const result = await service.getLinkedAccounts("user-1");

      expect(result).toEqual(accounts);
      expect(db.prepare).toHaveBeenCalledWith(
        "SELECT provider, created_at FROM oauth_accounts WHERE user_id = ?"
      );
    });
  });

  describe("storePendingOAuth", () => {
    it("stores pending data in KV with 5min TTL", async () => {
      const data = { provider: "google", providerUserId: "g-1", email: "a@b.com" };
      await service.storePendingOAuth("pending-123", data);

      expect(kv.put).toHaveBeenCalledWith(
        "pending_oauth:pending-123",
        JSON.stringify(data),
        { expirationTtl: 300 }
      );
    });
  });

  describe("getPendingOAuth", () => {
    it("retrieves pending data from KV", async () => {
      const data = { provider: "google", providerUserId: "g-1", email: "a@b.com" };
      kv.get.mockResolvedValue(JSON.stringify(data));

      const result = await service.getPendingOAuth("pending-123");

      expect(kv.get).toHaveBeenCalledWith("pending_oauth:pending-123");
      expect(result).toEqual(data);
    });

    it("returns null if not found", async () => {
      const result = await service.getPendingOAuth("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("deletePendingOAuth", () => {
    it("deletes pending data from KV", async () => {
      await service.deletePendingOAuth("pending-123");
      expect(kv.delete).toHaveBeenCalledWith("pending_oauth:pending-123");
    });
  });
});
