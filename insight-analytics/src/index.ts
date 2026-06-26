import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, IntervalAnalysis, IntervalResults } from "./types";
import { TenantDataDB } from "../../shared/tenant-data-db";
import { computeIntervals } from "./services/interval-compute";
import { computeStats, computeDistribution } from "./services/stats";
import { PROFILE_BATCH_SIZE } from "./constants";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string; tenantDataDb: TenantDataDB; tenantDbId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function authMiddleware(c: any, next: any) {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const webUrl = c.env.WEB_URL || "https://web-dev.uni-scrm.com";
  const res = await fetch(`${webUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  c.set("memberId", data.member.id);

  const row = await (c.env.DB as D1Database)
    .prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
    .bind(Number(data.tenant.id))
    .first<{ d1_database_id: string | null }>();
  if (!row?.d1_database_id) return c.json({ error: "Tenant DB not provisioned" }, 503);
  c.set("tenantDbId", row.d1_database_id);
  c.set("tenantDataDb", new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id));
  await next();
}
app.use("/api/analyses", authMiddleware);
app.use("/api/analyses/*", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/auth/me", async (c) => {
  const webUrl = c.env.WEB_URL || "https://web-dev.uni-scrm.com";
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// List analyses
app.get("/api/analyses", async (c) => {
  const tenantId = c.get("tenantId");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as total FROM interval_analyses WHERE tenant_id = ?"
  ).bind(tenantId).first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, event_type_a, event_type_b, time_range_start, time_range_end,
            status, total_profiles, pair_count, created_at, updated_at
     FROM interval_analyses WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(tenantId, limit, offset).all();

  return c.json({ analyses: rows.results, total, page, totalPages: Math.ceil(total / limit) });
});

// Create and compute analysis (synchronous for now)
app.post("/api/analyses", async (c) => {
  const tenantId = c.get("tenantId");
  const memberId = c.get("memberId");
  const tenantDataDb = c.get("tenantDataDb");
  const body = await c.req.json<{
    event_type_a: string;
    event_type_b: string;
    time_range_start?: string;
    time_range_end?: string;
  }>();

  if (!body.event_type_a || !body.event_type_b) {
    return c.json({ error: "event_type_a and event_type_b are required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO interval_analyses (id, tenant_id, member_id, event_type_a, event_type_b,
      time_range_start, time_range_end, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'computing', ?, ?)`
  ).bind(
    id, tenantId, memberId,
    body.event_type_a, body.event_type_b,
    body.time_range_start || null, body.time_range_end || null,
    now, now
  ).run();

  try {
    const results = await runComputation(tenantDataDb, body.event_type_a, body.event_type_b, body.time_range_start, body.time_range_end);

    await c.env.DB.prepare(
      `UPDATE interval_analyses SET status = 'ready', total_profiles = ?, pair_count = ?,
       results_json = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(results.total_profiles, results.total_pairs, JSON.stringify(results), id).run();

    return c.json({ analysis: { id, status: "ready", results } }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      "UPDATE interval_analyses SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(msg, id).run();
    return c.json({ error: msg }, 500);
  }
});

// Get analysis detail
app.get("/api/analyses/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const analysisId = c.req.param("id");

  const row = await c.env.DB.prepare(
    "SELECT * FROM interval_analyses WHERE id = ? AND tenant_id = ?"
  ).bind(analysisId, tenantId).first<IntervalAnalysis>();

  if (!row) return c.json({ error: "Not found" }, 404);

  const results = row.results_json ? JSON.parse(row.results_json) as IntervalResults : null;
  return c.json({ analysis: { ...row, results, results_json: undefined } });
});

// Delete analysis
app.delete("/api/analyses/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const analysisId = c.req.param("id");

  const result = await c.env.DB.prepare(
    "DELETE FROM interval_analyses WHERE id = ? AND tenant_id = ?"
  ).bind(analysisId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

async function runComputation(
  db: TenantDataDB,
  eventTypeA: string,
  eventTypeB: string,
  timeStart?: string,
  timeEnd?: string
): Promise<IntervalResults> {
  const timeConditions: string[] = [];
  const timeParams: unknown[] = [];
  if (timeStart) {
    timeConditions.push("e.event_time >= ?");
    timeParams.push(timeStart);
  }
  if (timeEnd) {
    timeConditions.push("e.event_time <= ?");
    timeParams.push(timeEnd);
  }
  const timeWhere = timeConditions.length ? " AND " + timeConditions.join(" AND ") : "";

  // Get distinct profile_ids that have at least one relevant event
  const profileRows = await db.query<{ profile_id: string }>(
    `SELECT DISTINCT u.profile_id
     FROM event e INNER JOIN user u ON u.id = e.user_id
     WHERE e.event_type IN (?, ?) AND u.profile_id IS NOT NULL${timeWhere}
     ORDER BY u.profile_id
     LIMIT ?`,
    [eventTypeA, eventTypeB, ...timeParams, PROFILE_BATCH_SIZE * 50]
  );

  const profileIds = profileRows.map((r) => r.profile_id);
  const allIntervals: number[] = [];

  // Process in batches
  for (let i = 0; i < profileIds.length; i += PROFILE_BATCH_SIZE) {
    const batch = profileIds.slice(i, i + PROFILE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");

    const events = await db.query<{ profile_id: string; event_type: string; event_time: string }>(
      `SELECT u.profile_id, e.event_type, e.event_time
       FROM event e INNER JOIN user u ON u.id = e.user_id
       WHERE u.profile_id IN (${placeholders})
         AND e.event_type IN (?, ?)${timeWhere}
       ORDER BY u.profile_id, e.event_time ASC`,
      [...batch, eventTypeA, eventTypeB, ...timeParams]
    );

    // Group by profile_id and compute intervals
    let currentProfile: string | null = null;
    let profileEvents: { event_type: string; event_time: string }[] = [];

    for (const evt of events) {
      if (evt.profile_id !== currentProfile) {
        if (currentProfile && profileEvents.length > 0) {
          const intervals = computeIntervals(profileEvents, eventTypeA, eventTypeB);
          allIntervals.push(...intervals);
        }
        currentProfile = evt.profile_id;
        profileEvents = [];
      }
      profileEvents.push({ event_type: evt.event_type, event_time: evt.event_time });
    }
    // Process last profile
    if (currentProfile && profileEvents.length > 0) {
      const intervals = computeIntervals(profileEvents, eventTypeA, eventTypeB);
      allIntervals.push(...intervals);
    }
  }

  const stats = computeStats(allIntervals);
  const buckets = computeDistribution(allIntervals);

  return {
    stats,
    buckets,
    total_profiles: profileIds.length,
    total_pairs: allIntervals.length,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html") && !url.pathname.startsWith("/api")) {
      const sessionCookie = getCookieValue(request, "session");
      if (!sessionCookie) {
        const webUrl = env.WEB_URL || "https://web-dev.uni-scrm.com";
        return Response.redirect(`${webUrl}/login`, 302);
      }
    }

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
