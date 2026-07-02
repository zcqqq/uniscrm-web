import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";

export function usersRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    if (!tenantId) return c.json({ users: [] });

    const res = await fetch(
      `https://api.sql.cloudflarestorage.com/api/v1/accounts/${c.env.CF_ACCOUNT_ID}/r2-sql/query/${c.env.R2_BUCKET}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${c.env.R2_SQL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouse: c.env.R2_WAREHOUSE,
          query: `SELECT id, channel_type, name, username, is_follow, is_followed, followers_count, following_count, updated_at FROM uniscrm.user WHERE tenant_id = ${tenantId} LIMIT 1000`,
        }),
      }
    );
    const data = await res.json() as { result?: { rows: Record<string, unknown>[] }; success: boolean };
    if (!data.success) return c.json({ users: [] });

    const rows = data.result?.rows || [];
    return c.json({ users: rows });
  });

  router.get("/:id", async (c) => {
    const tdb = c.get("tenantDataDb" as never) as TenantDataDB;
    if (!tdb) return c.json({ error: "Unauthorized" }, 401);

    const userId = c.req.param("id");
    const rows = await tdb.query(
      "SELECT id, name, username, profile_image_url, socials, maigret_status, raw_data, created_at, updated_at FROM user WHERE id = ?",
      [userId]
    );

    if (rows.length === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ user: rows[0] });
  });

  router.get("/:id/events", async (c) => {
    const tdb = c.get("tenantDataDb" as never) as TenantDataDB;
    if (!tdb) return c.json({ error: "Unauthorized" }, 401);

    const userId = c.req.param("id");
    const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
    const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "100", 10)));

    const rows = await tdb.query<{ id: string; event_type: string; event_time: string; raw_data: string; created_at: string }>(
      "SELECT id, event_type, event_time, raw_data, created_at FROM event WHERE user_id = ? ORDER BY event_time DESC LIMIT ? OFFSET ?",
      [userId, limit + 1, offset]
    );

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    return c.json({ events, hasMore });
  });

  return router;
}
