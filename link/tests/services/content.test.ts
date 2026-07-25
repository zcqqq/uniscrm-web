import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService } from "../../src/services/content";
import contentSchema from "../../../analytics/pipelines/content-stream-schema.json";

const SCHEMA_FIELD_NAMES = (contentSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();

function createMockEntityState(overrides: Partial<{ entityId: string; isNew: boolean; unchanged: boolean }> = {}) {
  return {
    claim: vi.fn().mockResolvedValue({ entityId: "c-uuid", isNew: true, unchanged: false, ...overrides }),
    markSeen: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn(),
    getFollowByEntityId: vi.fn(),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

describe("ContentService.upsertContentFromMetadata", () => {
  let entityState: ReturnType<typeof createMockEntityState>;
  let ai: ReturnType<typeof createMockAi>;
  let vectorize: ReturnType<typeof createMockVectorize>;
  let service: ContentService;

  beforeEach(() => {
    entityState = createMockEntityState();
    ai = createMockAi();
    vectorize = createMockVectorize();
    service = new ContentService(entityState as any, vectorize as any, ai as any, 42);
  });

  it("claims an entity_state id and returns isNew from the claim", async () => {
    const rawItem = { id: "t1", text: "hello world" };
    const resolvedProps = { source_content_id: "t1", content_type: "TWEET", content_text: "hello world" };

    const isNew = await service.upsertContentFromMetadata(rawItem, resolvedProps, "chan1", "X", false);

    expect(isNew).toBe(true);
    expect(entityState.claim).toHaveBeenCalledWith(
      { entity: "content", channelId: "chan1", secondaryId: "", sourceId: "t1" },
      expect.any(String)
    );
  });

  it("returns false when entity_state reports an existing (non-new) entity", async () => {
    entityState = createMockEntityState({ isNew: false, unchanged: false });
    service = new ContentService(entityState as any, vectorize as any, ai as any, 42);
    const resolvedProps = { source_content_id: "t1", content_text: "updated text" };

    const isNew = await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    expect(isNew).toBe(false);
  });

  it("sends a complete row to the content pipeline — every schema column present, null when absent", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

    await service.upsertContentFromMetadata(
      { id: "t1", text: "hi" },
      { source_content_id: "t1", content_type: "TWEET", content_text: "hi" },
      "chan1", "X", false
    );

    const [[record]] = pipeline.send.mock.calls[0];
    // I4: a spot-check of a few columns can't catch a writer that silently drops others —
    // compare the full key set against the R2 schema itself.
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
    expect(record.is_deleted).toBe(0);
    expect(record.tenant_id).toBe(42);
  });

  it("does not send to the pipeline when entity_state reports the fingerprint unchanged", async () => {
    const pipeline = { send: vi.fn() };
    const service = new ContentService(
      createMockEntityState({ isNew: false, unchanged: true }) as any,
      vectorize as any, ai as any, 42, pipeline as any
    );

    await service.upsertContentFromMetadata(
      { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false
    );

    expect(pipeline.send).not.toHaveBeenCalled();
  });

  // I5: propId ≠ payload field name (e.g. view_count ← public_metrics.impression_count), so
  // filtering raw_data by propId strings (the old behavior) stripped nothing for X content —
  // it shipped the entire tweet payload to R2. consumedPaths must be actual payload paths.
  describe("raw_data filtering via consumedPaths (I5)", () => {
    it("strips exactly the given consumedPaths, keeping everything else", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

      await service.upsertContentFromMetadata(
        { id: "t1", text: "hi", weird_field: 1 },
        { source_content_id: "t1", content_text: "hi" },
        "chan1", "X", false, undefined, ["text"]
      );

      const [[record]] = pipeline.send.mock.calls[0];
      const raw = JSON.parse(record.raw_data as string);
      expect(raw).toHaveProperty("weird_field", 1);
      expect(raw).toHaveProperty("id", "t1");
      expect(raw).not.toHaveProperty("text");
    });

    it("strips a nested path and leaves the parent object in place", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

      await service.upsertContentFromMetadata(
        { id: "t1", public_metrics: { impression_count: 100, like_count: 1 } },
        { source_content_id: "t1", view_count: 100 },
        "chan1", "X", false, undefined, ["public_metrics.impression_count"]
      );

      const [[record]] = pipeline.send.mock.calls[0];
      const raw = JSON.parse(record.raw_data as string);
      expect(raw.public_metrics).toEqual({ like_count: 1 });
    });

    it("tolerates a consumedPaths entry that does not exist in the payload", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

      await expect(service.upsertContentFromMetadata(
        { id: "t1" },
        { source_content_id: "t1" },
        "chan1", "X", false, undefined, ["nonexistent.path"]
      )).resolves.not.toThrow();
    });

    it("falls back to storing the entire payload and warns once when consumedPaths is omitted", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

      await service.upsertContentFromMetadata(
        { id: "t1", text: "hi", weird_field: 1 },
        { source_content_id: "t1", content_text: "hi" },
        "chan1", "X", false
      );

      const [[record]] = pipeline.send.mock.calls[0];
      const raw = JSON.parse(record.raw_data as string);
      expect(raw).toEqual({ id: "t1", text: "hi", weird_field: 1 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  it("writes content_type/content_text/source_created_at to their mapped columns", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      content_text: "hello world",
      source_created_at: "2026-07-11T00:00:00.000Z",
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBe("TWEET");
    expect(record.content_text).toBe("hello world");
    expect(record.source_created_at).toBe("2026-07-11T00:00:00.000Z");
  });

  it("writes title and the engagement metric props to their mapped columns", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);
    const resolvedProps = {
      source_content_id: "t1",
      title: "Free Skill - some article",
      bookmark_count: 3,
      view_count: 100,
      like_count: 1,
      quote_count: 0,
      reply_count: 2,
      repost_count: 5,
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record).toMatchObject({
      title: "Free Skill - some article",
      bookmark_count: 3,
      view_count: 100,
      like_count: 1,
      quote_count: 0,
      reply_count: 2,
      repost_count: 5,
    });
  });

  it("leaves an unresolved column-mapped field as null in the pipeline row", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);
    const resolvedProps = { source_content_id: "t1" }; // no content_type/content_text/source_created_at resolved

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBeNull();
    expect(record.content_text).toBeNull();
    expect(record.source_created_at).toBeNull();
  });

  it("triggers Vectorize embedding on insert", async () => {
    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", content_text: "hello" }, "chan1", "X", false);

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
  });

  it("throws when source_content_id is missing", async () => {
    await expect(
      service.upsertContentFromMetadata({ id: "t1" }, {}, "chan1", "X", false)
    ).rejects.toThrow("upsertContentFromMetadata: missing source_content_id");
  });

  describe("content.created emission (emitFlowEvent param)", () => {
    function createMockFlowQueue() {
      return { send: vi.fn().mockResolvedValue(undefined) };
    }

    it("sends content.created when isNew and emitFlowEvent is true", async () => {
      const flowQueue = createMockFlowQueue();
      const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata(
        { id: "t1" },
        { source_content_id: "t1", content_type: "TWEET", content_text: "hi" },
        "chan1",
        "X",
        true
      );

      expect(flowQueue.send).toHaveBeenCalledTimes(1);
      const [msg] = flowQueue.send.mock.calls[0];
      expect(msg).toMatchObject({
        tenantId: "42",
        eventType: "content.created",
        channelId: "chan1",
        payload: expect.objectContaining({ channel_type: "X", content_type: "TWEET" }),
      });
      expect(typeof msg.contentId).toBe("string");
      expect(msg.contentId.length).toBeGreaterThan(0);
    });

    it("does not send content.created when emitFlowEvent is false (backfill phase)", async () => {
      const flowQueue = createMockFlowQueue();
      const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata(
        { id: "t1" },
        { source_content_id: "t1", content_type: "TWEET" },
        "chan1",
        "X",
        false
      );

      expect(flowQueue.send).not.toHaveBeenCalled();
    });

    it("does not send content.created when the row already existed (isNew false), even if emitFlowEvent is true", async () => {
      const flowQueue = createMockFlowQueue();
      const svc = new ContentService(
        createMockEntityState({ isNew: false, unchanged: false }) as any,
        vectorize as any, ai as any, 42, undefined, flowQueue as any
      );

      await svc.upsertContentFromMetadata(
        { id: "t1" },
        { source_content_id: "t1", content_text: "updated" },
        "chan1",
        "X",
        true
      );

      expect(flowQueue.send).not.toHaveBeenCalled();
    });

    it("does not throw when no flowQueue was provided at all", async () => {
      const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42);

      await expect(
        svc.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", true)
      ).resolves.not.toThrow();
    });
  });

  describe("per-list dedup (listId param)", () => {
    it("keys the entity_state claim with an empty secondaryId when listId is not passed", async () => {
      await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false);

      expect(entityState.claim).toHaveBeenCalledWith(
        { entity: "content", channelId: "chan1", secondaryId: "", sourceId: "t1" },
        expect.any(String)
      );
    });

    it("keys the entity_state claim and the R2 record's list_id by listId when provided", async () => {
      const svcEntityState = createMockEntityState();
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(svcEntityState as any, vectorize as any, ai as any, 42, pipeline as any);

      await svc.upsertContentFromMetadata({ id: "t2" }, { source_content_id: "t2" }, "chan1", "X", false, "listA");

      expect(svcEntityState.claim).toHaveBeenCalledWith(
        { entity: "content", channelId: "chan1", secondaryId: "listA", sourceId: "t2" },
        expect.any(String)
      );
      const [[record]] = pipeline.send.mock.calls[0];
      expect(record.list_id).toBe("listA");
    });

    it("treats the same source_content_id in two different lists as two separate claims", async () => {
      await service.upsertContentFromMetadata({ id: "t3" }, { source_content_id: "t3" }, "chan1", "X", false, "listA");
      await service.upsertContentFromMetadata({ id: "t3" }, { source_content_id: "t3" }, "chan1", "X", false, "listB");

      expect(entityState.claim).toHaveBeenCalledTimes(2);
      expect(entityState.claim).toHaveBeenNthCalledWith(1,
        { entity: "content", channelId: "chan1", secondaryId: "listA", sourceId: "t3" },
        expect.any(String)
      );
      expect(entityState.claim).toHaveBeenNthCalledWith(2,
        { entity: "content", channelId: "chan1", secondaryId: "listB", sourceId: "t3" },
        expect.any(String)
      );
    });

    it("includes listId in the emitted content.created message when provided", async () => {
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata({ id: "t4" }, { source_content_id: "t4" }, "chan1", "X", true, "listA");

      expect(flowQueue.send).toHaveBeenCalledTimes(1);
      const [msg] = flowQueue.send.mock.calls[0];
      expect(msg).toMatchObject({ eventType: "content.created", channelId: "chan1", listId: "listA" });
    });

    it("omits listId from the emitted message entirely when not provided (not just undefined)", async () => {
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata({ id: "t5" }, { source_content_id: "t5" }, "chan1", "X", true);

      const [msg] = flowQueue.send.mock.calls[0];
      expect("listId" in msg).toBe(false);
    });
  });
});

// M1: syncBatch gained a claim key, a fingerprint, a pipeline send, and reworked
// added/updated/skipped accounting in this migration, none of it previously covered.
describe("ContentService.syncBatch", () => {
  function makeItem(overrides: Partial<{
    source_content_id: string;
    title: string;
    summary: string | null;
    source_url: string | null;
    source_updated_at: string | null;
    raw_data?: Record<string, unknown>;
  }> = {}) {
    return {
      source_content_id: "s1",
      title: "T",
      summary: null,
      source_url: null,
      source_updated_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("counts a new item as added and sends a complete row", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: true, unchanged: false });
    const service = new ContentService(entityState as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem()]);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(pipeline.send).toHaveBeenCalledTimes(1);
    const [[record]] = pipeline.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });

  it("counts an unchanged item as skipped and sends nothing", async () => {
    const pipeline = { send: vi.fn() };
    const entityState = createMockEntityState({ isNew: false, unchanged: true });
    const service = new ContentService(entityState as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem()]);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(pipeline.send).not.toHaveBeenCalled();
  });

  it("counts a changed existing item as updated", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ isNew: false, unchanged: false });
    const service = new ContentService(entityState as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem()]);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(pipeline.send).toHaveBeenCalledTimes(1);
  });

  // I2 + I3 regression test: channel-less imports must key on channel_type, not "". Keying on
  // "" made the R2 record's channel_id null (violating the schema's required column — R2
  // Pipelines silently drops such records) AND made two different channel types collide on the
  // same entity_state/partition key.
  it("keys the entity_state claim (and R2 channel_id) by channel_type, so the same source_content_id under two channel types is not the same entity", async () => {
    const entityState = createMockEntityState();
    entityState.claim
      .mockResolvedValueOnce({ entityId: "local-id", isNew: true, unchanged: false })
      .mockResolvedValueOnce({ entityId: "notion-id", isNew: true, unchanged: false });
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(entityState as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    await service.syncBatch("LOCAL", [makeItem({ source_content_id: "1" })]);
    await service.syncBatch("NOTION", [makeItem({ source_content_id: "1" })]);

    expect(entityState.claim).toHaveBeenNthCalledWith(1,
      { entity: "content", channelId: "LOCAL", secondaryId: "", sourceId: "1" },
      expect.any(String)
    );
    expect(entityState.claim).toHaveBeenNthCalledWith(2,
      { entity: "content", channelId: "NOTION", secondaryId: "", sourceId: "1" },
      expect.any(String)
    );

    const [[recordA]] = pipeline.send.mock.calls[0];
    const [[recordB]] = pipeline.send.mock.calls[1];
    expect(recordA.id).toBe("local-id");
    expect(recordB.id).toBe("notion-id");
    expect(recordA.channel_id).toBe("LOCAL");
    expect(recordB.channel_id).toBe("NOTION");
  });
});

describe("CONTENT_COLUMN_MAP coverage", () => {
  it("maps view_count, share_count, cover_image_url, duration, height, width, has_face to matching columns", async () => {
    const entityState = createMockEntityState();
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(entityState as any, vectorize as any, ai as any, 1, pipeline as any);

    await service.upsertContentFromMetadata(
      { id: "v1" },
      {
        source_content_id: "v1",
        content_type: "VIDEO",
        view_count: 100,
        share_count: 5,
        cover_image_url: "https://example.com/c.jpg",
        duration: 30,
        height: 1920,
        width: 1080,
        has_face: 1,
      },
      "chan-1",
      "TIKTOK",
      false
    );

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record).toMatchObject({
      view_count: 100,
      share_count: 5,
      cover_image_url: "https://example.com/c.jpg",
      duration: 30,
      height: 1920,
      width: 1080,
      has_face: 1,
    });
    expect(record.impression_count).toBeNull();
  });
});

describe("ContentService.buildEmbeddingText fallback (via embedContents through upsertContentFromMetadata)", () => {
  it("falls back to content_text when title is null", async () => {
    const entityState = createMockEntityState();
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const service = new ContentService(entityState as any, vectorize as any, ai as any, 42);

    await service.upsertContentFromMetadata(
      { id: "t1", text: "tweet body text" },
      { source_content_id: "t1", content_text: "tweet body text" },
      "chan1",
      "X",
      false
    );

    // no title resolved here, so the embedded text must fall back to content_text
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), { text: ["tweet body text"] });
  });
});

describe("recordPublishedContent", () => {
  let ai: ReturnType<typeof createMockAi>;
  let vectorize: ReturnType<typeof createMockVectorize>;

  beforeEach(() => {
    ai = createMockAi();
    vectorize = createMockVectorize();
  });

  it("sends a full content row referencing the source content and flow, without a status field", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("target-chan-1", "X", "tweet-123", "generated post text", {
      generatedFromContentId: "source-content-1",
      flowId: "flow-1",
    });

    expect(pipeline.send).toHaveBeenCalledTimes(1);
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record).toMatchObject({
      tenant_id: 42,
      channel_id: "target-chan-1",
      channel_type: "X",
      source_content_id: "tweet-123",
      content_type: "TWEET",
      content_text: "generated post text",
      is_deleted: 0,
    });
    expect(record).not.toHaveProperty("status");
    const rawData = JSON.parse(record.raw_data as string);
    expect(rawData).toEqual({ generatedFromContentId: "source-content-1", flowId: "flow-1" });
  });

  it("sends every schema column (I4)", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("target-chan-1", "X", "tweet-123", "generated post text", {
      generatedFromContentId: "source-content-1",
      flowId: "flow-1",
    });

    const [[record]] = pipeline.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });

  // 7.2: under D1 a bare crypto.randomUUID() was harmless (id was the PK). Under R2 this method
  // writes into the same (channel_id, list_id, source_content_id) business key every other
  // writer uses, so it must mint the id the same way — via entity_state.claim — or republishing
  // the same sourceContentId would produce two different ids in one partition.
  it("routes through entity_state.claim, keyed by sourceContentId, so the row id is stable per business key", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const entityState = createMockEntityState({ entityId: "stable-id" });
    const svc = new ContentService(entityState as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("chan1", "X", "tweet-1", "hello", {
      generatedFromContentId: "c1",
      flowId: "f1",
    });

    expect(entityState.claim).toHaveBeenCalledWith(
      { entity: "content", channelId: "chan1", secondaryId: "", sourceId: "tweet-1" },
      expect.any(String)
    );
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("stable-id");
  });

  it("stores an explicit contentType when given (e.g. TikTok's PHOTO_POST), instead of the hardcoded TWEET default", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent(
      "channel-1", "TIKTOK", "publish-id-1", "a caption",
      { generatedFromContentId: "content-1", flowId: "flow-1" },
      "PHOTO_POST"
    );

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBe("PHOTO_POST");
  });

  it("still defaults to TWEET when contentType is omitted (existing X call sites unaffected)", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("channel-2", "X", "tweet-id-1", "a tweet", {
      generatedFromContentId: "content-2",
      flowId: "flow-1",
    });

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBe("TWEET");
  });

  it("does nothing when no pipelineContent was provided", async () => {
    const svc = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42);

    await expect(
      svc.recordPublishedContent("channel-2", "X", "tweet-id-1", "a tweet", {
        generatedFromContentId: "content-2",
        flowId: "flow-1",
      })
    ).resolves.not.toThrow();
  });
});

describe("ContentService.recordTriggerContentSeen", () => {
  it("delegates to entityState.markSeen with the content_trigger entity kind", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(entityState as any, {} as any, {} as any, 42);

    const isNew = await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(isNew).toBe(true);
    expect(entityState.markSeen).toHaveBeenCalledWith({
      entity: "content_trigger",
      channelId: "chan1",
      secondaryId: "listA",
      sourceId: "t1",
    });
  });

  it("returns false when markSeen reports the row already existed", async () => {
    const entityState = createMockEntityState();
    entityState.markSeen.mockResolvedValue(false);
    const service = new ContentService(entityState as any, {} as any, {} as any, 42);

    const isNew = await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(isNew).toBe(false);
  });

  it("accepts an empty secondaryId for trigger types with no secondary dimension", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(entityState as any, {} as any, {} as any, 42);

    await service.recordTriggerContentSeen("chan1", "", "t1");

    expect(entityState.markSeen).toHaveBeenCalledWith({
      entity: "content_trigger",
      channelId: "chan1",
      secondaryId: "",
      sourceId: "t1",
    });
  });

  it("does not touch pipelineContent", async () => {
    const entityState = createMockEntityState();
    const pipelineContent = { send: vi.fn() };
    const service = new ContentService(entityState as any, {} as any, {} as any, 42, pipelineContent as any);

    await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(pipelineContent.send).not.toHaveBeenCalled();
  });

  it("throws for an empty sourceContentId", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(entityState as any, {} as any, {} as any, 42);

    await expect(service.recordTriggerContentSeen("chan1", "listA", "")).rejects.toThrow(
      "recordTriggerContentSeen: missing source_content_id"
    );
  });
});

describe("ContentService.emitContentTriggerEvent", () => {
  it("sends content.created with a freshly generated contentId and the named secondary field", async () => {
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42, undefined, flowQueue as any);

    await service.emitContentTriggerEvent("chan1", "X", "listId", "listA", { content_type: "TWEET" });

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
    const [msg] = flowQueue.send.mock.calls[0];
    expect(msg).toMatchObject({
      tenantId: "42",
      eventType: "content.created",
      channelId: "chan1",
      listId: "listA",
      payload: { channel_type: "X", content_type: "TWEET" },
    });
    expect(typeof msg.contentId).toBe("string");
    expect(msg.contentId.length).toBeGreaterThan(0);
  });

  it("omits the secondary field entirely when secondaryValue is empty (not just undefined)", async () => {
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42, undefined, flowQueue as any);

    await service.emitContentTriggerEvent("chan1", "YOUTUBE", "subscriptionChannelId", "", { content_type: "VIDEO" });

    const [msg] = flowQueue.send.mock.calls[0];
    expect("subscriptionChannelId" in msg).toBe(false);
  });

  it("does not throw when no flowQueue was provided", async () => {
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42);

    await expect(
      service.emitContentTriggerEvent("chan1", "X", "listId", "listA", {})
    ).resolves.not.toThrow();
  });
});

describe("ContentService.list / get (R2-backed reads)", () => {
  it("list() throws a clear error when r2Env was not supplied", async () => {
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42);
    await expect(service.list()).rejects.toThrow("ContentService.list: r2Env is required");
  });

  it("get() throws a clear error when r2Env was not supplied", async () => {
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42);
    await expect(service.get("c1")).rejects.toThrow("ContentService.get: r2Env is required");
  });
});

const R2_ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_SQL_TOKEN: "t" };

function stubR2Rows(rows: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows } }), { status: 200 })
  ));
}

describe("ContentService.update", () => {
  it("throws a clear error when r2Env was not supplied", async () => {
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42);
    await expect(service.update("c1", { title: "x" })).rejects.toThrow("ContentService.update: r2Env is required");
  });

  it("reads the full row, overwrites only the given fields, and writes the row back complete", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", title: "old title", summary: "old summary", view_count: 5, is_deleted: 0 }]);
    const service = new ContentService(
      createMockEntityState() as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any, undefined, R2_ENV
    );

    await service.update("c1", { title: "new title" });

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.title).toBe("new title");
    expect(record.summary).toBe("old summary"); // untouched field preserved from the read
    expect(record.view_count).toBe(5); // untouched field preserved from the read
    expect(record.tenant_id).toBe(42);
    expect(record.is_deleted).toBe(0);
    // I4: buildContentRecord is now the single source of the column set for update() too.
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
    vi.unstubAllGlobals();
  });

  it("throws when the content row does not exist", async () => {
    stubR2Rows([]);
    const service = new ContentService(createMockEntityState() as any, {} as any, {} as any, 42, undefined, undefined, R2_ENV);

    await expect(service.update("missing", { title: "x" })).rejects.toThrow("ContentService.update: content missing not found");
    vi.unstubAllGlobals();
  });

  // I1: getContent had no is_deleted filter at all, and update() forced is_deleted back to 0
  // on every write — so DELETE c1 followed by PATCH /items/c1 silently undeleted it. update()
  // must instead refuse to edit a deleted row. This also proves update() passes
  // includeDeleted: true to getContent — without it, a deleted row would come back as "not
  // found" (wrong error) instead of "is deleted" (right error).
  it("throws when the row is already deleted, instead of silently resurrecting it (I1)", async () => {
    const pipeline = { send: vi.fn() };
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", is_deleted: 1 }]);
    const service = new ContentService(
      createMockEntityState() as any, {} as any, {} as any, 42, pipeline as any, undefined, R2_ENV
    );

    await expect(service.update("c1", { title: "x" })).rejects.toThrow("ContentService.update: content c1 is deleted");
    expect(pipeline.send).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  // 7.3: the old D1-backed update() re-embedded on title/summary change; the R2 rewrite
  // dropped that call. Vectorize is still live (delete() below still calls deleteByIds), so a
  // silently-stale embedding would leave semantic search ranking on text the user replaced,
  // with no path to ever catch up.
  it("re-embeds Vectorize when title or summary changes (7.3)", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const ai = createMockAi();
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", title: "old", summary: null, is_deleted: 0 }]);
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any, undefined, R2_ENV);

    await service.update("c1", { title: "new title" });

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
    const [[embedRecord]] = vectorize.upsert.mock.calls[0];
    expect(embedRecord.id).toBe("c1");
    expect(embedRecord.metadata.title).toBe("new title");
    vi.unstubAllGlobals();
  });

  it("does not re-embed when fields is empty", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const ai = createMockAi();
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", is_deleted: 0 }]);
    const service = new ContentService(createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any, undefined, R2_ENV);

    await service.update("c1", {});

    expect(vectorize.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("ContentService.delete", () => {
  it("throws a clear error when r2Env was not supplied", async () => {
    const service = new ContentService(createMockEntityState() as any, createMockVectorize() as any, {} as any, 42);
    await expect(service.delete("c1")).rejects.toThrow("ContentService.delete: r2Env is required");
  });

  it("delete() writes a full row with is_deleted = 1 instead of removing anything", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const ai = createMockAi();
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", title: "t", is_deleted: 0 }]);
    const service = new ContentService(
      createMockEntityState() as any, vectorize as any, ai as any, 42, pipeline as any, undefined, R2_ENV
    );

    await service.delete("c1");

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.is_deleted).toBe(1);
    expect(record.id).toBe("c1");
    // I4: buildContentRecord is now the single source of the column set for delete() too.
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
    expect(vectorize.deleteByIds).toHaveBeenCalledWith(["c1"]);
    vi.unstubAllGlobals();
  });

  it("throws when the content row does not exist", async () => {
    stubR2Rows([]);
    const service = new ContentService(createMockEntityState() as any, createMockVectorize() as any, {} as any, 42, undefined, undefined, R2_ENV);

    await expect(service.delete("missing")).rejects.toThrow("ContentService.delete: content missing not found");
    vi.unstubAllGlobals();
  });

  it("is idempotent against a row that is already deleted", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    stubR2Rows([{ id: "c1", channel_id: "chan1", channel_type: "X", source_content_id: "t1", is_deleted: 1 }]);
    const service = new ContentService(
      createMockEntityState() as any, vectorize as any, {} as any, 42, pipeline as any, undefined, R2_ENV
    );

    await expect(service.delete("c1")).resolves.not.toThrow();
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.is_deleted).toBe(1);
    vi.unstubAllGlobals();
  });
});
