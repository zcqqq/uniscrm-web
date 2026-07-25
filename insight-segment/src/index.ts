import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { getAllFields } from "./fields";
import { parseNaturalLanguage } from "./services/nl-parser";
import { validateConditions } from "./services/validator";
import { buildSegmentQuery } from "./services/sql-builder";
import { r2Query, latestRowsSql, sqlStr, sqlInt, R2SqlError } from "../../shared/r2-sql";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Auth middleware for /api/segments routes. Used to also look up tenants.d1_database_id and
// provision a TenantDataDB client for the per-tenant D1 database — no longer needed: segments
// now compute against R2 (uniscrm.user/event) and store membership in WEB_DB's segment_users,
// so there's no per-tenant D1 left in this module's loop. Dropping the lookup also means a
// tenant with no provisioned tenant DB (the norm going forward, per the plan this task is part
// of) no longer gets wrongly 503'd out of a feature that doesn't need one.
async function segmentAuth(c: any, next: any) {
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
  await next();
}
app.use("/api/segments", segmentAuth);
app.use("/api/segments/*", segmentAuth);

// R2_SQL_TOKEN is a hand-set secret, not CI-managed yet (unlike every other var this worker
// reads — see .superpowers/sdd/2026-07-25-tenant-db-removal/progress.md's "R2_SQL_TOKEN is not
// CI-managed" note: link and flow bind the same secret and deliberately keep it out of
// .secrets.json too, because scripts/secrets-sync.test.mjs requires every declared secret to be
// exported into both deploy workflows' sync-secrets env, and neither workflow does that for this
// name yet). A worker deployed without `wrangler secret put R2_SQL_TOKEN --env <env>` would
// otherwise send `Authorization: Bearer undefined` on every r2Query call and get back a generic
// 401 — indistinguishable at the call site from a real auth failure. This guard runs before any
// of the three routes that call r2Query (preview/compute/users) ever reach it, naming the actual
// cause instead. A per-request middleware, not a module-scope check, because `env` (and thus the
// secret) is only available once fetch() is called — Workers have no module-level "startup" with
// bindings attached.
export function checkR2SqlToken(env: Env): { ok: true } | { ok: false; message: string } {
  if (!env.R2_SQL_TOKEN) {
    return {
      ok: false,
      message: "R2_SQL_TOKEN is not configured on this worker — set it with `wrangler secret put R2_SQL_TOKEN --env <env>`",
    };
  }
  return { ok: true };
}

async function requireR2SqlToken(c: any, next: any) {
  const check = checkR2SqlToken(c.env);
  if (!check.ok) {
    console.error(JSON.stringify({ event: "r2_sql_token_missing", path: c.req.path }));
    return c.json({ error: check.message }, 500);
  }
  await next();
}
app.use("/api/segments/preview", requireR2SqlToken);
app.use("/api/segments/:id/compute", requireR2SqlToken);
app.use("/api/segments/:id/users", requireR2SqlToken);

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth proxy
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

// List segments
app.get("/api/segments", async (c) => {
  const tenantId = c.get("tenantId");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "10", 10)));
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

  const { sql } = buildSegmentQuery(validation.conditions, fields, Number(tenantId));
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

  const { sql } = buildSegmentQuery(validation.conditions, fields, Number(tenantId));

  // Wrap rather than string-replace the SELECT list: buildSegmentQuery's SQL is a QUALIFY
  // subquery with an outer WHERE/LIMIT, so there's no single "SELECT DISTINCT ..." prefix left
  // to swap for a COUNT the way the old flat D1 query allowed.
  let estimatedCount = 0;
  try {
    const countRows = await r2Query<{ cnt: number }>(c.env, `SELECT COUNT(*) AS cnt FROM (${sql}) AS t`);
    estimatedCount = countRows[0]?.cnt ?? 0;
  } catch (e) {
    // Never report a failed R2 query as "estimated_count: 0" — that reads as "this segment is
    // empty" instead of "this couldn't be checked", the exact silent-failure this module must
    // avoid (数据准确性 > 系统稳定性).
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `R2 query failed: ${msg}`, stage: "preview" }, e instanceof R2SqlError ? 502 : 500);
  }

  return c.json({
    conditions: validation.conditions,
    sql_query: sql,
    estimated_count: estimatedCount,
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

  // tenant-scope-ok: segmentId ownership verified by the SELECT ... AND tenant_id = ? guard above (404s a non-owner)
  await c.env.WEB_DB.prepare(`UPDATE segments SET status = 'computing', updated_at = datetime('now') WHERE id = ?`)
    .bind(segmentId)
    .run();

  try {
    const conditions = JSON.parse(segment.conditions_json);
    const fields = getAllFields();
    const { sql } = buildSegmentQuery(conditions, fields, Number(tenantId));

    // r2Query throws (never returns []) on failure — a bad query or an R2 outage lands in the
    // catch below and marks the segment 'error', instead of this route mistaking "the query
    // failed" for "the query matched zero users" and reporting status: 'ready', user_count: 0.
    // Silently-empty segments are worse than a visible error: 数据准确性 > 系统稳定性.
    const rows = await r2Query<{ id: string }>(c.env, sql);
    const userIds = rows.map((r) => r.id);

    // tenant-scope-ok: segmentId ownership verified by the SELECT ... AND tenant_id = ? guard
    // above (404s a non-owner); this DELETE also filters tenant_id directly.
    await c.env.WEB_DB.prepare(`DELETE FROM segment_users WHERE tenant_id = ? AND segment_id = ?`)
      .bind(tenantId, segmentId)
      .run();

    const now = new Date().toISOString();
    const BATCH_SIZE = 50;
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
      await c.env.WEB_DB.batch(
        userIds.slice(i, i + BATCH_SIZE).map((uid) =>
          c.env.WEB_DB
            .prepare(`INSERT OR IGNORE INTO segment_users (tenant_id, segment_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
            .bind(tenantId, segmentId, uid, now)
        )
      );
    }

    // tenant-scope-ok: segmentId ownership verified by the SELECT ... AND tenant_id = ? guard above (404s a non-owner)
    await c.env.WEB_DB.prepare(
      `UPDATE segments SET status = 'ready', user_count = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(userIds.length, segmentId)
      .run();

    return c.json({ segment: { id: segmentId, status: "ready", user_count: userIds.length } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // tenant-scope-ok: segmentId ownership verified by the SELECT ... AND tenant_id = ? guard above (404s a non-owner)
    await c.env.WEB_DB.prepare(
      `UPDATE segments SET status = 'error', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(segmentId)
      .run();
    return c.json({ error: msg }, e instanceof R2SqlError ? 502 : 500);
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

  // Membership lives in WEB_DB's segment_users now (task 9) — paginate there first, then hydrate
  // display fields for just that page from R2, rather than joining across two data stores.
  const memberRows = await c.env.WEB_DB.prepare(
    `SELECT user_id FROM segment_users WHERE tenant_id = ? AND segment_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, segmentId, limit, offset)
    .all<{ user_id: string }>();
  const userIds = memberRows.results.map((r) => r.user_id);

  const countRow = await c.env.WEB_DB.prepare(
    `SELECT COUNT(*) as total FROM segment_users WHERE tenant_id = ? AND segment_id = ?`
  )
    .bind(tenantId, segmentId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  let hydrated: { id: string; name: string | null; username: string | null }[] = [];
  if (userIds.length > 0) {
    try {
      hydrated = await r2Query<{ id: string; name: string | null; username: string | null }>(
        c.env,
        latestRowsSql({
          table: "uniscrm.user",
          columns: ["id", "name", "username", "is_deleted"],
          partitionBy: ["channel_id", "source_user_id"],
          where: [`tenant_id = ${sqlInt(Number(tenantId))}`, `id IN (${userIds.map(sqlStr).join(", ")})`],
          outerWhere: ["is_deleted = 0"],
        })
      );
    } catch (e) {
      // Same rule as compute: a failed R2 read must surface as an error, never as "this
      // segment has no members" (数据准确性 > 系统稳定性).
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `R2 query failed: ${msg}` }, e instanceof R2SqlError ? 502 : 500);
    }
  }
  const byId = new Map(hydrated.map((u) => [u.id, u]));
  // Field names (id/name/username) match frontend/lib/api.ts's SegmentUser and
  // SegmentDetail.tsx's rendering, which key off `id` — not segment_users' own `user_id`
  // column name. profile_image_url has no R2 column (link/src/services/x-users.ts: it only
  // ever lands in raw_data) so it's omitted; SegmentDetail.tsx's `{u.profile_image_url && ...}`
  // guard already renders nothing when it's absent. Preserve segment_users' created_at
  // ordering; a member whose R2 row is now deleted (dropped by outerWhere above) still renders
  // — with blank name/username — rather than silently vanishing from a page whose
  // `total`/pagination already counted it.
  const users = userIds.map((id) => {
    const u = byId.get(id);
    return { id, name: u?.name ?? null, username: u?.username ?? null };
  });

  return c.json({
    users,
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
        return Response.redirect(`${env.WEB_URL}/login`, 302);
      }
      const authRes = await fetch(`${env.WEB_URL}/api/auth/me`, {
        headers: { Cookie: `session=${sessionCookie}` },
      });
      if (!authRes.ok) {
        return Response.redirect(`${env.WEB_URL}/login`, 302);
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
