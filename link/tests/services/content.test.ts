import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService } from "../../src/services/content";

function createMockTenantDb() {
  return {
    query: vi.fn(),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

describe("ContentService.upsertContentFromMetadata", () => {
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let ai: ReturnType<typeof createMockAi>;
  let vectorize: ReturnType<typeof createMockVectorize>;
  let service: ContentService;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    ai = createMockAi();
    vectorize = createMockVectorize();
    service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);
  });

  it("inserts a new content row and returns true when none exists for channel+source_content_id", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "t1", text: "hello world" };
    const resolvedProps = { source_content_id: "t1", content_type: "TWEET", contentText: "hello world" };

    const isNew = await service.upsertContentFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["chan1", "t1", "X"])
    );
  });

  it("updates and returns false when a content row already exists", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid" }]);
    const resolvedProps = { source_content_id: "t1", contentText: "updated text" };

    const isNew = await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(isNew).toBe(false);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(channel_id, source_content_id) DO UPDATE SET"),
      expect.arrayContaining(["existing-uuid"])
    );
  });

  it("writes content_type/contentText/source_created_at to their mapped columns (content_type, content_text, source_created_at)", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      contentText: "hello world",
      source_created_at: "2026-07-11T00:00:00.000Z",
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql, params] = tenantDb.run.mock.calls[0];
    expect(sql).toContain("content_type");
    expect(sql).toContain("content_text");
    expect(sql).toContain("source_created_at");
    expect(params).toEqual(expect.arrayContaining(["TWEET", "hello world", "2026-07-11T00:00:00.000Z"]));
  });

  it("omits an unresolved column-mapped field from the SQL entirely, rather than writing null", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = { source_content_id: "t1" }; // no content_type/contentText/source_created_at resolved

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql] = tenantDb.run.mock.calls[0];
    expect(sql).not.toContain("content_type");
    expect(sql).not.toContain("content_text");
    expect(sql).not.toContain("source_created_at");
  });

  it("stores the full rawItem in raw_data, unfiltered", async () => {
    tenantDb.query.mockResolvedValue([]);
    const rawItem = { id: "t1", text: "hi", extra_field: "kept" };

    await service.upsertContentFromMetadata(rawItem, { source_content_id: "t1" }, "chan1", "X");

    const [, params] = tenantDb.run.mock.calls[0];
    const rawDataArg = params.find((p: unknown) => typeof p === "string" && p.includes('"extra_field"'));
    expect(rawDataArg).toBe(JSON.stringify(rawItem));
  });

  it("triggers Vectorize embedding on insert", async () => {
    tenantDb.query.mockResolvedValue([]);
    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", contentText: "hello" }, "chan1", "X");

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("ContentService.buildEmbeddingText fallback (via embedContents through upsertContentFromMetadata)", () => {
  it("falls back to content_text when title is null", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([]);
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await service.upsertContentFromMetadata(
      { id: "t1", text: "tweet body text" },
      { source_content_id: "t1", contentText: "tweet body text" },
      "chan1",
      "X"
    );

    // title is never set by upsertContentFromMetadata, so the embedded text must come from content_text
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), { text: ["tweet body text"] });
  });
});
