import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPostsPoller } from "../../src/services/pollers/x-posts";

function createMockLinkDb(initialState: { cursor: string | null; backfill_complete: number; last_polled_at: string | null } | null) {
  const state = { ...initialState } as any;
  const first = vi.fn().mockImplementation(() => Promise.resolve(state ? { ...state } : null));
  const run = vi.fn().mockImplementation(() => Promise.resolve({ success: true }));
  const bind = vi.fn().mockReturnValue({ first, run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, _state: state, _run: run, _bind: bind };
}

// ContentService isn't mocked in this file (unlike tiktok-content.test.ts) — it exercises the
// real content.ts, so entityState needs a working claim() rather than a D1-shaped tenantDb.
// Every test either relies on the default (always new/changed) or overrides claim per-call to
// simulate "already seen" the same way x-followers.test.ts does for XUsersService.
function createMockEntityState() {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "uuid-default", isNew: true, unchanged: false }),
    get: vi.fn().mockResolvedValue(null),
    markSeen: vi.fn().mockResolvedValue(true),
    setFollow: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

function createMockPipelineContent() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

describe("runPostsPoller", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  function baseCtx(linkDb: any, entityState: any, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, entityState: entityState as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      pipelineContent: createMockPipelineContent() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const entityState = createMockEntityState();

    await runPostsPoller(baseCtx(linkDb, entityState));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "world" }], meta: {} }));

    await runPostsPoller(baseCtx(linkDb, entityState));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(entityState.claim).toHaveBeenCalledTimes(2); // one claim per tweet
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runPostsPoller(baseCtx(linkDb, entityState));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();

    await runPostsPoller(baseCtx(linkDb, entityState, { deadline: Date.now() - 1 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets content_type=ARTICLE when the tweet has an article structure, TWEET otherwise", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();
    const pipelineContent = createMockPipelineContent();

    fetchMock.mockImplementationOnce(() =>
      jsonResponse({
        data: [
          { id: "t1", text: "plain tweet" },
          { id: "t2", text: "https://t.co/x", article: { title: "Free Skill - some article" } },
        ],
        meta: {},
      })
    );

    await runPostsPoller(baseCtx(linkDb, entityState, { pipelineContent }));

    const sentRecords = pipelineContent.send.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>[])[0]);
    const tweetRecord = sentRecords.find((r) => r.source_content_id === "t1")!;
    const articleRecord = sentRecords.find((r) => r.source_content_id === "t2")!;
    expect(tweetRecord.content_type).toBe("TWEET");
    expect(articleRecord.content_type).toBe("ARTICLE");
    expect(articleRecord.title).toBe("Free Skill - some article");
  });

  // Task-7 fix round 2: regression-proof that upsertPage actually threads consumedPaths into
  // upsertContentFromMetadata's 7th argument — content.test.ts's "consumedPaths threading"
  // tests reproduce resolveProps -> consumedPaths -> upsertContentFromMetadata inline with
  // hand-built data, so they'd stay green even if x-posts.ts stopped passing the argument
  // entirely. This test drives the real poller entry point and asserts on the emitted record's
  // raw_data content — both that mapped fields are gone AND that an unmapped one survives
  // (asserting only absence would also pass if raw_data were empty/missing, e.g. the
  // consumedPaths-omitted fallback in content.ts, which stores nothing usable either).
  it("threads consumedPaths into upsertContentFromMetadata so raw_data strips mapped payload fields, keeping unmapped ones (task-7 fix round 2)", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const entityState = createMockEntityState();
    const pipelineContent = createMockPipelineContent();

    fetchMock.mockImplementationOnce(() =>
      jsonResponse({
        data: [{
          id: "t3",
          text: "hello",
          public_metrics: { bookmark_count: 5, impression_count: 10, like_count: 1, quote_count: 0, reply_count: 2, retweet_count: 3 },
          weird_unmapped_field: "survives",
        }],
        meta: {},
      })
    );

    await runPostsPoller(baseCtx(linkDb, entityState, { pipelineContent }));

    const [[record]] = pipelineContent.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("id"); // source_content_id, column-mapped -> stripped
    // stripConsumedPaths deletes each consumed leaf but leaves the parent object in place even
    // once emptied (see content.ts's stripConsumedPaths doc comment) — every sub-field here is
    // column-mapped, so the object survives but empty, not absent.
    expect(raw.public_metrics).toEqual({});
    expect(raw.weird_unmapped_field).toBe("survives"); // never mapped -> must still be there
  });

  it("post-backfill: stops after a page with zero new tweets", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    const entityState = createMockEntityState();
    // page 1: tweet "t1" is new; page 2: tweet "t2" already known (isNew: false, unchanged)
    entityState.claim
      .mockImplementationOnce(async () => ({ entityId: "uuid-t1", isNew: true, unchanged: false }))
      .mockImplementationOnce(async () => ({ entityId: "uuid-t2", isNew: false, unchanged: true }));

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "b" }], meta: { next_token: "p3" } }));

    await runPostsPoller(baseCtx(linkDb, entityState));

    // stops after page 2 (zero new tweets there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("x-posts poller: content.created emission gating", () => {
    it("does not emit content.created during backfill even for new posts", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
      const entityState = createMockEntityState();
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

      fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

      await runPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

      expect(flowQueue.send).not.toHaveBeenCalled();
    });

    it("emits content.created during incremental polling for new posts", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
      const entityState = createMockEntityState();
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

      fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

      await runPostsPoller(baseCtx(linkDb, entityState, { flowQueue }));

      expect(flowQueue.send).toHaveBeenCalledTimes(1);
      expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1" });
    });
  });
});
