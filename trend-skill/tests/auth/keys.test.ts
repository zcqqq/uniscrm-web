import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiKeyService } from "../../src/auth/keys";

const makeD1Mock = () => {
  const rows: any[] = [];
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => rows[0] ?? null),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
    _rows: rows,
  } as unknown as D1Database;
};

describe("ApiKeyService", () => {
  let db: D1Database;
  let service: ApiKeyService;

  beforeEach(() => {
    db = makeD1Mock();
    service = new ApiKeyService(db);
  });

  it("create generates sk_trend_ prefixed key", async () => {
    const result = await service.create("free", "test-owner");
    expect(result.key).toMatch(/^sk_trend_[a-f0-9]{32}$/);
    expect(result.tier).toBe("free");
    expect(db.prepare).toHaveBeenCalled();
  });

  it("get returns null for unknown key", async () => {
    const result = await service.get("sk_trend_nonexistent");
    expect(result).toBeNull();
  });
});
