import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService, CONTENT_MAPPED_PROP_IDS } from "../../src/services/content";
import { consumedPaths, resolveProps } from "../../src/services/pollers/resolve-props";
import type { PropMapping } from "../../../metadata/dataTypes";
import { ContentMetadata_TikTok } from "../../../metadata/tiktok";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import contentSchema from "../../../analytics/pipelines/content-stream-schema.json";

const SCHEMA_FIELD_NAMES = (contentSchema as { fields: { name: string }[] }).fields
  .map((f) => f.name)
  .sort();

// D1 (per-tenant, via TenantDataDB) is the source of truth now — every read/dedup/UPDATE/DELETE
// goes through this mock. Probe SELECTs default to "no existing row" so the common case is an
// insert. Upserts carry `RETURNING id, created_at` and go through query() too (run() discards
// result rows), so the mock echoes back the bound id/created_at — i.e. "this writer won the
// race". A test that wants the LOST race just overrides query for that call.
function createMockTenantDb() {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
      if (!/^\s*INSERT/i.test(sql)) return [];
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      return [{ id: params[cols.indexOf("id")], created_at: params[cols.indexOf("created_at")] }];
    }),
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    batch: vi.fn(),
    getDbId: vi.fn().mockReturnValue("db-1"),
  };
}

function createMockEntityState() {
  return {
    claim: vi.fn(),
    markSeen: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    setFollow: vi.fn(),
    getFollowByEntityId: vi.fn(),
    rollbackFingerprint: vi.fn(),
  };
}

function createMockAi() {
  return { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) };
}

function createMockVectorize() {
  return { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() };
}

// Only the D1 statements that actually mutate. Writes are split across both methods: syncBatch's
// plain INSERT/UPDATE and delete()'s DELETE use run(), while the RETURNING upserts use query()
// alongside the read-only probes — so "no D1 write" means neither, filtered by statement kind.
// (`\b` keeps `is_deleted` in the read projection from counting as a DELETE.)
function writeCalls(db: ReturnType<typeof createMockTenantDb>) {
  return [
    ...db.query.mock.calls.filter(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql as string)),
    ...db.run.mock.calls,
  ];
}

// The [sql, params] of the upsert statement (the one carrying RETURNING), as distinct from the
// probe SELECT that precedes it on the same mock method.
function upsertCall(db: ReturnType<typeof createMockTenantDb>, nth = 0): [string, unknown[]] {
  const calls = db.query.mock.calls.filter(([sql]) => /^\s*INSERT/i.test(sql as string));
  return calls[nth] as [string, unknown[]];
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

  it("inserts a new D1 row and returns true when none exists for channel+source_content_id", async () => {
    const rawItem = { id: "t1", text: "hello world" };
    const resolvedProps = { source_content_id: "t1", content_type: "TWEET", content_text: "hello world" };

    const isNew = await service.upsertContentFromMetadata(rawItem, resolvedProps, "chan1", "X", false);

    expect(isNew).toBe(true);
    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM content WHERE channel_id = ? AND source_content_id = ? AND list_id IS NULL"),
      ["chan1", "t1"]
    );
    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["chan1", "t1", "X"])
    );
  });

  it("upserts through the list-less partial unique index and returns false when a row already exists", async () => {
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid", created_at: "2026-01-01T00:00:00.000Z", content_text: "old text" }]);
    const resolvedProps = { source_content_id: "t1", content_text: "updated text" };

    const isNew = await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    expect(isNew).toBe(false);
    const [sql] = upsertCall(tenantDb);
    expect(sql).toContain("ON CONFLICT(channel_id, source_content_id) WHERE list_id IS NULL DO UPDATE SET");
    // raw_data must MERGE, not replace: a partial payload can't be allowed to wipe keys an
    // earlier fuller write stored.
    expect(sql).toContain("raw_data = json_patch(content.raw_data, excluded.raw_data)");
  });

  it("uses the list-scoped probe and conflict target when listId is given", async () => {
    await service.upsertContentFromMetadata({ id: "t2" }, { source_content_id: "t2" }, "chan1", "X", false, "listA");

    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("AND list_id = ?"),
      ["chan1", "t2", "listA"]
    );
    const [sql] = upsertCall(tenantDb);
    expect(sql).toContain("ON CONFLICT(channel_id, list_id, source_content_id) WHERE list_id IS NOT NULL DO UPDATE SET");
  });

  it("sends a complete row to the content pipeline — every schema column present, null when absent", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

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

  // id-domain discipline: the D1 row's id IS the R2 copy's id. If these ever diverge, flow logs,
  // Vectorize entries and generatedFromContentId references all point at a row nobody can find.
  it("gives the R2 copy the exact id D1 minted for the new row", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false);

    const [, insertParams] = upsertCall(tenantDb);
    const d1Id = insertParams[0];
    const [[record]] = pipeline.send.mock.calls[0];
    expect(typeof d1Id).toBe("string");
    expect((d1Id as string).length).toBeGreaterThan(0);
    expect(record.id).toBe(d1Id);
    // ...and the same id is what Vectorize is keyed by.
    const [[embedRecord]] = vectorize.upsert.mock.calls[0];
    expect(embedRecord.id).toBe(d1Id);
  });

  // The probe→mint→upsert sequence is not atomic (entityState.claim, which this replaced, was).
  // Two writers of the same (channel_id, source_content_id) — webhook post.create and the
  // poller's re-walk — can interleave: the poller probes, sees nothing, mints B; the webhook
  // inserts A first; the poller's upsert hits the conflict and D1 keeps A, because `id` is not in
  // the DO UPDATE set. Carrying B forward would put an id in the R2 copy and in Vectorize that
  // matches no D1 row, and fire a second content.created with a dangling contentId. RETURNING
  // makes the write authoritative, so this asserts on the RETURNED id — which the probe-derived
  // structure could not do.
  it("uses the id D1 RETURNED, not the one the probe minted, when a concurrent writer wins the race", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    tenantDb.query
      .mockResolvedValueOnce([]) // probe: key not there yet -> a fresh uuid is minted
      .mockResolvedValueOnce([{ id: "winner-id", created_at: "2026-01-01T00:00:00.000Z" }]); // upsert hit the conflict
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any, flowQueue as any);

    const isNew = await svc.upsertContentFromMetadata(
      { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", true
    );

    const [sql, insertParams] = upsertCall(tenantDb);
    expect(sql).toContain("RETURNING id, created_at");
    expect(insertParams[0]).not.toBe("winner-id"); // the probe really did propose a different id

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("winner-id");
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
    const [[embedRecord]] = vectorize.upsert.mock.calls[0];
    expect(embedRecord.id).toBe("winner-id");
    // The row was not new to the system, so no second content.created may fire for it.
    expect(isNew).toBe(false);
    expect(flowQueue.send).not.toHaveBeenCalled();
  });

  it("reuses the existing D1 row's id (and its created_at) for the R2 copy", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    tenantDb.query.mockResolvedValue([{ id: "existing-uuid", created_at: "2026-01-01T00:00:00.000Z", content_text: "old" }]);
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1", content_text: "new" }, "chan1", "X", false);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("existing-uuid");
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(record.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  // Replaces the entity_state fingerprint check: the previous values live in D1, so "did
  // anything change" is a column compare against the probed row.
  it("skips BOTH the D1 write and the R2 send when every mapped column already matches", async () => {
    const pipeline = { send: vi.fn() };
    tenantDb.query.mockResolvedValue([{ id: "c1", created_at: "2026-01-01T00:00:00.000Z", content_text: "hi", view_count: 100 }]);
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    const isNew = await service.upsertContentFromMetadata(
      { id: "t1" }, { source_content_id: "t1", content_text: "hi", view_count: 100 }, "chan1", "X", false
    );

    expect(isNew).toBe(false);
    expect(writeCalls(tenantDb)).toHaveLength(0); // probe SELECT only
    expect(pipeline.send).not.toHaveBeenCalled();
  });

  it("writes and sends again as soon as one mapped column differs", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    tenantDb.query.mockResolvedValue([{ id: "c1", created_at: "2026-01-01T00:00:00.000Z", content_text: "hi", view_count: 100 }]);
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await service.upsertContentFromMetadata(
      { id: "t1" }, { source_content_id: "t1", content_text: "hi", view_count: 101 }, "chan1", "X", false
    );

    expect(writeCalls(tenantDb)).toHaveLength(1);
    expect(pipeline.send).toHaveBeenCalledTimes(1);
  });

  // R2 is a copy, D1 is the truth: a failed analytics send must not fail the caller and must not
  // undo anything. It logs and moves on — a deliberate, accepted downgrade.
  it("resolves normally and logs when the R2 send fails, leaving the D1 write intact", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pipeline = { send: vi.fn().mockRejectedValue(new Error("transient R2 error")) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    const isNew = await service.upsertContentFromMetadata(
      { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false
    );

    expect(isNew).toBe(true);
    expect(writeCalls(tenantDb)).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("pipeline_content_error"));
    errSpy.mockRestore();
  });

  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new ContentService(null, vectorize as any, ai as any, 42);

    await expect(
      service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false)
    ).rejects.toThrow("ContentService.upsertContentFromMetadata: tenantDb is required");
  });

  // The flowType gate: only metadata entries declaring flowType:"content" may be persisted.
  // Trigger sources go through recordTriggerContentSeen/emitContentTriggerEvent instead; this is
  // the defense line behind the caller's own routing, and it must branch on the metadata VALUE.
  describe("flowType persistence gate", () => {
    it('refuses flowType "trigger" — throws, with zero D1 writes and zero R2 sends', async () => {
      const pipeline = { send: vi.fn() };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await expect(
        service.upsertContentFromMetadata(
          { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", true, undefined, ["text"], "trigger"
        )
      ).rejects.toThrow("upsertContentFromMetadata: refusing to persist non-content flowType: trigger");

      expect(tenantDb.query).not.toHaveBeenCalled();
      expect(writeCalls(tenantDb)).toHaveLength(0);
      expect(pipeline.send).not.toHaveBeenCalled();
      expect(vectorize.upsert).not.toHaveBeenCalled();
    });

    it('refuses flowType "action" too — the gate rejects every known non-content value', async () => {
      const pipeline = { send: vi.fn() };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await expect(
        service.upsertContentFromMetadata(
          { id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false, undefined, undefined, "action"
        )
      ).rejects.toThrow("refusing to persist non-content flowType: action");
      expect(writeCalls(tenantDb)).toHaveLength(0);
      expect(pipeline.send).not.toHaveBeenCalled();
    });

    it('persists flowType "content" to BOTH D1 and the R2 copy', async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      const isNew = await service.upsertContentFromMetadata(
        { id: "t1", text: "hi" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false, undefined, ["text"], "content"
      );

      expect(isNew).toBe(true);
      expect(tenantDb.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO content"), expect.any(Array));
      expect(pipeline.send).toHaveBeenCalledTimes(1);
    });

    it("still persists when flowType is omitted — the gate only REFUSES known non-content values", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await service.upsertContentFromMetadata(
        { id: "t1" }, { source_content_id: "t1", content_text: "hi" }, "chan1", "X", false
      );

      expect(tenantDb.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO content"), expect.any(Array));
      expect(pipeline.send).toHaveBeenCalledTimes(1);
    });

    // Guards the gate against being reintroduced as a poller/channel-name branch: the values
    // below come straight off the metadata registry, which is the only allowed input.
    it("agrees with the metadata registry: x-byok's content entry persists, its trigger entry does not", async () => {
      const contentEntry = ContentMetadata_X.find((m) => m.flowType === "content")!;
      const triggerEntry = ContentMetadata_X.find((m) => m.flowType === "trigger")!;
      expect(contentEntry).toBeDefined();
      expect(triggerEntry).toBeDefined();

      await expect(
        service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false, undefined, undefined, contentEntry.flowType)
      ).resolves.toBe(true);
      await expect(
        service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false, undefined, undefined, triggerEntry.flowType)
      ).rejects.toThrow("refusing to persist non-content flowType");
    });
  });

  // I5: propId ≠ payload field name (e.g. view_count ← public_metrics.impression_count), so
  // filtering raw_data by propId strings (the old behavior) stripped nothing for X content —
  // it shipped the entire tweet payload downstream. consumedPaths must be actual payload paths.
  describe("raw_data filtering via consumedPaths (I5)", () => {
    it("strips exactly the given consumedPaths, keeping everything else", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

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

    it("stores the same stripped remainder in D1 as in the R2 copy", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await service.upsertContentFromMetadata(
        { id: "t1", text: "hi", weird_field: 1 },
        { source_content_id: "t1", content_text: "hi" },
        "chan1", "X", false, undefined, ["text"]
      );

      const [sql, params] = upsertCall(tenantDb);
      const insertCols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      const d1RawData = params[insertCols.indexOf("raw_data")] as string;
      const [[record]] = pipeline.send.mock.calls[0];
      expect(JSON.parse(d1RawData)).toEqual({ id: "t1", weird_field: 1 });
      expect(d1RawData).toBe(record.raw_data);
    });

    it("strips a nested path and leaves the parent object in place", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

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
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await expect(service.upsertContentFromMetadata(
        { id: "t1" },
        { source_content_id: "t1" },
        "chan1", "X", false, undefined, ["nonexistent.path"]
      )).resolves.not.toThrow();
    });

    it("falls back to storing the entire payload and warns once when consumedPaths is omitted", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

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

    // Important 1 (task-5 fix round): a metadata prop can have a dataId (so it looks
    // "consumed") without CONTENT_COLUMN_MAP having a column for it. If a future caller
    // computes consumedPaths from the raw metadata mapping array unfiltered — exactly the
    // shape that destroyed X user's profile_image_url/description — the same thing would
    // happen to content: the field gets stripped from raw_data with nowhere else to land.
    // CONTENT_MAPPED_PROP_IDS + consumedPaths' allowedPropIds filter is the guard against
    // that; this proves the guard actually behaves as intended end-to-end.
    //
    // NOTE: this test originally used "content_url" as its real-world mapped-but-columnless
    // example. Task-7 fix round 1 (Minor 3) gave content_url an actual column (source_url —
    // see the CONTENT_COLUMN_MAP comment), so it's no longer an example of this bug class at
    // all — it's now a positive case, covered by the dedicated test below. There is currently
    // no other real ContentMetadata entry with a dataId and no CONTENT_COLUMN_MAP entry (the
    // registry-only props in metadata/props.ts — processed_video_url, video_transcript,
    // translated_subtitle_text — are declared but never actually mapped by any source's
    // contentProps yet), so this test now uses a synthetic propId to keep exercising the
    // guard mechanism itself rather than asserting on a specific field name.
    it("a mapped-but-columnless prop survives in raw_data when consumedPaths is filtered by CONTENT_MAPPED_PROP_IDS (Important 1)", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      // "some_future_field" has a dataId (so a naive caller would compute a path for it) but
      // is deliberately NOT a key of CONTENT_COLUMN_MAP.
      const props: PropMapping[] = [
        { propId: "content_text", dataId: "{linkPrefix}.text" },
        { propId: "some_future_field", dataId: "{linkPrefix}.extra" },
      ];
      const paths = consumedPaths(props, "data[]", CONTENT_MAPPED_PROP_IDS);
      expect(paths).toEqual(["text"]); // "extra" excluded — some_future_field has no column

      await service.upsertContentFromMetadata(
        { id: "t1", text: "hi", extra: "https://x/1" },
        { source_content_id: "t1", content_text: "hi" },
        "chan1", "X", false, undefined, paths
      );

      const [[record]] = pipeline.send.mock.calls[0];
      const raw = JSON.parse(record.raw_data as string);
      expect(raw).not.toHaveProperty("text"); // consumed and column-mapped -> stripped
      expect(raw.extra).toBe("https://x/1"); // mapped but columnless -> survives
    });

    // Minor 2 (task-7 fix round 1): CONTENT_MAPPED_PROP_IDS omitted source_content_id, so
    // {linkPrefix}.id was never stripped and every tweet/video id was duplicated into
    // raw_data despite already having a named column (source_content_id is the entity key,
    // passed separately — not a CONTENT_COLUMN_MAP entry — but it IS a real column).
    it("strips source_content_id's payload path from raw_data (Minor 2) and writes content_url to the source_url column (Minor 3)", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      const props: PropMapping[] = [
        { propId: "source_content_id", dataId: "{linkPrefix}.id" },
        { propId: "content_text", dataId: "{linkPrefix}.text" },
      ];
      const paths = consumedPaths(props, "data[]", CONTENT_MAPPED_PROP_IDS);
      expect(paths).toEqual(["id", "text"]);

      await service.upsertContentFromMetadata(
        { id: "t1", text: "hi" },
        { source_content_id: "t1", content_text: "hi", content_url: "https://x.com/i/status/t1" },
        "chan1", "X", false, undefined, paths
      );

      const [[record]] = pipeline.send.mock.calls[0];
      expect(record.source_url).toBe("https://x.com/i/status/t1");
      const raw = JSON.parse(record.raw_data as string);
      expect(raw).not.toHaveProperty("id"); // Minor 2: id is consumed + column-mapped -> stripped
      expect(raw).not.toHaveProperty("text");
    });
  });

  it("writes content_type/content_text/source_created_at to their mapped columns in D1 and R2", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);
    const resolvedProps = {
      source_content_id: "t1",
      content_type: "TWEET",
      content_text: "hello world",
      source_created_at: "2026-07-11T00:00:00.000Z",
    };

    await service.upsertContentFromMetadata({ id: "t1" }, resolvedProps, "chan1", "X", false);

    const [sql, params] = upsertCall(tenantDb);
    expect(sql).toContain("content_type");
    expect(sql).toContain("content_text");
    expect(sql).toContain("source_created_at");
    expect(params).toEqual(expect.arrayContaining(["TWEET", "hello world", "2026-07-11T00:00:00.000Z"]));

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBe("TWEET");
    expect(record.content_text).toBe("hello world");
    expect(record.source_created_at).toBe("2026-07-11T00:00:00.000Z");
  });

  it("writes title and the engagement metric props to their mapped columns", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);
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
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);
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
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

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
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

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
      tenantDb.query.mockResolvedValue([{ id: "existing-uuid", created_at: "2026-01-01T00:00:00.000Z", content_text: "old" }]);
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

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
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

      await expect(
        svc.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", true)
      ).resolves.not.toThrow();
    });
  });

  describe("per-list dedup (listId param)", () => {
    it("probes the list-less key space when listId is not passed", async () => {
      await service.upsertContentFromMetadata({ id: "t1" }, { source_content_id: "t1" }, "chan1", "X", false);

      expect(tenantDb.query).toHaveBeenCalledWith(
        expect.stringContaining("list_id IS NULL"),
        ["chan1", "t1"]
      );
    });

    it("writes list_id into both the D1 row and the R2 copy when provided", async () => {
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

      await svc.upsertContentFromMetadata({ id: "t2" }, { source_content_id: "t2" }, "chan1", "X", false, "listA");

      const [, params] = upsertCall(tenantDb);
      expect(params).toContain("listA");
      const [[record]] = pipeline.send.mock.calls[0];
      expect(record.list_id).toBe("listA");
    });

    it("treats the same source_content_id in two different lists as two separate rows", async () => {
      await service.upsertContentFromMetadata({ id: "t3" }, { source_content_id: "t3" }, "chan1", "X", false, "listA");
      await service.upsertContentFromMetadata({ id: "t3" }, { source_content_id: "t3" }, "chan1", "X", false, "listB");

      // query() now carries both the probes and the RETURNING upserts, so pick out the probes.
      const probes = tenantDb.query.mock.calls.filter(([sql]) => /^\s*SELECT/i.test(sql as string));
      expect(probes[0]).toEqual([expect.stringContaining("AND list_id = ?"), ["chan1", "t3", "listA"]]);
      expect(probes[1]).toEqual([expect.stringContaining("AND list_id = ?"), ["chan1", "t3", "listB"]]);
      const idA = upsertCall(tenantDb, 0)[1][0];
      const idB = upsertCall(tenantDb, 1)[1][0];
      expect(idA).not.toBe(idB);
    });

    it("includes listId in the emitted content.created message when provided", async () => {
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata({ id: "t4" }, { source_content_id: "t4" }, "chan1", "X", true, "listA");

      expect(flowQueue.send).toHaveBeenCalledTimes(1);
      const [msg] = flowQueue.send.mock.calls[0];
      expect(msg).toMatchObject({ eventType: "content.created", channelId: "chan1", listId: "listA" });
    });

    it("omits listId from the emitted message entirely when not provided (not just undefined)", async () => {
      const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, undefined, flowQueue as any);

      await svc.upsertContentFromMetadata({ id: "t5" }, { source_content_id: "t5" }, "chan1", "X", true);

      const [msg] = flowQueue.send.mock.calls[0];
      expect("listId" in msg).toBe(false);
    });
  });
});

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

  it("inserts a new item into D1, counts it as added, and sends a complete R2 row", async () => {
    const tenantDb = createMockTenantDb();
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem()]);

    expect(result).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(tenantDb.run).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO content"), expect.any(Array));
    expect(pipeline.send).toHaveBeenCalledTimes(1);
    const [[record]] = pipeline.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });

  it("counts an unchanged item as skipped, writing nothing to either store", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{
      id: "c1", source_content_id: "s1", channel_id: "LOCAL", title: "T", summary: null,
      source_url: null, source_updated_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
    }]);
    const pipeline = { send: vi.fn() };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem()]);

    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(writeCalls(tenantDb)).toHaveLength(0);
    expect(pipeline.send).not.toHaveBeenCalled();
  });

  // 461d039 compared source_updated_at alone, which would freeze a source that never sets it.
  it("counts a title-only change as updated even when source_updated_at is unchanged", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{
      id: "c1", source_content_id: "s1", channel_id: "LOCAL", title: "old", summary: null,
      source_url: null, source_updated_at: null, created_at: "2026-01-01T00:00:00.000Z",
    }]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    const result = await service.syncBatch("LOCAL", [makeItem({ title: "new", source_updated_at: null })]);

    expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect(tenantDb.run).toHaveBeenCalledWith(expect.stringContaining("UPDATE content SET"), expect.arrayContaining(["new", "c1"]));
    expect(pipeline.send).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing D1 row's id and created_at for the R2 copy on update", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{
      id: "c1", source_content_id: "s1", channel_id: "LOCAL", title: "old", summary: null,
      source_url: null, source_updated_at: null, created_at: "2026-01-01T00:00:00.000Z",
    }]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    await service.syncBatch("LOCAL", [makeItem({ title: "new" })]);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("c1");
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  // I2 + I3 regression test: channel-less imports must key on channel_type, not "". A null
  // channel_id violates the R2 schema's required column (Pipelines silently drops such records)
  // AND would make delete()'s tombstone — built straight from the D1 row — undeliverable.
  it("stores channel_type as channel_id in BOTH stores, so two channel types can't collide", async () => {
    const tenantDb = createMockTenantDb();
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    await service.syncBatch("LOCAL", [makeItem({ source_content_id: "1" })]);
    await service.syncBatch("NOTION", [makeItem({ source_content_id: "1" })]);

    const [[recordA]] = pipeline.send.mock.calls[0];
    const [[recordB]] = pipeline.send.mock.calls[1];
    expect(recordA.channel_id).toBe("LOCAL");
    expect(recordB.channel_id).toBe("NOTION");
    expect(recordA.id).not.toBe(recordB.id);

    // ...and the D1 INSERT carries the same channel_id (params: id, channel_id, channel_type, ...)
    const [, paramsA] = tenantDb.run.mock.calls[0] as [string, unknown[]];
    expect(paramsA[1]).toBe("LOCAL");
    expect(paramsA[2]).toBe("LOCAL");
  });

  // A pre-migration LOCAL/NOTION row has channel_id NULL (the old code never set it) while its
  // R2 copies go out under channel_id = channelType. The probe matches on channel_type, so the
  // row IS found — but the UPDATE branch used to omit channel_id, so the NULL survived every
  // rewrite. delete() builds its R2 tombstone from the D1 row, and R2 Pipelines drops a record
  // whose required channel_id is null, so such an item would stay visible in analytics forever.
  describe("channel_id backfill on the UPDATE branch", () => {
    function legacyRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "c1", source_content_id: "s1", channel_id: null, title: "T", summary: null,
        source_url: null, source_updated_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z", ...overrides,
      };
    }

    it("puts channel_id in the UPDATE's SET list, bound to the channel type", async () => {
      const tenantDb = createMockTenantDb();
      tenantDb.query.mockResolvedValue([legacyRow({ title: "old" })]);
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

      await service.syncBatch("LOCAL", [makeItem({ title: "new" })]);

      const [sql, params] = tenantDb.run.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE content SET channel_id = ?");
      expect(params[0]).toBe("LOCAL");
    });

    // Without this, the repair above is unreachable for the rows that need it most: an
    // otherwise-unchanged legacy row skips out before any UPDATE can run.
    it("rewrites an otherwise-unchanged row whose channel_id is NULL instead of skipping it forever", async () => {
      const tenantDb = createMockTenantDb();
      tenantDb.query.mockResolvedValue([legacyRow()]);
      const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
      const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

      const result = await service.syncBatch("LOCAL", [makeItem()]);

      expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
      expect(tenantDb.run).toHaveBeenCalledWith(
        expect.stringContaining("channel_id = ?"),
        expect.arrayContaining(["LOCAL"])
      );
    });

    it("still skips an unchanged row whose channel_id is already correct", async () => {
      const tenantDb = createMockTenantDb();
      tenantDb.query.mockResolvedValue([legacyRow({ channel_id: "LOCAL" })]);
      const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42);

      const result = await service.syncBatch("LOCAL", [makeItem()]);

      expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
      expect(writeCalls(tenantDb)).toHaveLength(0);
    });
  });

  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new ContentService(null, createMockVectorize() as any, createMockAi() as any, 42);
    await expect(service.syncBatch("LOCAL", [makeItem()])).rejects.toThrow("ContentService.syncBatch: tenantDb is required");
  });
});

describe("CONTENT_COLUMN_MAP coverage", () => {
  it("maps view_count, share_count, cover_image_url, duration, height, width, has_face to matching columns", async () => {
    const tenantDb = createMockTenantDb();
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 1, pipeline as any);

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

// Task-7 fix round 1, Important 3: nothing anywhere asserted that the `consumedPaths` argument
// threaded into x-posts.ts/tiktok-content.ts/webhook.ts actually strips raw_data — deleting it
// from any of those three call sites only emitted a console.warn, no test failed. These tests
// exercise the exact resolveProps -> consumedPaths -> upsertContentFromMetadata composition
// each poller performs (same metadata entries, same CONTENT_MAPPED_PROP_IDS filter), asserting
// on the emitted record's raw_data content — not on the paths argument being passed. They also
// thread the metadata entry's own flowType, i.e. the exact shape task 7 will call with.
describe("consumedPaths threading — end-to-end raw_data stripping per poller (task-7 fix round 1, Important 3)", () => {
  it("x-posts.ts's own:get-posts composition strips mapped payload fields from raw_data, keeping unmapped ones", async () => {
    const POSTS_METADATA = ContentMetadata_X.find((m) => m.sourceContentType === "own:get-posts")!;
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockTenantDb() as any, createMockVectorize() as any, createMockAi() as any, 1, pipeline as any);

    // Mirrors x-posts.ts's upsertPage exactly: resolveProps -> consumedPaths -> upsert.
    const item = {
      id: "t1",
      text: "hello world",
      created_at: "2026-07-11T00:00:00.000Z",
      public_metrics: { bookmark_count: 1, impression_count: 2, like_count: 3, quote_count: 4, reply_count: 5, retweet_count: 6 },
      weird_unmapped_field: "survives",
    };
    const props = resolveProps(item, POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix);
    const paths = consumedPaths(POSTS_METADATA.contentProps, POSTS_METADATA.linkPrefix, CONTENT_MAPPED_PROP_IDS);

    await service.upsertContentFromMetadata(item, props, "chan1", "X", false, undefined, paths, POSTS_METADATA.flowType);

    const [[record]] = pipeline.send.mock.calls[0];
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("id"); // source_content_id, column-mapped -> stripped
    expect(raw).not.toHaveProperty("text"); // content_text, column-mapped -> stripped
    expect(raw).not.toHaveProperty("created_at"); // source_created_at, column-mapped -> stripped
    expect(raw.public_metrics).toEqual({}); // every sub-field consumed and column-mapped
    expect(raw.weird_unmapped_field).toBe("survives"); // never in contentProps -> untouched
  });

  it("tiktok-content.ts's video.list composition strips mapped payload fields (including content_url's share_url) from raw_data", async () => {
    const VIDEO_METADATA = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video.list")!;
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(createMockTenantDb() as any, createMockVectorize() as any, createMockAi() as any, 1, pipeline as any);

    const item = {
      id: "v1",
      video_description: "a video",
      cover_image_url: "https://tiktok.example/cover.jpg",
      share_url: "https://tiktok.example/share/v1",
      like_count: 10,
      comment_count: 2,
      share_count: 1,
      view_count: 100,
      duration: 30,
      height: 1920,
      width: 1080,
      title: "A Title",
      create_time: 1781669273,
      unmapped_diagnostic_field: "survives",
    };
    const props = resolveProps(item, VIDEO_METADATA.contentProps, VIDEO_METADATA.linkPrefix);
    const paths = consumedPaths(VIDEO_METADATA.contentProps, VIDEO_METADATA.linkPrefix, CONTENT_MAPPED_PROP_IDS);
    // Sanity check that the metadata this test reads off disk still maps *something* — if this
    // ever goes empty the rest of the test would trivially pass without proving anything.
    expect(paths.length).toBeGreaterThan(0);
    // source_content_id ({linkPrefix}.id) and content_url ({linkPrefix}.share_url, Minor 3)
    // are the two fields this task's fix rounds specifically added to CONTENT_MAPPED_PROP_IDS —
    // assert their exact paths are present rather than hardcoding the full path list, so this
    // test doesn't depend on which of TikTok's other content fields metadata/tiktok.ts happens
    // to map at any given moment.
    expect(paths).toContain("id");
    expect(paths).toContain("share_url");

    await service.upsertContentFromMetadata(item, props, "chan1", "TIKTOK", false, undefined, paths, VIDEO_METADATA.flowType);

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.source_url).toBe("https://tiktok.example/share/v1"); // Minor 3: content_url -> source_url column
    const raw = JSON.parse(record.raw_data as string);
    // Every path consumedPaths computed must be gone from raw_data — checked dynamically
    // (against whatever metadata/tiktok.ts currently maps) rather than hardcoding TikTok's
    // full field list, which can change independently of this fix.
    for (const path of paths) {
      expect(raw).not.toHaveProperty(path.split(".")[0]);
    }
    expect(raw.unmapped_diagnostic_field).toBe("survives");
  });
});

describe("ContentService.buildEmbeddingText fallback (via embedContents through upsertContentFromMetadata)", () => {
  it("falls back to content_text when title is null", async () => {
    const ai = createMockAi();
    const vectorize = createMockVectorize();
    const service = new ContentService(createMockTenantDb() as any, vectorize as any, ai as any, 42);

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
  let tenantDb: ReturnType<typeof createMockTenantDb>;
  let ai: ReturnType<typeof createMockAi>;
  let vectorize: ReturnType<typeof createMockVectorize>;

  beforeEach(() => {
    tenantDb = createMockTenantDb();
    ai = createMockAi();
    vectorize = createMockVectorize();
  });

  it("writes the D1 row and sends a full R2 row referencing the source content and flow, without a status field", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("target-chan-1", "X", "tweet-123", "generated post text", {
      generatedFromContentId: "source-content-1",
      flowId: "flow-1",
    });

    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["target-chan-1", "X", "TWEET", "tweet-123", "generated post text"])
    );
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
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("target-chan-1", "X", "tweet-123", "generated post text", {
      generatedFromContentId: "source-content-1",
      flowId: "flow-1",
    });

    const [[record]] = pipeline.send.mock.calls[0];
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });

  // 7.2: this method writes into the same (channel_id, source_content_id) key space every other
  // writer uses — a key backed by a UNIQUE index. A bare INSERT with a fresh uuid would both
  // throw on a republish and produce two ids for one logical row.
  it("reuses the existing D1 row's id on a republish, and upserts rather than plain-inserting", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    tenantDb.query.mockResolvedValue([{ id: "stable-id", created_at: "2026-01-01T00:00:00.000Z" }]);
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("chan1", "X", "tweet-1", "hello", {
      generatedFromContentId: "c1",
      flowId: "f1",
    });

    expect(tenantDb.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE channel_id = ? AND source_content_id = ? AND list_id IS NULL"),
      ["chan1", "tweet-1"]
    );
    const [sql] = upsertCall(tenantDb);
    expect(sql).toContain("ON CONFLICT(channel_id, source_content_id) WHERE list_id IS NULL DO UPDATE SET");
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("stable-id");
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  // Same non-atomic probe→mint→upsert race as upsertContentFromMetadata.
  it("uses the id D1 RETURNED for the R2 copy when a concurrent writer wins the race", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    tenantDb.query
      .mockResolvedValueOnce([]) // probe: nothing there yet
      .mockResolvedValueOnce([{ id: "winner-id", created_at: "2026-01-01T00:00:00.000Z" }]);
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("chan1", "X", "tweet-1", "hello", {
      generatedFromContentId: "c1",
      flowId: "f1",
    });

    const [sql, params] = upsertCall(tenantDb);
    expect(sql).toContain("RETURNING id, created_at");
    expect(params[0]).not.toBe("winner-id");
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.id).toBe("winner-id");
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("stores an explicit contentType when given (e.g. TikTok's PHOTO_POST), instead of the hardcoded TWEET default", async () => {
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

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
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await svc.recordPublishedContent("channel-2", "X", "tweet-id-1", "a tweet", {
      generatedFromContentId: "content-2",
      flowId: "flow-1",
    });

    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.content_type).toBe("TWEET");
  });

  it("still writes D1 when no pipelineContent was provided", async () => {
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await expect(
      svc.recordPublishedContent("channel-2", "X", "tweet-id-1", "a tweet", {
        generatedFromContentId: "content-2",
        flowId: "flow-1",
      })
    ).resolves.not.toThrow();
    expect(upsertCall(tenantDb)).toBeDefined();
  });

  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const svc = new ContentService(null, vectorize as any, ai as any, 42);
    await expect(
      svc.recordPublishedContent("c", "X", "t", "x", { generatedFromContentId: "a", flowId: "b" })
    ).rejects.toThrow("ContentService.recordPublishedContent: tenantDb is required");
  });
});

// Trigger content is the other side of the flowType gate: never persisted, only deduped.
describe("ContentService.recordTriggerContentSeen", () => {
  it("delegates to entityState.markSeen with the content_trigger entity kind", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, undefined, entityState as any);

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
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, undefined, entityState as any);

    const isNew = await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(isNew).toBe(false);
  });

  it("accepts an empty secondaryId for trigger types with no secondary dimension", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, undefined, entityState as any);

    await service.recordTriggerContentSeen("chan1", "", "t1");

    expect(entityState.markSeen).toHaveBeenCalledWith({
      entity: "content_trigger",
      channelId: "chan1",
      secondaryId: "",
      sourceId: "t1",
    });
  });

  it("touches neither the tenant DB nor pipelineContent — trigger content is never persisted", async () => {
    const entityState = createMockEntityState();
    const tenantDb = createMockTenantDb();
    const pipelineContent = { send: vi.fn() };
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42, pipelineContent as any, undefined, entityState as any);

    await service.recordTriggerContentSeen("chan1", "listA", "t1");

    expect(tenantDb.run).not.toHaveBeenCalled();
    expect(tenantDb.query).not.toHaveBeenCalled();
    expect(pipelineContent.send).not.toHaveBeenCalled();
  });

  it("throws for an empty sourceContentId", async () => {
    const entityState = createMockEntityState();
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, undefined, entityState as any);

    await expect(service.recordTriggerContentSeen("chan1", "listA", "")).rejects.toThrow(
      "recordTriggerContentSeen: missing source_content_id"
    );
  });

  it("throws a clear error when no entityState was supplied", async () => {
    const service = new ContentService(null, {} as any, {} as any, 42);

    await expect(service.recordTriggerContentSeen("chan1", "listA", "t1")).rejects.toThrow(
      "ContentService.recordTriggerContentSeen: entityState is required"
    );
  });
});

describe("ContentService.emitContentTriggerEvent", () => {
  it("sends content.created with a freshly generated contentId and the named secondary field", async () => {
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, flowQueue as any);

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
    const service = new ContentService(null, {} as any, {} as any, 42, undefined, flowQueue as any);

    await service.emitContentTriggerEvent("chan1", "YOUTUBE", "subscriptionChannelId", "", { content_type: "VIDEO" });

    const [msg] = flowQueue.send.mock.calls[0];
    expect("subscriptionChannelId" in msg).toBe(false);
  });

  it("does not throw when no flowQueue was provided", async () => {
    const service = new ContentService(null, {} as any, {} as any, 42);

    await expect(
      service.emitContentTriggerEvent("chan1", "X", "listId", "listA", {})
    ).resolves.not.toThrow();
  });
});

describe("ContentService.list / get (D1-backed reads)", () => {
  it("list() reads D1, newest-first by COALESCE(source_updated_at, source_created_at, created_at)", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{ id: "c1" }]);
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    const rows = await service.list();

    expect(rows).toEqual([{ id: "c1" }]);
    const [sql] = tenantDb.query.mock.calls[0];
    expect(sql).toContain("FROM content");
    expect(sql).toContain("ORDER BY COALESCE(source_updated_at, source_created_at, created_at) DESC");
  });

  it("list(channelType) filters by channel_type", async () => {
    const tenantDb = createMockTenantDb();
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    await service.list("TIKTOK");

    expect(tenantDb.query).toHaveBeenCalledWith(expect.stringContaining("WHERE channel_type = ?"), ["TIKTOK"]);
  });

  // impression_count and is_deleted are not D1 columns: the projection supplies them as
  // constants so a D1 read still satisfies ContentRow.
  it("projects impression_count as NULL and is_deleted as 0", async () => {
    const tenantDb = createMockTenantDb();
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    await service.list();

    const [sql] = tenantDb.query.mock.calls[0];
    expect(sql).toContain("NULL AS impression_count");
    expect(sql).toContain("0 AS is_deleted");
  });

  it("get() returns the row when found and null when not", async () => {
    const tenantDb = createMockTenantDb();
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42);

    expect(await service.get("c1")).toBeNull();

    tenantDb.query.mockResolvedValue([{ id: "c1" }]);
    expect(await service.get("c1")).toEqual({ id: "c1" });
    expect(tenantDb.query).toHaveBeenLastCalledWith(expect.stringContaining("WHERE id = ?"), ["c1"]);
  });

  it("list()/get() throw a clear error when the tenant DB is not provisioned", async () => {
    const service = new ContentService(null, {} as any, {} as any, 42);
    await expect(service.list()).rejects.toThrow("ContentService.list: tenantDb is required");
    await expect(service.get("c1")).rejects.toThrow("ContentService.get: tenantDb is required");
  });
});

// A full D1 row as CONTENT_READ_PROJECTION returns it — what update()/delete() re-read and
// hand to buildContentRecord.
const D1_ROW = {
  id: "c1", channel_id: "chan1", channel_type: "X", content_type: "TWEET", source_content_id: "t1",
  list_id: null, title: "old title", content_text: "body", summary: "old summary", source_url: null,
  source_updated_at: null, source_created_at: null, cover_image_url: null, duration: null,
  height: null, width: null, has_face: null, bookmark_count: null, impression_count: null,
  view_count: 5, like_count: null, quote_count: null, reply_count: null, repost_count: null,
  share_count: null, raw_data: "{}", created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z", is_deleted: 0,
};

describe("ContentService.update", () => {
  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new ContentService(null, {} as any, {} as any, 42);
    await expect(service.update("c1", { title: "x" })).rejects.toThrow("ContentService.update: tenantDb is required");
  });

  it("UPDATEs D1 in place, then sends the complete re-read row to the R2 copy", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{ ...D1_ROW, title: "new title" }]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(
      tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any
    );

    await service.update("c1", { title: "new title" });

    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE content SET title = ?"),
      expect.arrayContaining(["new title", "c1"])
    );
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.title).toBe("new title");
    expect(record.summary).toBe("old summary"); // untouched field preserved from the D1 read
    expect(record.view_count).toBe(5); // untouched field preserved from the D1 read
    expect(record.tenant_id).toBe(42);
    expect(record.is_deleted).toBe(0);
    expect(record.created_at).toBe("2026-01-01T00:00:00.000Z");
    // I4: buildContentRecord is now the single source of the column set for update() too.
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });

  it("throws when the content row does not exist (D1 UPDATE matched nothing)", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.run.mockResolvedValue({ changes: 0 });
    const pipeline = { send: vi.fn() };
    const service = new ContentService(tenantDb as any, {} as any, {} as any, 42, pipeline as any);

    await expect(service.update("missing", { title: "x" })).rejects.toThrow("ContentService.update: content missing not found");
    expect(pipeline.send).not.toHaveBeenCalled();
  });

  // 7.3: the R2 rewrite once dropped the re-embed. Vectorize is still live (delete() below still
  // calls deleteByIds), so a silently-stale embedding would leave semantic search ranking on
  // text the user replaced, with no path to ever catch up.
  it("re-embeds Vectorize when title or summary changes (7.3)", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([{ ...D1_ROW, title: "new title" }]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const ai = createMockAi();
    const service = new ContentService(tenantDb as any, vectorize as any, ai as any, 42, pipeline as any);

    await service.update("c1", { title: "new title" });

    expect(ai.run).toHaveBeenCalled();
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
    const [[embedRecord]] = vectorize.upsert.mock.calls[0];
    expect(embedRecord.id).toBe("c1");
    expect(embedRecord.metadata.title).toBe("new title");
  });

  it("does not re-embed when fields is empty", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([D1_ROW]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, createMockAi() as any, 42, pipeline as any);

    await service.update("c1", {});

    expect(vectorize.upsert).not.toHaveBeenCalled();
  });

  it("resolves even when the R2 copy send fails — D1 already holds the truth", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([D1_ROW]);
    const pipeline = { send: vi.fn().mockRejectedValue(new Error("transient R2 error")) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, createMockAi() as any, 42, pipeline as any);

    await expect(service.update("c1", { title: "x" })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("pipeline_content_error"));
    errSpy.mockRestore();
  });
});

describe("ContentService.delete", () => {
  it("throws a clear error when the tenant DB is not provisioned", async () => {
    const service = new ContentService(null, createMockVectorize() as any, {} as any, 42);
    await expect(service.delete("c1")).rejects.toThrow("ContentService.delete: tenantDb is required");
  });

  it("hard-deletes the D1 row, tombstones the R2 copy with is_deleted = 1, and drops the vector", async () => {
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockResolvedValue([D1_ROW]);
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, createMockAi() as any, 42, pipeline as any);

    await service.delete("c1");

    expect(tenantDb.run).toHaveBeenCalledWith("DELETE FROM content WHERE id = ?", ["c1"]);
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record.is_deleted).toBe(1);
    expect(record.id).toBe("c1");
    expect(record.channel_id).toBe("chan1");
    expect(record.title).toBe("old title"); // built from the pre-delete D1 row, not a stub
    // I4: buildContentRecord is now the single source of the column set for delete() too.
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
    expect(vectorize.deleteByIds).toHaveBeenCalledWith(["c1"]);
  });

  it("reads the row BEFORE deleting it, so the tombstone can be a complete row", async () => {
    const order: string[] = [];
    const tenantDb = createMockTenantDb();
    tenantDb.query.mockImplementation(async () => { order.push("select"); return [D1_ROW]; });
    tenantDb.run.mockImplementation(async () => { order.push("delete"); return { changes: 1 }; });
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, {} as any, 42);

    await service.delete("c1");

    expect(order).toEqual(["select", "delete"]);
  });

  it("throws when the content row does not exist, without deleting or sending anything", async () => {
    const tenantDb = createMockTenantDb();
    const pipeline = { send: vi.fn() };
    const vectorize = createMockVectorize();
    const service = new ContentService(tenantDb as any, vectorize as any, {} as any, 42, pipeline as any);

    await expect(service.delete("missing")).rejects.toThrow("ContentService.delete: content missing not found");
    expect(tenantDb.run).not.toHaveBeenCalled();
    expect(pipeline.send).not.toHaveBeenCalled();
    expect(vectorize.deleteByIds).not.toHaveBeenCalled();
  });
});

// Kept as webhook.ts's fallback for a delete whose row is not in D1 (a historical row that only
// ever existed during the R2-as-truth phase). R2-only by design — there is nothing in D1 to remove.
describe("ContentService.deleteByKnownIdentity", () => {
  it("writes an R2 tombstone from caller-known identity without touching D1", async () => {
    const tenantDb = createMockTenantDb();
    const pipeline = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new ContentService(tenantDb as any, createMockVectorize() as any, {} as any, 42, pipeline as any);

    await service.deleteByKnownIdentity("c9", "chan1", "X", "t9");

    expect(tenantDb.query).not.toHaveBeenCalled();
    expect(tenantDb.run).not.toHaveBeenCalled();
    const [[record]] = pipeline.send.mock.calls[0];
    expect(record).toMatchObject({ id: "c9", channel_id: "chan1", source_content_id: "t9", is_deleted: 1, raw_data: "{}" });
    expect(Object.keys(record).sort()).toEqual(SCHEMA_FIELD_NAMES);
  });
});
