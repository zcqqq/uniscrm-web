import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { webhookRoutes } from "../src/webhook";

// Task-7 fix round 1, Important 3: the rebuilt post.create/post.delete (ContentService +
// EntityStateStore replacing the old raw D1 SQL against the now-removed tenant DB) and the new
// resolveEventConsumedPaths helper shipped with zero tests. This file exercises both through
// the real webhookRoutes() Hono app end-to-end, so a broken wiring shows up as a failing
// assertion, not just a silent console.warn.

const R2_ENV = { CF_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_WAREHOUSE: "w", R2_CATALOG_TOKEN: "t" };

// Real EntityStateStore runs against this fake LINK_DB — the same in-memory entity_state
// implementation entity-state.test.ts uses (INSERT OR IGNORE / SELECT / UPDATE semantics),
// extended with a `channels` table lookup branch, so post.create/post.delete exercise the
// actual claim()/get() SQL round-trips rather than a mocked EntityStateStore.
function createFakeLinkDb(channelRow: { id: string; tenant_id: number } | null) {
  const entityRows = new Map<string, Record<string, unknown>>();
  const keyOf = (p: unknown[]) => p.slice(0, 5).join("\x1f");

  return {
    prepare(sql: string) {
      if (sql.includes("FROM channels")) {
        return { bind: () => ({ first: async () => channelRow }) };
      }
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO entity_state")) {
                const k = keyOf(params);
                if (entityRows.has(k)) return { meta: { changes: 0 } };
                entityRows.set(k, {
                  tenant_id: params[0], entity: params[1], channel_id: params[2],
                  secondary_id: params[3], source_id: params[4],
                  entity_id: params[5], fingerprint: params[6],
                  is_follow: null, is_followed: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE entity_state SET fingerprint")) {
                const k = [params[2], params[3], params[4], params[5], params[6]].join("\x1f");
                const row = entityRows.get(k);
                if (row) { row.fingerprint = params[0]; row.updated_at = params[1]; }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes("UPDATE entity_state SET is_follow") || sql.includes("UPDATE entity_state SET is_followed")) {
                return { meta: { changes: 1 } };
              }
              throw new Error(`fake LINK_DB: unhandled run() for ${sql}`);
            },
            async first() {
              return entityRows.get(keyOf(params)) ?? null;
            },
          };
        },
      };
    },
  };
}

// Mirrors x-users.test.ts's stubR2 helper — stubs the global fetch shared/r2-sql.ts's r2Query
// goes through, so ContentService.delete()'s getContent() read can be exercised without a real
// R2 SQL endpoint.
function stubR2(rows: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ result: { rows } }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    LINK_DB: createFakeLinkDb({ id: "chan1", tenant_id: 42 }),
    PIPELINE_CONTENT: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_EVENT: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_USER: { send: vi.fn().mockResolvedValue(undefined) },
    FLOW_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    VECTORIZE: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() },
    AI: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) },
    ...R2_ENV,
    ...overrides,
  } as any;
}

function buildApp() {
  const app = new Hono();
  app.route("/x", webhookRoutes());
  return app;
}

function activityBody(eventType: string, payload: Record<string, unknown>) {
  return { data: { event_type: eventType, filter: { user_id: "x-user-1" }, payload } };
}

async function post(app: Hono, body: unknown, env: unknown) {
  return app.request("/x/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env as any);
}

describe("webhookRoutes POST /webhook — post.create", () => {
  it("claims a stable id via entity_state and writes a complete row", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res1 = await post(app, activityBody("post.create", {
      id: "tweet1", text: "hello", created_at: "2026-07-20T00:00:00.000Z",
    }), env);
    expect(res1.status).toBe(200);

    expect(env.PIPELINE_CONTENT.send).toHaveBeenCalledTimes(1);
    const record1 = env.PIPELINE_CONTENT.send.mock.calls[0][0][0];
    expect(record1.channel_id).toBe("chan1");
    expect(record1.channel_type).toBe("X");
    expect(record1.source_content_id).toBe("tweet1");
    expect(record1.content_type).toBe("TWEET");
    expect(record1.content_text).toBe("hello");
    expect(record1.is_deleted).toBe(0);
    expect(typeof record1.id).toBe("string");
    expect(record1.id.length).toBeGreaterThan(0);

    // Second delivery of the same tweet with different text (a retried delivery, or a
    // metadata refresh) — entity_state must hand back the SAME id, not mint a fresh uuid.
    const res2 = await post(app, activityBody("post.create", {
      id: "tweet1", text: "hello (edited)", created_at: "2026-07-20T00:00:00.000Z",
    }), env);
    expect(res2.status).toBe(200);

    expect(env.PIPELINE_CONTENT.send).toHaveBeenCalledTimes(2);
    const record2 = env.PIPELINE_CONTENT.send.mock.calls[1][0][0];
    expect(record2.id).toBe(record1.id);
    expect(record2.content_text).toBe("hello (edited)");
  });

  it("sets content_type=ARTICLE and strips the mapped payload fields from raw_data", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.create", {
      id: "tweet-art", text: "https://t.co/x", article: { title: "A Great Article" },
      weird_unmapped_field: "survives",
    }), env);
    expect(res.status).toBe(200);

    const record = env.PIPELINE_CONTENT.send.mock.calls[0][0][0];
    expect(record.content_type).toBe("ARTICLE");
    expect(record.title).toBe("A Great Article");
    const raw = JSON.parse(record.raw_data as string);
    expect(raw).not.toHaveProperty("id"); // source_content_id, column-mapped -> stripped
    expect(raw).not.toHaveProperty("text"); // content_text, column-mapped -> stripped
    expect(raw.weird_unmapped_field).toBe("survives"); // never mapped -> untouched
  });
});

describe("webhookRoutes POST /webhook — post.delete", () => {
  it("logically deletes the real R2 row when it has already landed", async () => {
    const env = baseEnv();
    const app = buildApp();

    const createRes = await post(app, activityBody("post.create", { id: "tweet2", text: "to be deleted" }), env);
    expect(createRes.status).toBe(200);
    const created = env.PIPELINE_CONTENT.send.mock.calls[0][0][0];

    // Simulate R2 having already caught up: getContent() finds the row Pipelines flushed.
    stubR2([{
      id: created.id, channel_id: "chan1", channel_type: "X", source_content_id: "tweet2",
      list_id: null, title: null, content_text: "to be deleted", summary: null,
      source_url: null, source_updated_at: null, source_created_at: null,
      cover_image_url: null, duration: null, height: null, width: null, has_face: null,
      bookmark_count: null, impression_count: null, view_count: null, like_count: null,
      quote_count: null, reply_count: null, repost_count: null, share_count: null,
      raw_data: "{}", created_at: "2026-07-20T00:00:00.000Z", updated_at: "2026-07-20T00:00:00.000Z",
      is_deleted: 0,
    }]);

    const deleteRes = await post(app, activityBody("post.delete", { id: "tweet2" }), env);
    expect(deleteRes.status).toBe(200);

    const deleteCalls = env.PIPELINE_CONTENT.send.mock.calls.filter((c: unknown[]) => (c[0] as Record<string, unknown>[])[0].is_deleted === 1);
    expect(deleteCalls).toHaveLength(1);
    const tombstone = deleteCalls[0][0][0];
    expect(tombstone.id).toBe(created.id);
    expect(tombstone.content_text).toBe("to be deleted"); // preserved from the real read -> real delete(), not the blind fallback
  });

  // Important 2: entity_state is written synchronously at post.create, but the R2 row a
  // Pipelines batch carries can take minutes to actually land. A delete arriving inside that
  // window must not lose the tombstone or take the webhook delivery down.
  it("falls back to a synthesized tombstone when R2 has not caught up yet (Important 2)", async () => {
    const env = baseEnv();
    const app = buildApp();

    const createRes = await post(app, activityBody("post.create", { id: "tweet3", text: "deleted before flush" }), env);
    expect(createRes.status).toBe(200);
    const created = env.PIPELINE_CONTENT.send.mock.calls[0][0][0];

    // R2 hasn't caught up yet — getContent() finds zero rows.
    stubR2([]);

    const deleteRes = await post(app, activityBody("post.delete", { id: "tweet3" }), env);
    // The webhook delivery must still complete (200), not 500 — an uncaught throw here would
    // make X retry the same delivery indefinitely (see the try/catch this test would catch a
    // regression of, in webhookRoutes()'s router.post("/webhook", ...)).
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ ok: true });

    const deleteCalls = env.PIPELINE_CONTENT.send.mock.calls.filter((c: unknown[]) => (c[0] as Record<string, unknown>[])[0].is_deleted === 1);
    expect(deleteCalls).toHaveLength(1);
    const tombstone = deleteCalls[0][0][0];
    expect(tombstone.id).toBe(created.id); // same entity_state id, not a fresh uuid
    expect(tombstone.channel_id).toBe("chan1");
    expect(tombstone.channel_type).toBe("X");
    expect(tombstone.source_content_id).toBe("tweet3");
    // Blind tombstone — no real row was read, so every value column is null.
    expect(tombstone.content_text).toBeNull();
    expect(tombstone.title).toBeNull();
  });

  it("no-ops (logs, does not throw) when the tweet was never recorded", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.delete", { id: "never-seen" }), env);
    expect(res.status).toBe(200);
    expect(env.PIPELINE_CONTENT.send).not.toHaveBeenCalled();
  });
});

describe("webhookRoutes POST /webhook — resolveEventConsumedPaths", () => {
  it("strips follow.follow's mapped eventProps paths from the event record's raw_data", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, {
      data: {
        event_type: "follow.follow",
        filter: { user_id: "x-user-1" },
        payload: {
          source: { data: { id: "x-user-1" } },
          target: {
            data: {
              id: "target-1", name: "Target", username: "target_h",
              public_metrics: { followers_count: 10, following_count: 2 },
              verified_type: "blue",
              weird_unmapped_field: "survives",
            },
          },
        },
      },
    }, env);
    expect(res.status).toBe(200);

    expect(env.PIPELINE_EVENT.send).toHaveBeenCalledTimes(1);
    const record = env.PIPELINE_EVENT.send.mock.calls[0][0][0];
    expect(record.followers_count).toBe(10);
    expect(record.following_count).toBe(2);
    expect(record.verified_type).toBe("blue");
    const raw = JSON.parse(record.raw_data as string);
    expect(raw.public_metrics).toEqual({}); // followers_count/following_count consumed
    expect(raw).not.toHaveProperty("verified_type"); // consumed
    expect(raw.weird_unmapped_field).toBe("survives"); // never in eventProps -> untouched
  });

  // Minor 1 (task-7 fix round 1): an eventType with an EventMetadata_X entry but an empty
  // eventProps array (post.create, like.create) produced consumedPaths === [] — truthy, so
  // insertEvents' `if (e.consumedPaths)` treated it as "provided" and stored the whole payload
  // with no warning. [] must behave like "absent" (warn), since the effect on raw_data is
  // identical.
  it("warns when consumedPaths resolves to an empty array, same as when it's entirely absent", async () => {
    const env = baseEnv();
    const app = buildApp();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // like.create has an EventMetadata_X entry with eventProps: [] — consumedPaths resolves
    // to [], not undefined.
    const res = await post(app, activityBody("like.create", { id: "like-1", tweet_id: "tweet1" }), env);
    expect(res.status).toBe(200);

    const warnedUnfiltered = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .some((s) => s.includes("insertEvents_raw_data_unfiltered"));
    expect(warnedUnfiltered).toBe(true);
    warnSpy.mockRestore();
  });
});
