import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { getAllFields } from "./metadata";
import { parseNaturalLanguage } from "./services/nl-parser";
import { validateConditions } from "./services/validator";
import { buildSegmentQuery } from "./services/sql-builder";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Auth middleware for /api/segments routes
app.use("/api/segments", async (c, next) => {
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
  await next();
});
app.use("/api/segments/*", async (c, next) => {
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
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth proxy
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

// List segments
app.get("/api/segments", async (c) => {
  const tenantId = c.get("tenantId");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM segments WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, name, nl_query, user_count, status, created_at, updated_at
     FROM segments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, limit, offset)
    .all();

  return c.json({ segments: rows.results, total, page, totalPages: Math.ceil(total / limit) });
});

// Create segment (NL → parse → validate → store)
app.post("/api/segments", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ name: string; nl_query: string }>();
  if (!body.name || !body.nl_query) {
    return c.json({ error: "name and nl_query are required" }, 400);
  }

  const fields = getAllFields();
  const parseResult = await parseNaturalLanguage(c.env.AI, body.nl_query, fields);
  if (!parseResult.success) {
    return c.json({ error: parseResult.error, stage: "parse" }, 422);
  }

  const validation = validateConditions(parseResult.conditions, fields);
  if (!validation.valid) {
    return c.json({ errors: validation.errors, stage: "validate" }, 422);
  }

  const { sql, params } = buildSegmentQuery(validation.conditions, tenantId, fields);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO segments (id, tenant_id, name, nl_query, conditions_json, sql_query, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(id, tenantId, body.name, body.nl_query, JSON.stringify(validation.conditions), sql, now, now)
    .run();

  return c.json(
    {
      segment: {
        id,
        name: body.name,
        nl_query: body.nl_query,
        conditions_json: validation.conditions,
        sql_query: sql,
        status: "draft",
        user_count: 0,
      },
    },
    201
  );
});

// Preview (parse + validate + count, no save)
app.post("/api/segments/preview", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ nl_query: string }>();
  if (!body.nl_query) return c.json({ error: "nl_query is required" }, 400);

  const fields = getAllFields();
  const parseResult = await parseNaturalLanguage(c.env.AI, body.nl_query, fields);
  if (!parseResult.success) {
    return c.json({ error: parseResult.error, stage: "parse" }, 422);
  }

  const validation = validateConditions(parseResult.conditions, fields);
  if (!validation.valid) {
    return c.json({ errors: validation.errors, stage: "validate" }, 422);
  }

  const { sql, params } = buildSegmentQuery(validation.conditions, tenantId, fields);

  const countSql = `SELECT COUNT(DISTINCT user_x.id) as cnt FROM (${sql.replace("SELECT DISTINCT user_x.id FROM", "SELECT user_x.id FROM")}) sub`;
  // Simpler approach: wrap with count
  const countResult = await c.env.DB.prepare(
    sql.replace("SELECT DISTINCT user_x.id", "SELECT COUNT(DISTINCT user_x.id) as cnt")
  )
    .bind(...params)
    .first<{ cnt: number }>();

  return c.json({
    conditions: validation.conditions,
    sql_query: sql,
    estimated_count: countResult?.cnt || 0,
  });
});

// Get segment detail
app.get("/api/segments/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");

  const segment = await c.env.DB.prepare(
    `SELECT * FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .first();

  if (!segment) return c.json({ error: "Not found" }, 404);
  return c.json({ segment });
});

// Compute segment (execute SQL, populate segment_users)
app.post("/api/segments/:id/compute", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");

  const segment = await c.env.DB.prepare(
    `SELECT id, sql_query, conditions_json FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .first<{ id: string; sql_query: string; conditions_json: string }>();

  if (!segment) return c.json({ error: "Not found" }, 404);

  await c.env.DB.prepare(`UPDATE segments SET status = 'computing', updated_at = datetime('now') WHERE id = ?`)
    .bind(segmentId)
    .run();

  try {
    const conditions = JSON.parse(segment.conditions_json);
    const fields = getAllFields();
    const { sql, params } = buildSegmentQuery(conditions, tenantId, fields);

    const rows = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{ id: string }>();

    const userIds = rows.results.map((r) => r.id).slice(0, 10000);

    // Clear old results
    await c.env.DB.prepare(`DELETE FROM segment_users WHERE segment_id = ?`).bind(segmentId).run();

    // Batch insert using db.batch() — each statement has only 3 bind params
    const now = new Date().toISOString();
    const BATCH_SIZE = 50;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      const batch = userIds.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((uid) =>
        c.env.DB.prepare(`INSERT OR IGNORE INTO segment_users (segment_id, user_id, created_at) VALUES (?, ?, ?)`)
          .bind(segmentId, uid, now)
      );
      await c.env.DB.batch(stmts);
    }

    await c.env.DB.prepare(
      `UPDATE segments SET status = 'ready', user_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(userIds.length, segmentId)
      .run();

    return c.json({ segment: { id: segmentId, status: "ready", user_count: userIds.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      `UPDATE segments SET status = 'error', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(segmentId)
      .run();
    return c.json({ error: msg }, 500);
  }
});

// List users in segment
app.get("/api/segments/:id/users", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  // Verify segment belongs to tenant
  const segment = await c.env.DB.prepare(
    `SELECT id FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .first();
  if (!segment) return c.json({ error: "Not found" }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.username, u.profile_image_url
     FROM segment_users su
     INNER JOIN user_x u ON u.id = su.user_id
     WHERE su.segment_id = ?
     ORDER BY su.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(segmentId, limit, offset)
    .all();

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM segment_users WHERE segment_id = ?`
  )
    .bind(segmentId)
    .first<{ total: number }>();

  return c.json({
    users: rows.results,
    total: countRow?.total || 0,
    page,
    totalPages: Math.ceil((countRow?.total || 0) / limit),
  });
});

// Delete segment
app.delete("/api/segments/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");

  const result = await c.env.DB.prepare(
    `DELETE FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth redirect for HTML pages
    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html") && !url.pathname.startsWith("/api")) {
      const sessionCookie = getCookieValue(request, "session");
      if (!sessionCookie) {
        const webUrl = env.WEB_URL || "https://web-dev.uni-scrm.com";
        return Response.redirect(`${webUrl}/login`, 302);
      }
    }

    // Serve static assets first for non-API paths
    if (!url.pathname.startsWith("/api") && env.ASSETS) {
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
