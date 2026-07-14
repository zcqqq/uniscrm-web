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
    const resolvedProps = { source_content_id: "t1", content_type: "TWEET", content_text: "hello world" };

    const isNew = await service.upsertContentFromMetadata(rawItem, resolvedProps, "chan1", "X");

    expect(isNew).toBe(true);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["chan1", "t1", "X"])
    );
  });

  it("updates and returns false when a content row already exists", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid" }]);
    const resolvedProps = { source_content_id: "t1", content_text: "updated text" };

    const isNew = await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(isNew).toBe(false);
    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT(channel_id, source_content_id) DO UPDATE SET"),
      expect.arrayContaining(["existing-uuid"])
    );
  });

  it("writes content_type/content_text/source_created_at to their mapped columns (content_type, content_text, source_created_at)", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      content_text: "hello world",
      source_created_at: "2026-07-11T00:00:00.000Z",
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql, params] = tenantDb.run.mock.calls[0];
    expect(sql).toContain("content_type");
    expect(sql).toContain("content_text");
    expect(sql).toContain("source_created_at");
    expect(params).toEqual(expect.arrayContaining(["TWEET", "hello world", "2026-07-11T00:00:00.000Z"]));
  });

  it("writes title and the engagement metric props to their mapped columns", async () => {
    tenantDb.query.mockResolvedValue([]);
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

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    const [sql, params] = tenantDb.run.mock.calls[0];
    for (const col of ["title", "bookmark_count", "view_count", "like_count", "quote_count", "reply_count", "repost_count"]) {
      expect(sql).toContain(col);
    }
    expect(params).toEqual(expect.arrayContaining(["Free Skill - some article", 3, 100, 1, 0, 2, 5]));
  });

  it("sends only isInsight props to the content pipeline, keyed by tenant_id/id/source_content_id", async () => {
    tenantDb.query.mockResolvedValue([]);
    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipelineContent as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      title: "not sent to R2 (free text)",
      content_text: "not sent to R2 (free text)",
      view_count: 100,
      like_count: 1,
    };

    await svc.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
    const [record] = pipelineContent.send.mock.calls[0][0];
    expect(record).toMatchObject({
      tenant_id: 42,
      channel_id: "chan1",
      channel_type: "X",
      source_content_id: "t1",
      content_type: "TWEET",
      view_count: 100,
      like_count: 1,
    });
    expect(record.title).toBeUndefined();
    expect(record.content_text).toBeUndefined();
  });

  it("does not send to the pipeline when the resolved values exactly match the existing row", async () => {
    tenantDb.query.mockResolvedValue([{
      id: "existing-uuid",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    }]);
    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipelineContent as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    };

    await svc.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(pipelineContent.send).not.toHaveBeenCalled();
  });

  it("still sends to the pipeline when a resolved value differs from the existing row", async () => {
    tenantDb.query.mockResolvedValue([{
      id: "existing-uuid",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 1,
    }]);
    const pipelineContent = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipelineContent as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      impression_count: 37,
      like_count: 2, // changed from 1
    };

    await svc.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X");

    expect(pipelineContent.send).toHaveBeenCalledTimes(1);
  });

  it("omits an unresolved column-mapped field from the SQL entirely, rather than writing null", async () => {
    tenantDb.query.mockResolvedValue([]);
    const resolvedProps = { source_content_id: "t1" }; // no content_type/content_text/source_created_at resolved

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
    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", content_text: "hello" }, "chan1", "X");

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("CONTENT_COLUMN_MAP coverage", () => {
  it("maps view_count, share_count, cover_image_url, duration, height, width to matching columns", async () => {
    const tenantDb = createMockTenantDb();
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 1);

    tenantDb.query.mockResolvedValue([]);
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
      },
      "chan-1",
      "TIKTOK"
    );

    const insertCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("INSERT INTO content"));
    expect(insertCall![0]).toContain("view_count");
    expect(insertCall![0]).toContain("share_count");
    expect(insertCall![0]).toContain("cover_image_url");
    expect(insertCall![0]).toContain("duration");
    expect(insertCall![0]).toContain("height");
    expect(insertCall![0]).toContain("width");
    expect(insertCall![0]).not.toContain("impression_count");
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
      { source_content_id: "t1", content_text: "tweet body text" },
      "chan1",
      "X"
    );

    // no title resolved here, so the embedded text must fall back to content_text
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), { text: ["tweet body text"] });
  });
});
