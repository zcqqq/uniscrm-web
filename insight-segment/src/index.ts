import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { getAllFields } from "./fields";
import { parseNaturalLanguage } from "./services/nl-parser";
import { validateConditions } from "./services/validator";
import { buildSegmentQuery } from "./services/sql-builder";
import { TenantDataDB } from "../../shared/tenant-data-db";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string; tenantDataDb: TenantDataDB } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Auth middleware for /api/segments routes
async function segmentAuth(c: any, next: any) {
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

  const row = await (c.env.WEB_DB as D1Database).prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(Number(data.tenant.id))
    .first<{ d1_database_id: string | null }>();
  if (!row?.d1_database_id) return c.json({ error: "Tenant DB not provisioned" }, 503);
  c.set("tenantDataDb", new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  await next();
}
app.use("/api/segments", segmentAuth);
app.use("/api/segments/*", segmentAuth);

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

  const countRow = await c.env.WEB_DB.prepare(
    `SELECT COUNT(*) as total FROM segments WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.WEB_DB.prepare(
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
  let parseResult;
  try {
    parseResult = await parseNaturalLanguage(c.env.AI, body.nl_query, fields);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `AI parse failed: ${msg}`, stage: "parse" }, 422);
  }
  if (!parseResult.success) {
    return c.json({ error: parseResult.error, stage: "parse" }, 422);
  }

  const validation = validateConditions(parseResult.conditions, fields);
  if (!validation.valid) {
    return c.json({ errors: validation.errors, stage: "validate" }, 422);
  }

  const { sql, params } = buildSegmentQuery(validation.conditions, fields);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.WEB_DB.prepare(
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
  let parseResult;
  try {
    parseResult = await parseNaturalLanguage(c.env.AI, body.nl_query, fields);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `AI parse failed: ${msg}`, stage: "parse" }, 422);
  }
  if (!parseResult.success) {
    return c.json({ error: parseResult.error, stage: "parse" }, 422);
  }

  const validation = validateConditions(parseResult.conditions, fields);
  if (!validation.valid) {
    return c.json({ errors: validation.errors, stage: "validate" }, 422);
  }

  const { sql, params } = buildSegmentQuery(validation.conditions, fields);

  const tenantDataDb = c.get("tenantDataDb");
  const countSql = sql.replace("SELECT DISTINCT profile.id", "SELECT COUNT(DISTINCT profile.id) as cnt");
  const countRows = await tenantDataDb.query<{ cnt: number }>(countSql, params);

  return c.json({
    conditions: validation.conditions,
    sql_query: sql,
    estimated_count: countRows[0]?.cnt || 0,
  });
});

// Get segment detail
app.get("/api/segments/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");

  const segment = await c.env.WEB_DB.prepare(
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

  const segment = await c.env.WEB_DB.prepare(
    `SELECT id, sql_query, conditions_json FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .first<{ id: string; sql_query: string; conditions_json: string }>();

  if (!segment) return c.json({ error: "Not found" }, 404);

  await c.env.WEB_DB.prepare(`UPDATE segments SET status = 'computing', updated_at = datetime('now') WHERE id = ?`)
    .bind(segmentId)
    .run();

  try {
    const tenantDataDb = c.get("tenantDataDb");
    const conditions = JSON.parse(segment.conditions_json);
    const fields = getAllFields();
    const { sql, params } = buildSegmentQuery(conditions, fields);

    const rows = await tenantDataDb.query<{ id: string }>(sql, params);
    const profileIds = rows.map((r) => r.id).slice(0, 10000);

    await tenantDataDb.run(`DELETE FROM segment_profiles WHERE segment_id = ?`, [segmentId]);

    const now = new Date().toISOString();
    const BATCH_SIZE = 50;
    for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
      const batch = profileIds.slice(i, i + BATCH_SIZE);
      const stmts = batch.map((pid) => ({
        sql: `INSERT OR IGNORE INTO segment_profiles (segment_id, profile_id, created_at) VALUES (?, ?, ?)`,
        params: [segmentId, pid, now],
      }));
      await tenantDataDb.batch(stmts);
    }

    await c.env.WEB_DB.prepare(
      `UPDATE segments SET status = 'ready', user_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(profileIds.length, segmentId)
      .run();

    return c.json({ segment: { id: segmentId, status: "ready", user_count: profileIds.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.WEB_DB.prepare(
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

  // Verify segment belongs to tenant (main DB)
  const segment = await c.env.WEB_DB.prepare(
    `SELECT id FROM segments WHERE id = ? AND tenant_id = ?`
  )
    .bind(segmentId, tenantId)
    .first();
  if (!segment) return c.json({ error: "Not found" }, 404);

  const tenantDataDb = c.get("tenantDataDb");
  const rows = await tenantDataDb.query(
    `SELECT sp.profile_id, u.id as user_id, u.name, u.username, u.profile_image_url
     FROM segment_profiles sp
     INNER JOIN user u ON u.profile_id = sp.profile_id
     WHERE sp.segment_id = ?
     ORDER BY sp.created_at DESC LIMIT ? OFFSET ?`,
    [segmentId, limit, offset]
  );

  const countRows = await tenantDataDb.query<{ total: number }>(
    `SELECT COUNT(*) as total FROM segment_profiles WHERE segment_id = ?`,
    [segmentId]
  );
  const total = countRows[0]?.total || 0;

  return c.json({
    users: rows,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

// Delete segment
app.delete("/api/segments/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const segmentId = c.req.param("id");

  const result = await c.env.WEB_DB.prepare(
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
