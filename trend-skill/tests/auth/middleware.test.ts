import { describe, it, expect, vi } from "vitest";
import { resolveAuth, type AuthContext } from "../../src/auth/middleware";
import type { ApiKeyRecord } from "../../src/types";

function createMockD1(record: ApiKeyRecord | null) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => record),
      })),
    })),
  } as unknown as D1Database;
}

describe("resolveAuth", () => {
  it("returns anonymous tier when no key provided", async () => {
    const db = createMockD1(null);
    const result = await resolveAuth(undefined, db);
    expect(result).toEqual({ tier: "anonymous", identifier: null });
  });

  it("returns the key's tier when key is valid and active", async () => {
    const record: ApiKeyRecord = {
      key: "sk_trend_abc",
      tier: "premium",
      owner_name: null,
      created_at: "2026-01-01T00:00:00Z",
      expires_at: null,
      is_active: 1,
    };
    const db = createMockD1(record);
    const result = await resolveAuth("sk_trend_abc", db);
    expect(result).toEqual({ tier: "premium", identifier: "sk_trend_abc" });
  });

  it("returns error when key does not exist", async () => {
    const db = createMockD1(null);
    const result = await resolveAuth("sk_trend_invalid", db);
    expect(result).toEqual({ error: "Invalid API key", status: 401 });
  });

  it("returns error when key is deactivated", async () => {
    const record: ApiKeyRecord = {
      key: "sk_trend_abc",
      tier: "free",
      owner_name: null,
      created_at: "2026-01-01T00:00:00Z",
      expires_at: null,
      is_active: 0,
    };
    const db = createMockD1(record);
    const result = await resolveAuth("sk_trend_abc", db);
    expect(result).toEqual({ error: "API key deactivated", status: 403 });
  });

  it("returns error when key is expired", async () => {
    const record: ApiKeyRecord = {
      key: "sk_trend_abc",
      tier: "free",
      owner_name: null,
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2025-01-01T00:00:00Z",
      is_active: 1,
    };
    const db = createMockD1(record);
    const result = await resolveAuth("sk_trend_abc", db);
    expect(result).toEqual({ error: "API key expired", status: 403 });
  });
});
