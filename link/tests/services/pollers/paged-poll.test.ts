import { describe, it, expect, vi, afterEach } from "vitest";
import { runPagedPoll, type PagedPollConfig, type PolledPage } from "../../../src/services/pollers/paged-poll";

// These tests drive the module through its own interface — they are the single place the
// paging/state invariants (not-seeded guard, cursor persistence + resume, deadline
// interruption, rate-limit stop, backfill_complete transition, since_id
// advance-only-when-fully-drained, last_polled_at tail) are proven for EVERY adapter at once.
// The per-poller test files only need to cover their own mapping/upsert logic on top.

interface SqlCall {
  sql: string;
  args: unknown[];
}

function createMockLinkDb(state: Record<string, unknown> | null) {
  const calls: SqlCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => {
      calls.push({ sql, args });
      return {
        first: vi.fn().mockResolvedValue(state ? { ...state } : null),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
    },
  }));
  return { prepare, calls };
}

function seededState(overrides: Record<string, unknown> = {}) {
  return { cursor: null, backfill_complete: 0, last_polled_at: null, since_id: null, ...overrides };
}

function page(overrides: Partial<PolledPage> = {}): PolledPage {
  return { items: [{ id: "x" }], nextCursor: null, rateLimited: false, ...overrides };
}

function makeCfg(
  linkDb: ReturnType<typeof createMockLinkDb>,
  pages: PolledPage[],
  overrides: Partial<PagedPollConfig<PolledPage>> = {}
) {
  const fetchPage = vi.fn();
  for (const p of pages) fetchPage.mockResolvedValueOnce(p);
  const upsertPage = vi.fn(async (p: PolledPage, _emitFlowEvent: boolean) => p.items.length);
  return {
    cfg: {
      linkDb: linkDb as unknown as D1Database,
      channelId: "chan1",
      pollerName: "posts",
      deadline: Date.now() + 20_000,
      mode: "paged" as const,
      logPrefix: "posts_poll",
      fetchPage,
      upsertPage,
      ...overrides,
    } satisfies PagedPollConfig<PolledPage>,
    fetchPage,
    upsertPage,
  };
}

function updates(linkDb: ReturnType<typeof createMockLinkDb>): SqlCall[] {
  return linkDb.calls.filter((c) => c.sql.includes("UPDATE channel_poll_state"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runPagedPoll: not-seeded guard", () => {
  it("does nothing when no poll_state row exists", async () => {
    const linkDb = createMockLinkDb(null);
    const { cfg, fetchPage } = makeCfg(linkDb, []);

    await runPagedPoll(cfg);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(updates(linkDb)).toHaveLength(0);
  });

  it("treats an empty row object ({}) as not seeded (D1 .first() quirk)", async () => {
    const linkDb = createMockLinkDb({});
    const { cfg, fetchPage } = makeCfg(linkDb, []);

    await runPagedPoll(cfg);

    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("probes with the bound poller_name (computed names like list_posts:<id> included)", async () => {
    const linkDb = createMockLinkDb(null);
    const { cfg } = makeCfg(linkDb, [], { pollerName: "list_posts:listA" });

    await runPagedPoll(cfg);

    const probe = linkDb.calls.find((c) => c.sql.includes("SELECT"));
    expect(probe!.sql).toContain("poller_name = ?");
    expect(probe!.args).toEqual(["chan1", "list_posts:listA"]);
  });
});

describe("runPagedPoll: paged backfill", () => {
  it("pages until nextCursor is null, persisting each cursor, then marks backfill_complete (cursor cleared, last_polled_at set)", async () => {
    const linkDb = createMockLinkDb(seededState());
    const { cfg, fetchPage, upsertPage } = makeCfg(linkDb, [
      page({ nextCursor: "p2" }),
      page({ nextCursor: null }),
    ]);

    await runPagedPoll(cfg);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0][0]).toMatchObject({ cursor: null, phase: "backfill", sinceId: null });
    expect(fetchPage.mock.calls[1][0]).toMatchObject({ cursor: "p2" });
    // backfill never emits flow events
    expect(upsertPage.mock.calls.every((c) => c[1] === false)).toBe(true);
    // page-boundary cursor persisted
    const cursorWrite = updates(linkDb).find((c) => c.sql.includes("SET cursor = ?"));
    expect(cursorWrite!.args).toEqual(["p2", "chan1", "posts"]);
    // completion transition: one UPDATE clears cursor, flips the flag, stamps last_polled_at
    const complete = updates(linkDb).find((c) => c.sql.includes("backfill_complete = 1"));
    expect(complete!.sql).toContain("cursor = NULL");
    expect(complete!.sql).toContain("last_polled_at = datetime('now')");
  });

  it("resumes from the stored cursor", async () => {
    const linkDb = createMockLinkDb(seededState({ cursor: "resume-here" }));
    const { cfg, fetchPage } = makeCfg(linkDb, [page()]);

    await runPagedPoll(cfg);

    expect(fetchPage.mock.calls[0][0]).toMatchObject({ cursor: "resume-here" });
  });

  it("deadline in the past: fetches nothing, writes nothing", async () => {
    const linkDb = createMockLinkDb(seededState({ cursor: "resume-here" }));
    const { cfg, fetchPage } = makeCfg(linkDb, [], { deadline: Date.now() - 1 });

    await runPagedPoll(cfg);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(updates(linkDb)).toHaveLength(0);
  });

  it("deadline mid-backfill: stops after the current page with its cursor persisted (resume point), no backfill_complete, no last_polled_at", async () => {
    vi.useFakeTimers();
    const linkDb = createMockLinkDb(seededState());
    const { cfg, fetchPage } = makeCfg(linkDb, [], { deadline: Date.now() + 1000 });
    fetchPage.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 2000); // budget burns while the page is in flight
      return page({ nextCursor: "p2" });
    });

    await runPagedPoll(cfg);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    const cursorWrite = updates(linkDb).find((c) => c.sql.includes("SET cursor = ?"));
    expect(cursorWrite!.args[0]).toBe("p2");
    expect(updates(linkDb).some((c) => c.sql.includes("backfill_complete = 1"))).toBe(false);
    expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(false);
  });

  it("rate limit: stops immediately — no upsert, no cursor write, no backfill_complete, no last_polled_at", async () => {
    const linkDb = createMockLinkDb(seededState());
    const { cfg, upsertPage } = makeCfg(linkDb, [page({ rateLimited: true })]);

    await runPagedPoll(cfg);

    expect(upsertPage).not.toHaveBeenCalled();
    expect(updates(linkDb)).toHaveLength(0);
  });
});

describe("runPagedPoll: paged incremental", () => {
  const incrementalState = () => seededState({ backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });

  it("starts from a fresh cursor (never the stored backfill cursor) and emits flow events", async () => {
    const linkDb = createMockLinkDb(seededState({ backfill_complete: 1, cursor: "stale-backfill-cursor" }));
    const { cfg, fetchPage, upsertPage } = makeCfg(linkDb, [page()]);

    await runPagedPoll(cfg);

    expect(fetchPage.mock.calls[0][0]).toMatchObject({ cursor: null, phase: "incremental" });
    expect(upsertPage.mock.calls[0][1]).toBe(true);
  });

  it("stops after a page with zero new items and stamps last_polled_at", async () => {
    const linkDb = createMockLinkDb(incrementalState());
    const { cfg, fetchPage, upsertPage } = makeCfg(linkDb, [
      page({ nextCursor: "p2" }),
      page({ nextCursor: "p3" }),
    ]);
    upsertPage.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await runPagedPoll(cfg);

    expect(fetchPage).toHaveBeenCalledTimes(2); // p3 never fetched despite existing
    expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
  });

  it("rate limit mid-round: stops but STILL stamps last_polled_at (unlike backfill)", async () => {
    const linkDb = createMockLinkDb(incrementalState());
    const { cfg, upsertPage } = makeCfg(linkDb, [
      page({ nextCursor: "p2" }),
      page({ rateLimited: true }),
    ]);

    await runPagedPoll(cfg);

    expect(upsertPage).toHaveBeenCalledTimes(1);
    expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
  });

  describe("since_id watermark: advance only when all new pages were consumed", () => {
    const withWatermark = { useSinceIdWatermark: true };

    function sinceIdWrite(linkDb: ReturnType<typeof createMockLinkDb>) {
      return updates(linkDb).find((c) => c.sql.includes("SET since_id"));
    }

    it("passes the stored since_id to incremental fetches (and null during backfill)", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg, fetchPage } = makeCfg(linkDb, [page()], withWatermark);

      await runPagedPoll(cfg);

      expect(fetchPage.mock.calls[0][0]).toMatchObject({ sinceId: "t100" });
    });

    it("backfill ignores the watermark — the full history walk must be unfiltered", async () => {
      const linkDb = createMockLinkDb(seededState({ since_id: "t100" }));
      const { cfg, fetchPage } = makeCfg(linkDb, [page()], withWatermark);

      await runPagedPoll(cfg);

      expect(fetchPage.mock.calls[0][0]).toMatchObject({ phase: "backfill", sinceId: null });
    });

    it("advances on no_next_page: the round drained everything", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg } = makeCfg(linkDb, [page({ newestId: "t9", nextCursor: null })], withWatermark);

      await runPagedPoll(cfg);

      const write = sinceIdWrite(linkDb);
      expect(write!.args).toEqual(["t9", "chan1", "posts"]);
      // the watermark write and last_polled_at land in the same UPDATE (one write, both fields)
      expect(write!.sql).toContain("last_polled_at = datetime('now')");
    });

    it("advances on no_new_content, using the FIRST page's newestId (results are newest-first)", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg, upsertPage } = makeCfg(
        linkDb,
        [page({ newestId: "t9", nextCursor: "p2" }), page({ newestId: "t5", nextCursor: "p3" })],
        withWatermark
      );
      upsertPage.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      await runPagedPoll(cfg);

      expect(sinceIdWrite(linkDb)!.args[0]).toBe("t9");
    });

    it("does NOT advance on rate limit — older new posts are still owed; advancing would skip them forever", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg } = makeCfg(
        linkDb,
        [page({ newestId: "t9", nextCursor: "p2" }), page({ rateLimited: true })],
        withWatermark
      );

      await runPagedPoll(cfg);

      expect(sinceIdWrite(linkDb)).toBeUndefined();
      expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
    });

    it("does NOT advance on deadline — same debt as rate limit", async () => {
      vi.useFakeTimers();
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg, fetchPage } = makeCfg(linkDb, [], { ...withWatermark, deadline: Date.now() + 1000 });
      fetchPage.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 2000);
        return page({ newestId: "t9", nextCursor: "p2" });
      });

      await runPagedPoll(cfg);

      expect(sinceIdWrite(linkDb)).toBeUndefined();
      expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
    });

    it("empty round (no newestId reported): keeps the old watermark, never writes null", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg, upsertPage } = makeCfg(linkDb, [page({ items: [], nextCursor: null })], withWatermark);
      upsertPage.mockResolvedValueOnce(0);

      await runPagedPoll(cfg);

      expect(sinceIdWrite(linkDb)).toBeUndefined();
      expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
    });

    it("a poller without useSinceIdWatermark never sees or writes a watermark, even when pages report newestId", async () => {
      const linkDb = createMockLinkDb({ ...incrementalState(), since_id: "t100" });
      const { cfg, fetchPage } = makeCfg(linkDb, [page({ newestId: "t9", nextCursor: null })]);

      await runPagedPoll(cfg);

      expect(fetchPage.mock.calls[0][0]).toMatchObject({ sinceId: null });
      expect(sinceIdWrite(linkDb)).toBeUndefined();
      expect(updates(linkDb).some((c) => c.sql.includes("last_polled_at"))).toBe(true);
    });
  });
});

describe("runPagedPoll: latest-page mode", () => {
  const latest = { mode: "latest-page" as const, logPrefix: "list_posts_poll", pollerName: "list_posts:listA" };

  it("seed: one fetch, no pagination even when a nextCursor exists, emitFlowEvent=false, then backfill_complete", async () => {
    const linkDb = createMockLinkDb(seededState());
    const { cfg, fetchPage, upsertPage } = makeCfg(linkDb, [page({ nextCursor: "p2" })], latest);

    await runPagedPoll(cfg);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(upsertPage.mock.calls[0][1]).toBe(false);
    const complete = updates(linkDb).find((c) => c.sql.includes("backfill_complete = 1"));
    expect(complete!.args).toEqual(["chan1", "list_posts:listA"]);
  });

  it("seed rate-limited: leaves backfill_complete unset so the next cron cycle retries; no writes at all", async () => {
    const linkDb = createMockLinkDb(seededState());
    const { cfg, upsertPage } = makeCfg(linkDb, [page({ rateLimited: true })], latest);

    await runPagedPoll(cfg);

    expect(upsertPage).not.toHaveBeenCalled();
    expect(updates(linkDb)).toHaveLength(0);
  });

  it("incremental: one fetch, emitFlowEvent=true, stamps last_polled_at", async () => {
    const linkDb = createMockLinkDb(seededState({ backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" }));
    const { cfg, fetchPage, upsertPage } = makeCfg(linkDb, [page()], latest);

    await runPagedPoll(cfg);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(upsertPage.mock.calls[0][1]).toBe(true);
    const tail = updates(linkDb).find((c) => c.sql.includes("last_polled_at"));
    expect(tail!.args).toEqual(["chan1", "list_posts:listA"]);
  });

  it("incremental rate-limited: no last_polled_at — a no-work cycle must not delay the next attempt by a throttle interval", async () => {
    const linkDb = createMockLinkDb(seededState({ backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" }));
    const { cfg } = makeCfg(linkDb, [page({ rateLimited: true })], latest);

    await runPagedPoll(cfg);

    expect(updates(linkDb)).toHaveLength(0);
  });
});

describe("runPagedPoll: error propagation", () => {
  class FakeUnauthorizedError extends Error {}

  it("fetchPage errors escape unchanged (token-refresh retry / freeze breaker live upstream), with no tail write", async () => {
    const linkDb = createMockLinkDb(seededState({ backfill_complete: 1 }));
    const { cfg, fetchPage } = makeCfg(linkDb, []);
    fetchPage.mockRejectedValueOnce(new FakeUnauthorizedError("401"));

    await expect(runPagedPoll(cfg)).rejects.toBeInstanceOf(FakeUnauthorizedError);
    expect(updates(linkDb)).toHaveLength(0);
  });

  it("upsertPage errors escape unchanged too", async () => {
    const linkDb = createMockLinkDb(seededState());
    const { cfg, upsertPage } = makeCfg(linkDb, [page()]);
    upsertPage.mockRejectedValueOnce(new Error("tenant D1 down"));

    await expect(runPagedPoll(cfg)).rejects.toThrow("tenant D1 down");
  });
});
