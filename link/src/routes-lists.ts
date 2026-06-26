import { Hono } from "hono";
import type { Env } from "./types";
import type { TenantDataDB } from "../../shared/tenant-data-db";

export function listsRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;

    const { results: lists } = await c.env.LINK_DB.prepare(
      `SELECT l.id, l.name, l.created_at, l.updated_at, COUNT(lu.user_id) as user_count
       FROM lists l
       LEFT JOIN list_users lu ON lu.list_id = l.id
       WHERE l.tenant_id = ?
       GROUP BY l.id
       ORDER BY l.updated_at DESC`
    ).bind(tenantId).all();

    return c.json({ lists });
  });

  router.post("/", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const memberId = c.get("memberId" as never) as string;
    const body = await c.req.json<{ name: string }>();
    if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);

    const id = crypto.randomUUID();
    await c.env.LINK_DB.prepare(
      "INSERT INTO lists (id, name, tenant_id, member_id) VALUES (?, ?, ?, ?)"
    ).bind(id, body.name.trim(), tenantId, memberId).run();

    return c.json({ id, name: body.name.trim() }, 201);
  });

  router.delete("/:id", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const listId = c.req.param("id");

    await c.env.LINK_DB.prepare(
      "DELETE FROM lists WHERE id = ? AND tenant_id = ?"
    ).bind(listId, tenantId).run();

    return c.json({ ok: true });
  });

  router.get("/:id/users", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const tdb = c.get("tenantDataDb" as never) as TenantDataDB | undefined;
    const listId = c.req.param("id");
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const countResult = await c.env.LINK_DB.prepare(
      "SELECT COUNT(*) as total FROM list_users WHERE list_id = ? AND tenant_id = ?"
    ).bind(listId, tenantId).first<{ total: number }>();
    const total = countResult?.total || 0;

    const { results: listUserRows } = await c.env.LINK_DB.prepare(
      "SELECT user_id, created_at as added_at FROM list_users WHERE list_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(listId, tenantId, limit, offset).all<{ user_id: string; added_at: string }>();

    let users: any[] = [];
    if (tdb && listUserRows.length > 0) {
      const ids = listUserRows.map((r) => r.user_id);
      const placeholders = ids.map(() => "?").join(",");
      const userDetails = await tdb.query<{ id: string; name: string; username: string; updated_at: string }>(
        `SELECT id, name, username, updated_at FROM user WHERE id IN (${placeholders})`,
        ids
      );
      const detailMap = new Map(userDetails.map((u) => [u.id, u]));
      users = listUserRows.map((r) => ({
        ...(detailMap.get(r.user_id) || { id: r.user_id, name: null, username: null }),
        added_at: r.added_at,
      }));
    }

    return c.json({ users, total, page, totalPages: Math.ceil(total / limit) });
  });

  router.post("/:id/users", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const listId = c.req.param("id");
    const body = await c.req.json<{ userId: string }>();
    if (!body.userId) return c.json({ error: "userId is required" }, 400);

    const list = await c.env.LINK_DB.prepare(
      "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
    ).bind(listId, tenantId).first();
    if (!list) return c.json({ error: "List not found" }, 404);

    await c.env.LINK_DB.prepare(
      "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
    ).bind(listId, body.userId, tenantId).run();

    return c.json({ ok: true }, 201);
  });

  router.delete("/:id/users/:userId", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const listId = c.req.param("id");
    const userId = c.req.param("userId");

    await c.env.LINK_DB.prepare(
      "DELETE FROM list_users WHERE list_id = ? AND user_id = ? AND tenant_id = ?"
    ).bind(listId, userId, tenantId).run();

    return c.json({ ok: true });
  });

  return router;
}
