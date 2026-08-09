import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../../src/routes-channels";
import type { Env } from "../../src/types";

// Deleting a BYOK channel used to only flip is_active. But channels has
// UNIQUE(channel_type, source_channel_id) and the cross-tenant conflict check in oauth.ts
// does NOT filter on is_active, so the dead row kept holding the X account: re-connecting it
// under any other tenant answered 409 forever, with no way out from the UI.

function recordingDb() {
  const calls: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push({ sql, args });
        return { run: async () => ({ success: true }), first: async () => null, all: async () => ({ results: [] }) };
      },
    }),
  };
  return { db: db as unknown as D1Database, calls };
}

function buildApp(tenantId = 1) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, tenantId as never);
    c.set("memberId" as never, "member-1" as never);
    await next();
  });
  app.route("/", channelsRoutes());
  return app;
}

describe("DELETE /x/byok/:channelId", () => {
  it("releases the X account by clearing source_channel_id, not just deactivating", async () => {
    const { db, calls } = recordingDb();
    const res = await buildApp().request("/x/byok/chan-1", { method: "DELETE" }, { LINK_DB: db } as unknown as Env);

    expect(res.status).toBe(200);
    const update = calls.find((c) => c.sql.includes("UPDATE channels"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("is_active = 0");
    expect(update!.sql).toContain("source_channel_id = NULL");
  });

  it("records why the row was deactivated, so a tier upgrade cannot resurrect it", async () => {
    const { db, calls } = recordingDb();
    await buildApp().request("/x/byok/chan-1", { method: "DELETE" }, { LINK_DB: db } as unknown as Env);

    const update = calls.find((c) => c.sql.includes("UPDATE channels"))!;
    expect(update.sql).toContain("deactivated_reason");
    expect(update.sql).toContain("byok_deleted");
  });

  it("stays tenant-scoped — the WHERE still binds the caller's tenant", async () => {
    const { db, calls } = recordingDb();
    await buildApp(7).request("/x/byok/chan-1", { method: "DELETE" }, { LINK_DB: db } as unknown as Env);

    const update = calls.find((c) => c.sql.includes("UPDATE channels"))!;
    expect(update.sql).toContain("WHERE id = ? AND tenant_id = ?");
    expect(update.args).toEqual(["chan-1", 7]);
  });
});
