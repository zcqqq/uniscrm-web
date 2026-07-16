import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { generateMasterKey, encrypt } from "uniscrm-byok";
import { channelsRoutes } from "../../src/routes-channels";
import type { Env } from "../../src/types";

vi.mock("../../src/services/x-posts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/x-posts-api")>();
  return { ...actual, fetchOwnedLists: vi.fn() };
});

interface FakeRow {
  id: string;
  config: string;
  tenant_id: number;
}

function createMockLinkDb() {
  const rows = new Map<string, FakeRow>();
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (sql.includes("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND channel_type = 'X' AND is_active = 1")) {
            const [id, tenantId] = args as [string, number];
            const row = rows.get(id);
            if (!row || row.tenant_id !== tenantId) return null;
            return { config: row.config } as unknown as T;
          }
          // XTokenService.getValidToken issues its own untenanted lookup
          // (`SELECT config FROM channels WHERE id = ?`) — answer that shape
          // too, without the tenant check, so the route's downstream token
          // lookup succeeds for a channel already confirmed to belong to the
          // tenant by the check above.
          if (sql.includes("SELECT config FROM channels WHERE id = ?")) {
            const [id] = args as [string];
            const row = rows.get(id);
            return (row ? { config: row.config } : null) as unknown as T;
          }
          return null;
        },
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
    }),
    _rows: rows,
  };
  return db;
}

function buildTestApp(linkDb: ReturnType<typeof createMockLinkDb>, masterKey: string, tenantId = 1) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, tenantId as never);
    await next();
  });
  app.route("/", channelsRoutes());
  const env = { LINK_DB: linkDb, ENCRYPTION_KEY: { get: async () => masterKey } } as unknown as Env;
  return { app, env };
}

describe("GET /x/:channelId/lists", () => {
  let masterKey: string;

  beforeEach(async () => {
    masterKey = await generateMasterKey();
    vi.clearAllMocks();
  });

  it("returns the connected channel's owned X Lists as { lists }", async () => {
    const linkDb = createMockLinkDb();
    const [encClientId, encClientSecret, encConsumerSecret] = await Promise.all([
      encrypt("cid", masterKey), encrypt("csecret", masterKey), encrypt("consecret", masterKey),
    ]);
    linkDb._rows.set("chan1", {
      id: "chan1",
      tenant_id: 1,
      config: JSON.stringify({
        is_byok: true, x_user_id: "xu1", access_token: "valid-token",
        app_client_id: encClientId, app_client_secret: encClientSecret, app_consumer_secret: encConsumerSecret,
      }),
    });
    const { app, env } = buildTestApp(linkDb, masterKey);
    const { fetchOwnedLists } = await import("../../src/services/x-posts-api");
    (fetchOwnedLists as any).mockResolvedValue([{ id: "list1", name: "Competitors" }]);

    const res = await app.fetch(new Request("https://link-dev.uni-scrm.com/x/chan1/lists"), env);

    expect(res.status).toBe(200);
    const body = await res.json<{ lists: { id: string; name: string }[] }>();
    expect(body.lists).toEqual([{ id: "list1", name: "Competitors" }]);
    expect(fetchOwnedLists).toHaveBeenCalledWith("valid-token", "xu1");
  });

  it("returns 404 when the channel does not belong to the authenticated tenant", async () => {
    const linkDb = createMockLinkDb();
    linkDb._rows.set("chan-other-tenant", { id: "chan-other-tenant", tenant_id: 2, config: JSON.stringify({ is_byok: true, x_user_id: "xu2" }) });
    const { app, env } = buildTestApp(linkDb, masterKey, 1);

    const res = await app.fetch(new Request("https://link-dev.uni-scrm.com/x/chan-other-tenant/lists"), env);

    expect(res.status).toBe(404);
  });
});
