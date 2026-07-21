import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordYouTubeWriteQuota, pacificDateKey } from "../../src/services/youtube-quota";

function makeKV(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v; }),
    _store: store,
  };
}

describe("youtube-quota", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("pacificDateKey returns YYYY-MM-DD", () => {
    expect(pacificDateKey(new Date("2026-07-21T20:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("increments the daily counter by 50", async () => {
    const KV = makeKV();
    const env = { KV } as any;
    await recordYouTubeWriteQuota(env);
    const key = `yt_quota:${pacificDateKey()}`;
    expect(Number(KV._store[key])).toBe(50);
  });

  it("alerts once when crossing 8000 units", async () => {
    const key = `yt_quota:${pacificDateKey()}`;
    const KV = makeKV({ [key]: "7980" });
    const env = { KV } as any;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordYouTubeWriteQuota(env); // 7980 -> 8030, crosses 8000
    expect(errSpy).toHaveBeenCalledTimes(1);
    // second crossing does not re-alert (flag set)
    await recordYouTubeWriteQuota(env);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
