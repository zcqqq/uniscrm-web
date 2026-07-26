import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ContentService is mocked at the module boundary (mirrors
// routes-channels-youtube-playlists.test.ts's YouTubeTokenService mock) rather than faking
// TenantDataDB's SQL surface: routes-contents.ts's job is the HTTP mapping around the service's
// throws, not the D1 statements the service issues — those are covered by
// tests/services/content.test.ts.
const constructorMock = vi.fn();
const syncBatchMock = vi.fn();
const listMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("../src/services/content", () => ({
  ContentService: class {
    constructor(...args: unknown[]) {
      constructorMock(...args);
    }
    syncBatch = syncBatchMock;
    list = listMock;
    update = updateMock;
    delete = deleteMock;
  },
}));

async function buildApp(opts: { tenantDb?: unknown } = {}) {
  const { contentsRoutes } = await import("../src/routes-contents");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 7 as never);
    c.set("entityState" as never, { fake: "entityState" } as never);
    // authMiddleware only sets tenantDataDb when the tenant has been provisioned (task 4) —
    // opts.tenantDb undefined models the "not provisioned" case, matching production.
    if (opts.tenantDb !== undefined) {
      c.set("tenantDataDb" as never, opts.tenantDb as never);
    }
    await next();
  });
  app.route("/api/contents", contentsRoutes());
  return app;
}

const ENV = { VECTORIZE: {}, AI: {}, PIPELINE_CONTENT: {} };
const FAKE_DB = { query: vi.fn(), run: vi.fn(), batch: vi.fn(), getDbId: () => "db-1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/contents/items", () => {
  it("returns the service's list on the happy path (provisioned tenant)", async () => {
    listMock.mockResolvedValue([{ id: "c1", title: "Hello" }]);
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items", {}, ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ id: "c1", title: "Hello" }] });
    expect(listMock).toHaveBeenCalledWith(undefined);
    expect(constructorMock).toHaveBeenCalledWith(FAKE_DB, ENV.VECTORIZE, ENV.AI, 7, ENV.PIPELINE_CONTENT, undefined, { fake: "entityState" });
  });

  it("passes channel_type through to the service", async () => {
    listMock.mockResolvedValue([]);
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items?channel_type=TIKTOK", {}, ENV);

    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("TIKTOK");
  });

  it("rejects an invalid channel_type before touching the service", async () => {
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items?channel_type=BOGUS", {}, ENV);

    expect(res.status).toBe(400);
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("returns 503 with no service construction when the tenant DB isn't provisioned", async () => {
    const app = await buildApp({});

    const res = await app.request("/api/contents/items", {}, ENV);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Tenant DB not provisioned" });
    expect(constructorMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("returns 404 with the message when the service throws not-found", async () => {
    listMock.mockRejectedValue(new Error("ContentService.list: content nope not found"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items", {}, ENV);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Error: ContentService.list: content nope not found" });
  });

  it("returns 500 with the error, never a silent empty list, on an unexpected failure", async () => {
    listMock.mockRejectedValue(new Error("D1 is unreachable"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items", {}, ENV);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Error: D1 is unreachable" });
    // The failure mode this test exists to catch: a caught error silently rendered as an empty
    // list would still be `{ items: [] }` with status 200 — assert both status and shape so a
    // regression can't pass by only checking one.
    expect(res.status).not.toBe(200);
    expect(body).not.toEqual({ items: [] });
  });
});

describe("POST /api/contents/items/sync", () => {
  const validBody = {
    channel_type: "TIKTOK",
    items: [{ source_content_id: "s1", title: "T", summary: null, source_url: null, source_updated_at: null }],
  };

  it("returns the sync result on the happy path", async () => {
    syncBatchMock.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }, ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(syncBatchMock).toHaveBeenCalledWith("TIKTOK", validBody.items);
  });

  it("returns 503 with no service construction when the tenant DB isn't provisioned", async () => {
    const app = await buildApp({});

    const res = await app.request("/api/contents/items/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }, ENV);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Tenant DB not provisioned" });
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("returns 500 (not 200) when the service throws an unexpected error", async () => {
    syncBatchMock.mockRejectedValue(new Error("pipeline send failed"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }, ENV);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: pipeline send failed" });
  });
});

describe("PATCH /api/contents/items/:id", () => {
  it("updates the row and returns ok on the happy path", async () => {
    updateMock.mockResolvedValue(undefined);
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith("c1", { title: "New title" });
  });

  it("returns 503 with no service construction when the tenant DB isn't provisioned", async () => {
    const app = await buildApp({});

    const res = await app.request("/api/contents/items/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, ENV);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Tenant DB not provisioned" });
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("returns 404 with the message when the row doesn't exist", async () => {
    updateMock.mockRejectedValue(new Error("ContentService.update: content c1 not found"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, ENV);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Error: ContentService.update: content c1 not found" });
  });

  it("returns 500 (not 200) on an unexpected failure", async () => {
    updateMock.mockRejectedValue(new Error("embedding model unavailable"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "New title" }),
    }, ENV);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: embedding model unavailable" });
  });
});

describe("DELETE /api/contents/items/:id", () => {
  it("deletes the row and returns ok on the happy path", async () => {
    deleteMock.mockResolvedValue(undefined);
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", { method: "DELETE" }, ENV);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith("c1");
  });

  it("returns 503 with no service construction when the tenant DB isn't provisioned", async () => {
    const app = await buildApp({});

    const res = await app.request("/api/contents/items/c1", { method: "DELETE" }, ENV);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Tenant DB not provisioned" });
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("returns 404 with the message when the row doesn't exist", async () => {
    deleteMock.mockRejectedValue(new Error("ContentService.delete: content c1 not found"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", { method: "DELETE" }, ENV);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Error: ContentService.delete: content c1 not found" });
  });

  it("returns 500 (not 200) on an unexpected failure", async () => {
    deleteMock.mockRejectedValue(new Error("vectorize delete failed"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", { method: "DELETE" }, ENV);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: vectorize delete failed" });
  });

  // Fix round 1, Important finding: TenantDataDB.query/run/batch (shared/tenant-data-db.ts)
  // wraps ANY Cloudflare D1 API failure as "D1 query failed: <cloudflare message>". A stale or
  // deleted tenant D1 database (this exact class of incident has already happened twice, per
  // project memory) can easily produce a Cloudflare-side message that happens to contain the
  // substring "not found" — a bare `.includes("not found")` match would report that
  // infrastructure failure to the client as a 404 "item doesn't exist", masking a real failure
  // as a false absence. This pins the fix: only the service's own
  // "ContentService.<method>: content <id> not found" shape may map to 404.
  it("returns 500, not 404, when a D1 infrastructure failure's message happens to contain \"not found\"", async () => {
    deleteMock.mockRejectedValue(new Error("D1 query failed: table user not found"));
    const app = await buildApp({ tenantDb: FAKE_DB });

    const res = await app.request("/api/contents/items/c1", { method: "DELETE" }, ENV);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: D1 query failed: table user not found" });
  });
});
