import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAuth } from "../../src/auth/middleware";

const makeD1Mock = (row: any = null) => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue(row),
    }),
  }),
}) as unknown as D1Database;

describe("resolveAuth", () => {
  it("returns anonymous when no API key provided", async () => {
    const result = await resolveAuth(undefined, makeD1Mock());
    expect(result).toEqual({ tier: "anonymous", identifier: "anonymous" });
  });

  it("returns error for invalid key", async () => {
    const result = await resolveAuth("sk_trend_bad", makeD1Mock(null));
    expect(result).toEqual({ error: "Invalid API key", status: 401 });
  });

  it("returns error for deactivated key", async () => {
    const db = makeD1Mock({ key: "sk_trend_x", tier: "free", is_active: 0, expires_at: null });
    const result = await resolveAuth("sk_trend_x", db);
    expect(result).toEqual({ error: "API key deactivated", status: 403 });
  });

  it("returns error for expired key", async () => {
    const db = makeD1Mock({ key: "sk_trend_x", tier: "free", is_active: 1, expires_at: "2020-01-01T00:00:00Z" });
    const result = await resolveAuth("sk_trend_x", db);
    expect(result).toEqual({ error: "API key expired", status: 403 });
  });

  it("returns tier and identifier for valid key", async () => {
    const db = makeD1Mock({ key: "sk_trend_abc", tier: "premium", is_active: 1, expires_at: null });
    const result = await resolveAuth("sk_trend_abc", db);
    expect(result).toEqual({ tier: "premium", identifier: "sk_trend_abc" });
  });
});
