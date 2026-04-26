import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiKeyService } from "../../src/auth/keys";
import type { ApiKeyRecord } from "../../src/types";

function createMockD1() {
  const rows: ApiKeyRecord[] = [];
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        first: vi.fn(async () => rows.find((r) => r.key === args[0]) ?? null),
        run: vi.fn(async () => {
          if (sql.startsWith("INSERT")) {
            rows.push({
              key: args[0] as string,
              tier: args[1] as "free" | "premium",
              owner_name: args[2] as string | null,
              created_at: args[3] as string,
              expires_at: null,
              is_active: 1,
            });
          }
          return { success: true };
        }),
        all: vi.fn(async () => ({ results: rows })),
      })),
    })),
  } as unknown as D1Database;
}

describe("ApiKeyService", () => {
  let db: D1Database;
  let service: ApiKeyService;

  beforeEach(() => {
    db = createMockD1();
    service = new ApiKeyService(db);
  });

  it("creates a new API key with sk_trend_ prefix", async () => {
    const key = await service.create("premium", "Test User");
    expect(key).toMatch(/^sk_trend_[a-f0-9]{32}$/);
  });

  it("generates unique keys on each call", async () => {
    const key1 = await service.create("free");
    const key2 = await service.create("free");
    expect(key1).not.toBe(key2);
  });
});
