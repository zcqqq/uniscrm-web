import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateVideo, insertPlaylistItem, nextPacificMidnightISO } from "../../src/services/youtube-actions";

describe("youtube-actions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rateVideo returns ok on 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: true });
  });

  it("rateVideo maps 403 quotaExceeded to rateLimited with a reset time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), { status: 403 })));
    const r = await rateVideo("tok", "vid");
    expect(r.ok).toBe(false);
    expect(r.rateLimited).toBe(true);
    expect(typeof r.rateLimitReset).toBe("string");
  });

  it("rateVideo maps 401 to unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: false, unauthorized: true });
  });

  it("rateVideo maps other 4xx to failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    expect(await rateVideo("tok", "vid")).toEqual({ ok: false });
  });

  it("insertPlaylistItem returns ok on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })));
    expect(await insertPlaylistItem("tok", "pl", "vid")).toEqual({ ok: true });
  });

  it("nextPacificMidnightISO is in the future", () => {
    const iso = nextPacificMidnightISO(new Date());
    expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());
  });
});
