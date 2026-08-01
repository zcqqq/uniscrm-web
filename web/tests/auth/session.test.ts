import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionService } from "../../worker/auth/session";

// 会话存在 WEB_DB 的 sessions 表里，不是 KV —— 早期用 KV 出现过静默写入失败。
// 本文件先前测的是那版 KV 实现（`new SessionService(kv)` + 断言 expirationTtl），
// 实现换成 D1 后一直没跟上，2026-08-01 按真实实现重写。
function fakeDb(firstResult: Record<string, unknown> | null = null) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const first = vi.fn().mockResolvedValue(firstResult);
  const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } });

  const prepare = vi.fn((sql: string) => ({
    bind: (...params: unknown[]) => {
      calls.push({ sql, params });
      return { first, run };
    },
  }));

  return { db: { prepare } as unknown as D1Database, calls, first, run };
}

describe("SessionService", () => {
  describe("create", () => {
    it("inserts a row into sessions with a 7-day expiry", async () => {
      const { db, calls } = fakeDb();
      const service = new SessionService(db);

      const before = Date.now();
      const id = await service.create("member-1", 42, "test@example.com", "zh");

      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain("INSERT INTO sessions");

      const [rowId, memberId, tenantId, email, language, expiresAt] = calls[0].params;
      expect(rowId).toBe(id);
      expect(memberId).toBe("member-1");
      expect(tenantId).toBe(42);
      expect(email).toBe("test@example.com");
      expect(language).toBe("zh");

      // 7 天 ±1 分钟，够钉住 TTL 又不会因执行耗时抖动。
      const ttlMs = new Date(expiresAt as string).getTime() - before;
      expect(ttlMs).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 60_000);
      expect(ttlMs).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 60_000);
    });

    it("defaults language to en", async () => {
      const { db, calls } = fakeDb();
      await new SessionService(db).create("member-1", 42, "test@example.com");
      expect(calls[0].params[4]).toBe("en");
    });
  });

  describe("get", () => {
    it("returns the session when the row exists", async () => {
      const { db, calls } = fakeDb({
        member_id: "member-1",
        tenant_id: 42,
        email: "test@example.com",
        language: "zh",
        expires_at: "2030-01-01T00:00:00.000Z",
      });

      const result = await new SessionService(db).get("session-id");

      expect(result).toEqual({
        member_id: "member-1",
        tenant_id: 42,
        email: "test@example.com",
        language: "zh",
        expires_at: "2030-01-01T00:00:00.000Z",
      });
      // 过期会话必须由 SQL 直接排除，而不是取回来再由调用方判断。
      expect(calls[0].sql).toContain("expires_at > datetime('now')");
      expect(calls[0].params).toEqual(["session-id"]);
    });

    it("returns null when no row matches", async () => {
      const { db } = fakeDb(null);
      expect(await new SessionService(db).get("missing")).toBeNull();
    });
  });

  describe("destroy", () => {
    it("deletes only the given session", async () => {
      const { db, calls } = fakeDb();
      await new SessionService(db).destroy("session-id");

      expect(calls[0].sql).toContain("DELETE FROM sessions");
      expect(calls[0].params).toEqual(["session-id"]);
    });
  });

  describe("destroyOthers", () => {
    it("deletes the member's other sessions but keeps the current one", async () => {
      const { db, calls } = fakeDb();
      await new SessionService(db).destroyOthers("member-1", "keep-me");

      expect(calls[0].sql).toContain("DELETE FROM sessions");
      expect(calls[0].sql).toContain("id != ?");
      expect(calls[0].params).toEqual(["member-1", "keep-me"]);
    });
  });
});
