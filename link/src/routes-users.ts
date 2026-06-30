import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";

export function usersRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tdb = c.get("tenantDataDb" as never) as TenantDataDB;
    if (!tdb) return c.json({ users: [], total: 0, page: 1, totalPages: 0 });

    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "10", 10)));
    const offset = (page - 1) * limit;

    const countRows = await tdb.query<{ total: number }>("SELECT COUNT(*) as total FROM user");
    const total = countRows[0]?.total || 0;

    const rows = await tdb.query<{ id: string; name: string; username: string; profile_image_url: string; updated_at: string }>(
      "SELECT id, name, username, profile_image_url, updated_at FROM user ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      [limit, offset]
    );

    return c.json({ users: rows, total, page, totalPages: Math.ceil(total / limit) });
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
