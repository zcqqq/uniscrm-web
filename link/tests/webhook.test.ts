import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// webhook.ts's own job (2026-07-26 plan: user/content back to per-tenant D1) is routing,
// tenant-DB-provisioned guarding, and argument threading (flowType from the metadata registry,
// tenantDb/entityState into the service constructors) — NOT re-proving content.ts's/x-users.ts's
// internal D1 upsert semantics, which content.test.ts and x-users.test.ts already cover in
// depth. So ContentService, XUsersService and TenantDataDB are mocked wholesale here (same
// pattern as tiktok-content.test.ts), and assertions inspect what webhook.ts constructed/called
// them with, plus the delete route's own direct D1 lookup (which is NOT inside ContentService).

const queryMock = vi.fn();
vi.mock("../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query(...args: unknown[]) { return queryMock(...args); }
    run = vi.fn();
    batch = vi.fn();
    getDbId() { return "db-1"; }
  },
}));

const upsertContentFromMetadataMock = vi.fn().mockResolvedValue(true);
const contentDeleteMock = vi.fn().mockResolvedValue(undefined);
const contentDeleteByKnownIdentityMock = vi.fn().mockResolvedValue(undefined);
const contentServiceConstructorMock = vi.fn();
vi.mock("../src/services/content", () => ({
  ContentService: class {
    constructor(...args: unknown[]) { contentServiceConstructorMock(...args); }
    upsertContentFromMetadata(...args: unknown[]) { return upsertContentFromMetadataMock(...args); }
    delete(...args: unknown[]) { return contentDeleteMock(...args); }
    deleteByKnownIdentity(...args: unknown[]) { return contentDeleteByKnownIdentityMock(...args); }
  },
  // webhook.ts imports this to compute consumedPaths for post.create — a real (small) set is
  // enough to exercise the stripping without pulling in content.ts's full column map.
  CONTENT_MAPPED_PROP_IDS: new Set(["source_content_id", "content_type", "content_text", "title"]),
}));

const upsertUserMock = vi.fn().mockResolvedValue("user-id-1");
const insertEventsMock = vi.fn().mockResolvedValue(undefined);
const usersServiceConstructorMock = vi.fn();
vi.mock("../src/services/x-users", () => ({
  XUsersService: class {
    constructor(...args: unknown[]) { usersServiceConstructorMock(...args); }
    upsertUser(...args: unknown[]) { return upsertUserMock(...args); }
    insertEvents(...args: unknown[]) { return insertEventsMock(...args); }
  },
  EVENT_VALUE_COLUMNS: ["followers_count", "following_count", "verified_type", "message_text"],
}));

import { webhookRoutes } from "../src/webhook";

function mockDb(table: "channels" | "tenants", row: Record<string, unknown> | null) {
  const marker = table === "channels" ? "FROM channels" : "FROM tenants";
  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      if (!sql.includes(marker)) throw new Error(`unexpected prepare() on this fake db: ${sql}`);
      return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(row) }) };
    }),
  };
}

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    LINK_DB: mockDb("channels", { id: "chan1", tenant_id: 42 }),
    WEB_DB: mockDb("tenants", { d1_database_id: "tenant-db-1" }),
    PIPELINE_CONTENT: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_EVENT: { send: vi.fn().mockResolvedValue(undefined) },
    PIPELINE_USER: { send: vi.fn().mockResolvedValue(undefined) },
    FLOW_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    VECTORIZE: { upsert: vi.fn().mockResolvedValue(undefined), deleteByIds: vi.fn() },
    AI: { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] }) },
    CF_ACCOUNT_ID: "acct",
    CF_D1_API_TOKEN: "tok",
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

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue([]);
  upsertContentFromMetadataMock.mockClear().mockResolvedValue(true);
  contentDeleteMock.mockClear().mockResolvedValue(undefined);
  contentDeleteByKnownIdentityMock.mockClear().mockResolvedValue(undefined);
  contentServiceConstructorMock.mockClear();
  upsertUserMock.mockClear().mockResolvedValue("user-id-1");
  insertEventsMock.mockClear().mockResolvedValue(undefined);
  usersServiceConstructorMock.mockClear();
});

describe("webhookRoutes POST /webhook — tenant DB provisioning guard", () => {
  it("skips entirely (200, no service constructed) when the tenant has no provisioned D1 database", async () => {
    const env = baseEnv({ WEB_DB: mockDb("tenants", null) });
    const app = buildApp();

    const res = await post(app, activityBody("post.create", { id: "tweet1", text: "hello" }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(contentServiceConstructorMock).not.toHaveBeenCalled();
    expect(usersServiceConstructorMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("webhookRoutes POST /webhook — post.create", () => {
  it("threads flowType (own:get-posts's metadata entry, never a literal) into upsertContentFromMetadata's 8th argument", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.create", {
      id: "tweet1", text: "hello", created_at: "2026-07-20T00:00:00.000Z",
    }), env);
    expect(res.status).toBe(200);

    expect(upsertContentFromMetadataMock).toHaveBeenCalledTimes(1);
    const args = upsertContentFromMetadataMock.mock.calls[0];
    expect(args[2]).toBe("chan1"); // channelId
    expect(args[3]).toBe("X"); // channelType
    expect(args[7]).toBe("content"); // flowType, from ContentMetadata_X's own:get-posts entry
  });

  it("sets content_type=ARTICLE and strips the mapped payload fields from raw_data before handing off", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.create", {
      id: "tweet-art", text: "https://t.co/x", article: { title: "A Great Article" },
      weird_unmapped_field: "survives",
    }), env);
    expect(res.status).toBe(200);

    const [, resolvedProps] = upsertContentFromMetadataMock.mock.calls[0];
    expect(resolvedProps.content_type).toBe("ARTICLE");
    expect(resolvedProps.title).toBe("A Great Article");
  });

  it("constructs ContentService with the resolved per-tenant TenantDataDB, not null", async () => {
    const env = baseEnv();
    const app = buildApp();

    await post(app, activityBody("post.create", { id: "tweet1", text: "hello" }), env);

    expect(contentServiceConstructorMock).toHaveBeenCalledTimes(1);
    const [tenantDbArg] = contentServiceConstructorMock.mock.calls[0];
    expect(tenantDbArg).not.toBeNull();
  });
});

describe("webhookRoutes POST /webhook — post.delete", () => {
  it("found in D1: calls ContentService.delete with the row's id", async () => {
    queryMock.mockResolvedValueOnce([{ id: "content-row-1" }]);
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.delete", { id: "tweet2" }), env);
    expect(res.status).toBe(200);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM content WHERE channel_id = ? AND channel_type = 'X' AND source_content_id = ? AND list_id IS NULL"),
      ["chan1", "tweet2"]
    );
    expect(contentDeleteMock).toHaveBeenCalledWith("content-row-1");
    expect(contentDeleteByKnownIdentityMock).not.toHaveBeenCalled();
  });

  it("not found in D1: falls back to deleteByKnownIdentity instead of no-opping or throwing", async () => {
    queryMock.mockResolvedValueOnce([]); // D1 lookup misses
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.delete", { id: "never-seen" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(contentDeleteMock).not.toHaveBeenCalled();
    expect(contentDeleteByKnownIdentityMock).toHaveBeenCalledTimes(1);
    const [id, channelId, channelType, sourceContentId] = contentDeleteByKnownIdentityMock.mock.calls[0];
    expect(typeof id).toBe("string");
    expect(channelId).toBe("chan1");
    expect(channelType).toBe("X");
    expect(sourceContentId).toBe("never-seen");
  });

  // Important 2's original scenario (R2 lag) no longer applies now that D1 is the truth and the
  // lookup is synchronous — but a real D1 error (network blip, rate limit) is exactly as
  // possible as before, and must not 500 the webhook (X retries the same delivery indefinitely
  // on a non-2xx response).
  it("never 500s the webhook delivery even when the D1 lookup itself throws", async () => {
    queryMock.mockRejectedValueOnce(new Error("D1 query failed: rate limited"));
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("post.delete", { id: "tweet3" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(contentDeleteByKnownIdentityMock).toHaveBeenCalledTimes(1);
  });
});

describe("webhookRoutes POST /webhook — follow events / resolveEventConsumedPaths", () => {
  it("strips follow.follow's mapped eventProps paths before handing off to insertEvents", async () => {
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

    expect(upsertUserMock).toHaveBeenCalledTimes(1);
    expect(insertEventsMock).toHaveBeenCalledTimes(1);
    const [events] = insertEventsMock.mock.calls[0];
    const event = events[0];
    expect(event.eventProps.followers_count).toBe(10);
    expect(event.eventProps.following_count).toBe(2);
    expect(event.eventProps.verified_type).toBe("blue");
    expect(event.consumedPaths.length).toBeGreaterThan(0);
  });

  it("constructs XUsersService with the resolved per-tenant TenantDataDB and the LINK_DB entity_state for follow mirroring", async () => {
    const env = baseEnv();
    const app = buildApp();

    await post(app, activityBody("follow.follow", {
      source: { data: { id: "x-user-1" } },
      target: { data: { id: "target-1", name: "Target", username: "target_h" } },
    }), env);

    expect(usersServiceConstructorMock).toHaveBeenCalledTimes(1);
    const [tenantDbArg, opts] = usersServiceConstructorMock.mock.calls[0];
    expect(tenantDbArg).not.toBeNull();
    expect(opts.entityState).toBeTruthy();
    expect(opts.tenantId).toBe(42);
  });

  // Minor 1 (task-7 fix round 1): an eventType with an EventMetadata_X entry but an empty
  // eventProps array (post.create, like.create) produced consumedPaths === [] — truthy, which
  // used to fool a bare `if (e.consumedPaths)` guard inside insertEvents. That guard lives in
  // x-users.ts (covered by x-users.test.ts) — this test only proves webhook.ts's own
  // resolveEventConsumedPaths resolves to [] rather than undefined for such an event, which is
  // the one part of that bug webhook.ts itself could reintroduce.
  it("resolves an empty (not absent) consumedPaths for an eventType whose metadata declares no eventProps", async () => {
    const env = baseEnv();
    const app = buildApp();

    const res = await post(app, activityBody("like.create", { id: "like-1", tweet_id: "tweet1" }), env);
    expect(res.status).toBe(200);

    const [events] = insertEventsMock.mock.calls[0];
    expect(events[0].consumedPaths).toEqual([]);
  });
});
