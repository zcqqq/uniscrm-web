import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string; tenantDataDb: TenantDataDB } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

const authMiddleware = async (c: any, next: any) => {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const webUrl = c.env.WEB_URL || "https://web-dev.uni-scrm.com";
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  c.set("memberId", data.member.id);

  const row = await (c.env.DB as D1Database).prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(Number(data.tenant.id))
    .first<{ d1_database_id: string | null }>();
  if (row?.d1_database_id) {
    c.set("tenantDataDb", new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  }
  await next();
};

app.use("/api/*", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

// --- Internal routes (service-to-service, no cookie auth) ---

app.post("/internal/lists/:id/users", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (!secret || secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const tenantId = c.req.header("X-Tenant-Id");
  if (!tenantId) return c.json({ error: "X-Tenant-Id required" }, 400);

  const listId = c.req.param("id");
  const body = await c.req.json<{ userId: string }>();
  if (!body.userId) return c.json({ error: "userId is required" }, 400);

  const list = await c.env.DB.prepare(
    "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first();
  if (!list) return c.json({ error: "List not found" }, 404);

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
  ).bind(listId, body.userId, Number(tenantId)).run();

  return c.json({ ok: true }, 201);
});

app.get("/api/auth/me", async (c) => {
  const webUrl = c.env.WEB_URL || "https://web-dev.uni-scrm.com";
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// --- Users (from tenant DB) ---

app.get("/api/users", async (c) => {
  const tdb = c.get("tenantDataDb");
  if (!tdb) return c.json({ users: [], total: 0, page: 1, totalPages: 0 });

  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 20));
  const offset = (page - 1) * limit;

  const countRows = await tdb.query<{ total: number }>("SELECT COUNT(*) as total FROM user");
  const total = countRows[0]?.total || 0;

  const users = await tdb.query(
    "SELECT id, name, username, updated_at FROM user ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    [limit, offset]
  );

  return c.json({ users, total, page, totalPages: Math.ceil(total / limit) });
});

// --- Lists (main DB) ---

app.get("/api/lists", async (c) => {
  const tenantId = c.get("tenantId");

  const { results: lists } = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.created_at, l.updated_at, COUNT(lu.user_id) as user_count
     FROM lists l
     LEFT JOIN list_users lu ON lu.list_id = l.id
     WHERE l.tenant_id = ?
     GROUP BY l.id
     ORDER BY l.updated_at DESC`
  ).bind(Number(tenantId)).all();

  return c.json({ lists });
});

app.post("/api/lists", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ name: string }>();
  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO lists (id, name, tenant_id) VALUES (?, ?, ?)"
  ).bind(id, body.name.trim(), Number(tenantId)).run();

  return c.json({ id, name: body.name.trim() }, 201);
});

app.delete("/api/lists/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const listId = c.req.param("id");

  await c.env.DB.prepare(
    "DELETE FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).run();

  return c.json({ ok: true });
});

// --- List Users (cross-DB: list_users in main, user details from tenant DB) ---

app.get("/api/lists/:id/users", async (c) => {
  const tenantId = c.get("tenantId");
  const tdb = c.get("tenantDataDb");
  const listId = c.req.param("id");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const countResult = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM list_users WHERE list_id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first<{ total: number }>();
  const total = countResult?.total || 0;

  const { results: listUserRows } = await c.env.DB.prepare(
    "SELECT user_id, created_at as added_at FROM list_users WHERE list_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).bind(listId, Number(tenantId), limit, offset).all<{ user_id: string; added_at: string }>();

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

app.post("/api/lists/:id/users", async (c) => {
  const tenantId = c.get("tenantId");
  const listId = c.req.param("id");
  const body = await c.req.json<{ userId: string }>();
  if (!body.userId) return c.json({ error: "userId is required" }, 400);

  const list = await c.env.DB.prepare(
    "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first();
  if (!list) return c.json({ error: "List not found" }, 404);

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
  ).bind(listId, body.userId, Number(tenantId)).run();

  return c.json({ ok: true }, 201);
});

app.delete("/api/lists/:id/users/:userId", async (c) => {
  const tenantId = c.get("tenantId");
  const listId = c.req.param("id");
  const userId = c.req.param("userId");

  await c.env.DB.prepare(
    "DELETE FROM list_users WHERE list_id = ? AND user_id = ? AND tenant_id = ?"
  ).bind(listId, userId, Number(tenantId)).run();

  return c.json({ ok: true });
});

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const accept = request.headers.get("Accept") || "";

    const isApiPath = url.pathname.startsWith("/api") || url.pathname.startsWith("/internal");

    if (accept.includes("text/html") && !isApiPath) {
      const sessionCookie = getCookieValue(request, "session");
      if (!sessionCookie) {
        const webUrl = env.WEB_URL || "https://web-dev.uni-scrm.com";
        return Response.redirect(`${webUrl}/login`, 302);
      }
    }

    if (!isApiPath && env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    }

    const res = await app.fetch(request, env);
    if (res.status === 404 && accept.includes("text/html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }
    return res;
  },
};
