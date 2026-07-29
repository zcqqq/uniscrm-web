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

// ContentService's D1 truth (2026-07-26 plan) — this file exercises the real content.ts, so
// tenantDb needs a working query() rather than an entity_state claim() (mirrors
// content.test.ts's createMockTenantDb and x-followers.test.ts's identical pattern for
// UsersService). Probe SELECTs default to "no existing row" so the common case is an insert;
// the RETURNING upsert echoes back the bound id/created_at, i.e. "this writer won the race". A
// test that wants an existing row (the "already known" half of the zero-new-tweets test) seeds
// `existingBySourceId`.
function createMockTenantDb(existingBySourceId: Record<string, Record<string, unknown>> = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    if (/^\s*INSERT/i.test(sql)) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      const prior = existingBySourceId[String(row.source_content_id)];
      return [{ id: prior ? prior.id : row.id, created_at: prior ? prior.created_at : row.created_at }];
    }
    // probe SELECT: params are [channelId, sourceContentId] (or +listId, unused here)
    const prior = existingBySourceId[String(params[1])];
    return prior ? [prior] : [];
  });
  return { query, run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };
}

function knownPost(sourceContentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `stored-${sourceContentId}`,
    created_at: "2026-07-01T00:00:00.000Z",
    content_type: "TWEET", content_text: "a", title: null, source_created_at: null,
    bookmark_count: null, view_count: null, like_count: null, quote_count: null,
    reply_count: null, repost_count: null, share_count: null,
    cover_image_url: null, duration: null, height: null, width: null, has_face: null,
    ...overrides,
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

  function baseCtx(linkDb: any, tenantDb: any, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      channelId: "chan1", xUserId: "x1", accessToken: "tok",
      linkDb: linkDb as any, tenantDb: tenantDb as any, tenantId: 1,
      ai: createMockAi() as any, vectorize: createMockVectorize() as any,
      pipelineContent: createMockPipelineContent() as any,
      deadline: Date.now() + 20_000,
      ...overrides,
    };
  }

  it("does nothing when no poll_state row exists (channel not yet authorized)", async () => {
    const linkDb = createMockLinkDb(null);
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfill: pages until no next_token, then marks backfill_complete", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "world" }], meta: {} }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // one D1 upsert per tweet
    const upserts = tenantDb.query.mock.calls.filter((c: unknown[]) => /^\s*INSERT/i.test(String(c[0])));
    expect(upserts).toHaveLength(2);
    expect(linkDb._run).toHaveBeenCalled();
  });

  it("backfill: stops on 429 and persists the cursor for next run", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({}, 429));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const updateCalls = linkDb._bind.mock.calls.map((c: unknown[]) => c);
    const cursorPersisted = updateCalls.some((args: unknown[]) => args.includes("p2"));
    expect(cursorPersisted).toBe(true);
  });

  it("backfill: stops when the deadline has passed, without calling fetch", async () => {
    const linkDb = createMockLinkDb({ cursor: "resume-here", backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    await runPostsPoller(baseCtx(linkDb, tenantDb, { deadline: Date.now() - 1 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets content_type=ARTICLE when the tweet has an article structure, TWEET otherwise", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();
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

    await runPostsPoller(baseCtx(linkDb, tenantDb, { pipelineContent }));

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
    const tenantDb = createMockTenantDb();
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

    await runPostsPoller(baseCtx(linkDb, tenantDb, { pipelineContent }));

    const [[record]] = pipelineContent.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("id"); // source_content_id, column-mapped -> stripped
    // stripConsumedPaths deletes each consumed leaf but leaves the parent object in place even
    // once emptied (see content.ts's stripConsumedPaths doc comment) — every sub-field here is
    // column-mapped, so the object survives but empty, not absent.
    expect(raw.public_metrics).toEqual({});
    expect(raw.weird_unmapped_field).toBe("survives"); // never mapped -> must still be there
  });

  it("threads flowType (own:get-posts's metadata entry, never a literal) into upsertContentFromMetadata's 8th argument", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
    const tenantDb = createMockTenantDb();

    fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    // The gate lives in content.ts (upsertContentFromMetadata throws on a non-"content"
    // flowType) — a successful D1 write here is the proof the poller passed "content" through.
    const upserts = tenantDb.query.mock.calls.filter((c: unknown[]) => /^\s*INSERT/i.test(String(c[0])));
    expect(upserts).toHaveLength(1);
  });

  it("post-backfill: stops after a page with zero new tweets", async () => {
    const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
    // page 1: tweet "t1" is new (absent from D1); page 2: tweet "t2" already known, unchanged
    const tenantDb = createMockTenantDb({ t2: knownPost("t2", { content_text: "b" }) });

    fetchMock
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "a" }], meta: { next_token: "p2" } }))
      .mockImplementationOnce(() => jsonResponse({ data: [{ id: "t2", text: "b" }], meta: { next_token: "p3" } }));

    await runPostsPoller(baseCtx(linkDb, tenantDb));

    // stops after page 2 (zero new tweets there) even though a next_token existed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("x-posts poller: content.created emission gating", () => {
    it("does not emit content.created during backfill even for new posts", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 0, last_polled_at: null });
      const tenantDb = createMockTenantDb();
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

      fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

      await runPostsPoller(baseCtx(linkDb, tenantDb, { flowQueue }));

      expect(flowQueue.send).not.toHaveBeenCalled();
    });

    it("emits content.created during incremental polling for new posts", async () => {
      const linkDb = createMockLinkDb({ cursor: null, backfill_complete: 1, last_polled_at: "2026-07-10T00:00:00.000Z" });
      const tenantDb = createMockTenantDb();
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };

      fetchMock.mockImplementationOnce(() => jsonResponse({ data: [{ id: "t1", text: "hello" }], meta: {} }));

      await runPostsPoller(baseCtx(linkDb, tenantDb, { flowQueue }));

      expect(flowQueue.send).toHaveBeenCalledTimes(1);
      expect(flowQueue.send.mock.calls[0][0]).toMatchObject({ eventType: "content.created", channelId: "chan1" });
    });
  });
});
