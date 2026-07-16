import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { generateMasterKey, decrypt } from "uniscrm-byok";
import { channelsRoutes } from "../../src/routes-channels";
import type { Env } from "../../src/types";

interface FakeRow {
  id: string;
  channel_type: string;
  config: string;
  tenant_id: number | null;
  member_id: string | null;
  is_byok: number;
  is_active: number;
}

function createMockLinkDb() {
  const rows = new Map<string, FakeRow>();

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (sql.includes("SELECT config FROM channels WHERE id = ? AND tenant_id = ? AND channel_type = 'X' AND is_byok = 1")) {
            const [id, tenantId] = args as [string, number];
            const row = rows.get(id);
            if (!row || row.tenant_id !== tenantId || !row.is_byok) return null;
            return { config: row.config } as unknown as T;
          }
          if (sql === "SELECT id FROM channels WHERE id = ?") {
            const [id] = args as [string];
            const row = rows.get(id);
            return row ? ({ id: row.id } as unknown as T) : null;
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith("INSERT INTO channels")) {
            const [id, config, tenantId, memberId] = args as [string, string, number, string];
            rows.set(id, { id, channel_type: "X", config, tenant_id: tenantId, member_id: memberId, is_byok: 1, is_active: 1 });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE channels SET config = ?")) {
            const [config, id] = args as [string, string];
            const row = rows.get(id as string);
            if (row) row.config = config;
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
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
    c.set("memberId" as never, "member-1" as never);
    await next();
  });
  app.route("/", channelsRoutes());
  const env = { LINK_DB: linkDb, ENCRYPTION_KEY: { get: async () => masterKey } } as unknown as Env;
  return { app, env };
}

describe("POST /x/byok", () => {
  let masterKey: string;

  beforeEach(async () => {
    masterKey = await generateMasterKey();
  });

  it("creates a new BYOK channel when channel_id does not exist yet", async () => {
    const linkDb = createMockLinkDb();
    const { app, env } = buildTestApp(linkDb, masterKey);
    const preChannelId = "new-channel-id";

    const res = await app.fetch(
      new Request("https://link-dev.uni-scrm.com/x/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: preChannelId, client_id: "cid", client_secret: "csecret", consumer_secret: "consecret" }),
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ channel_id: string }>();
    expect(body.channel_id).toBe(preChannelId);
    expect(linkDb._rows.size).toBe(1);
    const stored = JSON.parse(linkDb._rows.get(preChannelId)!.config);
    expect(await decrypt(stored.app_client_id, masterKey)).toBe("cid");
  });

  it("updates an existing BYOK channel's credentials in place instead of failing on conflict", async () => {
    const linkDb = createMockLinkDb();
    linkDb._rows.set("existing-channel", {
      id: "existing-channel",
      channel_type: "X",
      config: JSON.stringify({
        is_byok: true,
        x_user_id: "12345",
        x_username: "someuser",
        access_token: "old-access",
        refresh_token: "dead-refresh-token",
        app_client_id: "irrelevant-old-enc",
      }),
      tenant_id: 1,
      member_id: "member-1",
      is_byok: 1,
      is_active: 1,
    });
    const { app, env } = buildTestApp(linkDb, masterKey);

    const res = await app.fetch(
      new Request("https://link-dev.uni-scrm.com/x/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: "existing-channel", client_id: "new-cid", client_secret: "new-secret", consumer_secret: "new-consecret" }),
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ channel_id: string }>();
    expect(body.channel_id).toBe("existing-channel");

    const stored = JSON.parse(linkDb._rows.get("existing-channel")!.config);
    // New credentials took effect...
    expect(await decrypt(stored.app_client_id, masterKey)).toBe("new-cid");
    // ...while the existing OAuth session state (untouched by a credentials-only edit) survives.
    expect(stored.x_user_id).toBe("12345");
    expect(stored.access_token).toBe("old-access");
    expect(stored.refresh_token).toBe("dead-refresh-token");
    expect(linkDb._rows.size).toBe(1);
  });

  it("does not let one tenant edit another tenant's BYOK channel", async () => {
    const linkDb = createMockLinkDb();
    linkDb._rows.set("tenant-2-channel", {
      id: "tenant-2-channel",
      channel_type: "X",
      config: JSON.stringify({ is_byok: true, x_user_id: "999" }),
      tenant_id: 2,
      member_id: "other-member",
      is_byok: 1,
      is_active: 1,
    });
    const { app, env } = buildTestApp(linkDb, masterKey, 1);

    const res = await app.fetch(
      new Request("https://link-dev.uni-scrm.com/x/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: "tenant-2-channel", client_id: "cid", client_secret: "csecret", consumer_secret: "consecret" }),
      }),
      env
    );

    // Not found under tenant 1's scope, and the id is already claimed by someone
    // else — rejected outright rather than falling through to create (which
    // would either collide on the primary key or, worse, silently overwrite it).
    expect(res.status).toBe(404);
    const unchanged = JSON.parse(linkDb._rows.get("tenant-2-channel")!.config);
    expect(unchanged.x_user_id).toBe("999");
  });
});
