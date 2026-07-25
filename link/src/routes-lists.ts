import { Hono } from "hono";
import type { Env } from "./types";
import { getUserDisplayNames } from "./services/r2-entities";
import { R2SqlError } from "../../shared/r2-sql";

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

    // list_users (LINK_DB, D1) still owns membership; the display name/username are an R2 read
    // now that `user` rows only live in R2. A silent empty `users` array would look identical
    // to "list has no members", so an R2 failure must surface as an error rather than being
    // swallowed the way the old `tdb &&` guard did.
    let users: { id: string; name: string | null; username: string | null; added_at: string }[] = [];
    if (listUserRows.length > 0) {
      const ids = listUserRows.map((r) => r.user_id);
      try {
        const names = await getUserDisplayNames(c.env, tenantId, ids);
        users = listUserRows.map((r) => {
          const display = names.get(r.user_id);
          return {
            id: r.user_id,
            name: display?.name ?? null,
            username: display?.username ?? null,
            added_at: r.added_at,
          };
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "list_users_r2_query_failed", tenantId, listId, error: String(err) }));
        const status = err instanceof R2SqlError ? 502 : 500;
        return c.json({ error: String(err) }, status);
      }
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
