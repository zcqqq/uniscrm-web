import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { createModuleGuard } from "../../shared/plan-guard";
import { getActiveSubscriptionTier } from "../../shared/credit-service";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string; tenantDataDb: TenantDataDB } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

export class MaigretContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
}

const authMiddleware = async (c: any, next: any) => {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const webUrl = c.env.WEB_URL;
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  c.set("memberId", data.member.id);

  const row = await (c.env.WEB_DB as D1Database).prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(Number(data.tenant.id))
    .first<{ d1_database_id: string | null }>();
  if (row?.d1_database_id) {
    c.set("tenantDataDb", new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  }
  await next();
};

app.use("/api/*", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

// --- Internal routes ---

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

  const list = await c.env.WEB_DB.prepare(
    "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first();
  if (!list) return c.json({ error: "List not found" }, 404);

  await c.env.WEB_DB.prepare(
    "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
  ).bind(listId, body.userId, Number(tenantId)).run();

  return c.json({ ok: true }, 201);
});

app.post("/internal/maigret-retry", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (!secret || secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const dbId = c.req.query("db_id");
  if (!dbId) return c.json({ error: "db_id required" }, 400);

  const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, dbId);
  const limit = Math.min(100, parseInt(c.req.query("limit") || "50", 10));

  const rows = await tdb.query<{ id: string; username: string }>(
    "SELECT id, username FROM user WHERE (profile_id IS NULL OR profile_id IN (SELECT id FROM profile WHERE maigret_status IN ('pending', 'running', 'error'))) AND username IS NOT NULL LIMIT ?",
    [limit]
  );

  // Note: queue producer is in link-social; this endpoint is for direct triggering
  // For now, we process inline via container
  let processed = 0;
  for (const row of rows) {
    try {
      const profileId = await runMaigretForUser(c.env, tdb, row.id, row.username);
      if (profileId) processed++;
    } catch (e) {
      console.error(`maigret-retry failed for @${row.username}: ${e}`);
    }
  }

  return c.json({ processed, total: rows.length });
});

// --- Auth proxy ---

app.get("/api/auth/me", async (c) => {
  const webUrl = c.env.WEB_URL;
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

const profileModuleGuard = createModuleGuard("profile", async (c: any) => {
  const tenantId = Number(c.get("tenantId"));
  const sub = await getActiveSubscriptionTier(c.env.ADMIN_DB, tenantId);
  return sub?.tier ?? null;
});
app.use("/api/users/*", profileModuleGuard);
app.use("/api/lists/*", profileModuleGuard);

// --- Users (from tenant DB) ---

app.get("/api/users", async (c) => {
  const tdb = c.get("tenantDataDb");
  if (!tdb) return c.json({ users: [], total: 0, page: 1, totalPages: 0 });

  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit")) || 10));
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

  const { results: lists } = await c.env.WEB_DB.prepare(
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
  const memberId = c.get("memberId");
  const body = await c.req.json<{ name: string }>();
  if (!body.name?.trim()) return c.json({ error: "Name is required" }, 400);

  const id = crypto.randomUUID();
  await c.env.WEB_DB.prepare(
    "INSERT INTO lists (id, name, tenant_id, member_id) VALUES (?, ?, ?, ?)"
  ).bind(id, body.name.trim(), Number(tenantId), memberId).run();

  return c.json({ id, name: body.name.trim() }, 201);
});

app.delete("/api/lists/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const listId = c.req.param("id");

  await c.env.WEB_DB.prepare(
    "DELETE FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).run();

  return c.json({ ok: true });
});

// --- List Users ---

app.get("/api/lists/:id/users", async (c) => {
  const tenantId = c.get("tenantId");
  const tdb = c.get("tenantDataDb");
  const listId = c.req.param("id");
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const countResult = await c.env.WEB_DB.prepare(
    "SELECT COUNT(*) as total FROM list_users WHERE list_id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first<{ total: number }>();
  const total = countResult?.total || 0;

  const { results: listUserRows } = await c.env.WEB_DB.prepare(
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

  const list = await c.env.WEB_DB.prepare(
    "SELECT id FROM lists WHERE id = ? AND tenant_id = ?"
  ).bind(listId, Number(tenantId)).first();
  if (!list) return c.json({ error: "List not found" }, 404);

  await c.env.WEB_DB.prepare(
    "INSERT OR IGNORE INTO list_users (list_id, user_id, tenant_id) VALUES (?, ?, ?)"
  ).bind(listId, body.userId, Number(tenantId)).run();

  return c.json({ ok: true }, 201);
});

app.delete("/api/lists/:id/users/:userId", async (c) => {
  const tenantId = c.get("tenantId");
  const listId = c.req.param("id");
  const userId = c.req.param("userId");

  await c.env.WEB_DB.prepare(
    "DELETE FROM list_users WHERE list_id = ? AND user_id = ? AND tenant_id = ?"
  ).bind(listId, userId, Number(tenantId)).run();

  return c.json({ ok: true });
});

// --- Maigret Logic ---

interface QueueMessage {
  user_id: string;
  username: string;
  db_id: string;
}

interface MaigretResult {
  socials: Record<string, string>;
  status: string;
  error?: string;
}

async function runMaigretForUser(env: Env, tdb: TenantDataDB, userId: string, username: string): Promise<string | null> {
  const container = env.MAIGRET_CONTAINER.getByName("maigret-singleton");
  await container.startAndWaitForPorts();

  const response = await container.fetch("http://container/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Container error for @${username}: ${response.status} ${text}`);
    throw new Error(`Container returned ${response.status}`);
  }

  const result = await response.json() as MaigretResult;
  const now = new Date().toISOString();

  if (result.status === "done" && Object.keys(result.socials).length > 0) {
    // Found social profiles
    const profileId = await findOrCreateProfile(tdb, result.socials, now);
    await tdb.run("UPDATE user SET profile_id = ?, updated_at = ? WHERE id = ?", [profileId, now, userId]);
    console.log(`@${username}: done, profile=${profileId}, ${Object.keys(result.socials).length} platforms`);
    return profileId;
  }

  if (result.status === "failed") {
    // Process error (maigret threw an exception)
    const profileId = crypto.randomUUID();
    await tdb.run(
      "INSERT INTO profile (id, socials, maigret_status, created_at, updated_at) VALUES (?, '{}', 'error', ?, ?)",
      [profileId, now, now]
    );
    await tdb.run("UPDATE user SET profile_id = ?, updated_at = ? WHERE id = ?", [profileId, now, userId]);
    console.log(`@${username}: error, profile=${profileId}`);
    return profileId;
  }

  // Completed successfully but no social profiles found
  const profileId = crypto.randomUUID();
  await tdb.run(
    "INSERT INTO profile (id, socials, maigret_status, created_at, updated_at) VALUES (?, '{}', 'not_found', ?, ?)",
    [profileId, now, now]
  );
  await tdb.run("UPDATE user SET profile_id = ?, updated_at = ? WHERE id = ?", [profileId, now, userId]);
  console.log(`@${username}: not_found, profile=${profileId}`);
  return profileId;
}

async function findOrCreateProfile(tdb: TenantDataDB, socials: Record<string, string>, now: string): Promise<string> {
  // Extract usernames from URLs for matching
  const newUsernames = new Set(
    Object.values(socials).map((url) => {
      const parts = url.replace(/\/$/, "").split("/");
      return parts[parts.length - 1].toLowerCase();
    }).filter(Boolean)
  );

  // Check existing profiles for overlap
  const existingProfiles = await tdb.query<{ id: string; socials: string }>(
    "SELECT id, socials FROM profile WHERE maigret_status = 'done'"
  );

  for (const existing of existingProfiles) {
    try {
      const existingSocials = JSON.parse(existing.socials) as Record<string, string>;
      for (const url of Object.values(existingSocials)) {
        const parts = url.replace(/\/$/, "").split("/");
        const existingUsername = parts[parts.length - 1].toLowerCase();
        if (existingUsername && newUsernames.has(existingUsername)) {
          // Merge: update existing profile with new socials
          const merged = { ...existingSocials, ...socials };
          await tdb.run(
            "UPDATE profile SET socials = ?, updated_at = ? WHERE id = ?",
            [JSON.stringify(merged), now, existing.id]
          );
          return existing.id;
        }
      }
    } catch {
      continue;
    }
  }

  // No match — create new profile
  const profileId = crypto.randomUUID();
  await tdb.run(
    "INSERT INTO profile (id, socials, maigret_status, created_at, updated_at) VALUES (?, ?, 'done', ?, ?)",
    [profileId, JSON.stringify(socials), now, now]
  );
  return profileId;
}

// --- Fetch + Queue handlers ---

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
        const webUrl = env.WEB_URL;
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

  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      const { user_id, username, db_id } = msg.body;
      if (!user_id || !username || !db_id) {
        msg.ack();
        continue;
      }

      try {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, db_id);
        await runMaigretForUser(env, tdb, user_id, username);
        msg.ack();
      } catch (err) {
        console.error(`Queue error for @${username}:`, err);
        msg.retry();
      }
    }
  },
};
