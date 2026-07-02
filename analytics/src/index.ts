import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import type { Env, IntervalResults, AnalyticsReport } from "./types";
import { computeStats, computeDistribution } from "./services/stats";

export class AnalyticsContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
}

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function authMiddleware(c: any, next: any) {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const webUrl = c.env.WEB_URL;
  const res = await fetch(`${webUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  c.set("memberId", data.member.id);
  await next();
}

app.use("/api/reports", authMiddleware);
app.use("/api/reports/*", authMiddleware);
app.use("/api/dashboards", authMiddleware);
app.use("/api/dashboards/*", authMiddleware);
app.use("/api/dashboard-items/*", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/auth/me", async (c) => {
  const webUrl = c.env.WEB_URL;
  const res = await fetch(`${webUrl}/api/auth/me`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// ============ Reports API (async via Container + R2 SQL) ============

app.get("/api/reports", async (c) => {
  const tenantId = c.get("tenantId");
  const type = c.req.query("type");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "10", 10)));
  const offset = (page - 1) * limit;

  const whereType = type ? " AND type = ?" : "";
  const params: unknown[] = type ? [tenantId, type, limit, offset] : [tenantId, limit, offset];

  const countRow = await c.env.ANALYTICS_DB.prepare(
    `SELECT COUNT(*) as total FROM analytics_reports WHERE tenant_id = ?${whereType}`
  ).bind(...(type ? [tenantId, type] : [tenantId])).first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.ANALYTICS_DB.prepare(
    `SELECT id, type, params_json, status, results_json, error_message, created_at, updated_at
     FROM analytics_reports WHERE tenant_id = ?${whereType} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params).all();

  const reports = rows.results.map((r: any) => ({
    ...r,
    params: JSON.parse(r.params_json),
    results: r.results_json ? JSON.parse(r.results_json) : null,
    params_json: undefined,
    results_json: undefined,
  }));

  return c.json({ reports, total, page, totalPages: Math.ceil(total / limit) });
});

app.post("/api/reports", async (c) => {
  const tenantId = c.get("tenantId");
  const memberId = c.get("memberId");
  const body = await c.req.json<{ type: string; params: Record<string, unknown> }>();

  if (!body.type || !body.params) {
    return c.json({ error: "type and params are required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.ANALYTICS_DB.prepare(
    `INSERT INTO analytics_reports (id, tenant_id, member_id, type, params_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, tenantId, memberId, body.type, JSON.stringify(body.params), now, now).run();

  await c.env.ANALYTICS_QUEUE.send({
    report_id: id,
    type: body.type,
    params: body.params,
    tenant_id: tenantId,
    warehouse: c.env.R2_WAREHOUSE,
  });

  return c.json({ report: { id, status: "pending" } }, 201);
});

app.get("/api/reports/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");

  const row = await c.env.ANALYTICS_DB.prepare(
    "SELECT * FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).first<AnalyticsReport>();

  if (!row) return c.json({ error: "Not found" }, 404);

  const results = row.results_json ? JSON.parse(row.results_json) : null;
  return c.json({ report: { ...row, results, results_json: undefined, params: JSON.parse(row.params_json), params_json: undefined } });
});

app.delete("/api/reports/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");

  const result = await c.env.ANALYTICS_DB.prepare(
    "DELETE FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// ============ Dashboards API ============

app.get("/api/dashboards", async (c) => {
  const tenantId = c.get("tenantId");
  const rows = await c.env.ANALYTICS_DB.prepare(
    "SELECT id, name, created_at, updated_at FROM dashboards WHERE tenant_id = ? ORDER BY created_at DESC"
  ).bind(tenantId).all();
  return c.json({ dashboards: rows.results });
});

app.post("/api/dashboards", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ name: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ANALYTICS_DB.prepare(
    "INSERT INTO dashboards (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, tenantId, body.name, now, now).run();

  return c.json({ dashboard: { id, name: body.name } }, 201);
});

app.get("/api/dashboards/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const dashId = c.req.param("id");

  const dashboard = await c.env.ANALYTICS_DB.prepare(
    "SELECT * FROM dashboards WHERE id = ? AND tenant_id = ?"
  ).bind(dashId, tenantId).first();
  if (!dashboard) return c.json({ error: "Not found" }, 404);

  const items = await c.env.ANALYTICS_DB.prepare(
    `SELECT di.id, di.report_id, di.size, di.position,
            ar.name as report_name, ar.type, ar.params_json, ar.status, ar.results_json
     FROM dashboard_items di
     JOIN analytics_reports ar ON ar.id = di.report_id
     WHERE di.dashboard_id = ?
     ORDER BY di.position`
  ).bind(dashId).all();

  const parsedItems = items.results.map((item: any) => ({
    ...item,
    params: item.params_json ? JSON.parse(item.params_json) : null,
    results: item.results_json ? JSON.parse(item.results_json) : null,
    params_json: undefined,
    results_json: undefined,
  }));

  return c.json({ dashboard, items: parsedItems });
});

app.delete("/api/dashboards/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const dashId = c.req.param("id");
  const result = await c.env.ANALYTICS_DB.prepare(
    "DELETE FROM dashboards WHERE id = ? AND tenant_id = ?"
  ).bind(dashId, tenantId).run();
  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/dashboards/:id/items", async (c) => {
  const dashId = c.req.param("id");
  const body = await c.req.json<{ report_id: string; size?: string }>();
  if (!body.report_id) return c.json({ error: "report_id is required" }, 400);

  const maxPos = await c.env.ANALYTICS_DB.prepare(
    "SELECT COALESCE(MAX(position), -1) as max_pos FROM dashboard_items WHERE dashboard_id = ?"
  ).bind(dashId).first<{ max_pos: number }>();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.ANALYTICS_DB.prepare(
    "INSERT INTO dashboard_items (id, dashboard_id, report_id, size, position, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, dashId, body.report_id, body.size || "medium", (maxPos?.max_pos ?? -1) + 1, now).run();

  return c.json({ item: { id } }, 201);
});

app.patch("/api/dashboard-items/:id", async (c) => {
  const itemId = c.req.param("id");
  const body = await c.req.json<{ size?: string; position?: number }>();

  const updates: string[] = [];
  const params: unknown[] = [];
  if (body.size) { updates.push("size = ?"); params.push(body.size); }
  if (body.position !== undefined) { updates.push("position = ?"); params.push(body.position); }
  if (updates.length === 0) return c.json({ ok: true });

  params.push(itemId);
  await c.env.ANALYTICS_DB.prepare(
    `UPDATE dashboard_items SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...params).run();

  return c.json({ ok: true });
});

app.delete("/api/dashboard-items/:id", async (c) => {
  const itemId = c.req.param("id");
  await c.env.ANALYTICS_DB.prepare("DELETE FROM dashboard_items WHERE id = ?").bind(itemId).run();
  return c.json({ ok: true });
});

// ============ Queue Handler ============

interface QueueMessage {
  report_id: string;
  type: string;
  params: Record<string, unknown>;
  tenant_id: string;
  warehouse: string;
}

async function handleQueueMessage(msg: QueueMessage, env: Env): Promise<void> {
  const { report_id, type, params, tenant_id, warehouse } = msg;

  await env.ANALYTICS_DB.prepare(
    "UPDATE analytics_reports SET status = 'computing', updated_at = datetime('now') WHERE id = ?"
  ).bind(report_id).run();

  const container = env.ANALYTICS_CONTAINER.getByName("analytics-singleton");
  await container.startAndWaitForPorts();

  const sql = buildSQL(type, params, tenant_id);

  const response = await container.fetch("http://container/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, warehouse, token: env.CF_D1_API_TOKEN }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Container query failed: ${errBody}`);
  }

  const result = await response.json() as { data: unknown[] };

  let resultsJson: string;
  if (type === "interval") {
    resultsJson = JSON.stringify({ sql, ...processIntervalResults(result.data) });
  } else if (type === "funnel") {
    const steps = ((params as any).steps || []) as string[];
    resultsJson = JSON.stringify({ sql, ...processFunnelResults(result.data, steps) });
  } else {
    resultsJson = JSON.stringify({ sql, data: result.data });
  }

  await env.ANALYTICS_DB.prepare(
    "UPDATE analytics_reports SET status = 'ready', results_json = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(resultsJson, report_id).run();
}

function buildSQL(type: string, params: Record<string, unknown>, tenantId: string): string {
  if (type === "event") {
    const { event_type, measure, dimension, granularity, time_range_start, time_range_end, filters } = params as {
      event_type: string; measure: string; dimension?: string; granularity?: string;
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };
    const gran = granularity || "day";

    const timeFilter = [
      time_range_start ? `AND event_time >= '${time_range_start}'` : "",
      time_range_end ? `AND event_time <= '${time_range_end}'` : "",
    ].join(" ");

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    const dimCol = dimension ? `, ${dimension} as dimension` : "";
    const dimGroup = dimension ? `, ${dimension}` : "";

    // Total (aggregate) mode — no time grouping
    if (gran === "total") {
      const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : measure === "avg" ? "CAST(COUNT(*) AS DOUBLE) / NULLIF(COUNT(DISTINCT user_id), 0)" : "COUNT(*)";
      return `SELECT 'total' as period${dimCol}, ${agg} as value
FROM uniscrm.event
WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}${dimGroup ? ` GROUP BY ${dimension}` : ""}`;
    }

    const periodExpr = gran === "month" ? "DATE_TRUNC('month', event_time)"
      : gran === "week" ? "DATE_TRUNC('week', event_time)"
      : gran === "hour" ? "EXTRACT(HOUR FROM event_time)"
      : gran === "weekday" ? "EXTRACT(DOW FROM event_time)"
      : "DATE_TRUNC('day', event_time)";

    if (measure === "avg") {
      return `SELECT period${dimCol ? ", dimension" : ""}, CAST(total AS DOUBLE) / NULLIF(users, 0) as value FROM (
  SELECT ${periodExpr} as period${dimCol}, COUNT(*) as total, COUNT(DISTINCT user_id) as users
  FROM uniscrm.event
  WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}
  GROUP BY period${dimGroup}
) ORDER BY period`;
    }

    const agg = measure === "users" ? "COUNT(DISTINCT user_id)" : "COUNT(*)";
    return `SELECT ${periodExpr} as period${dimCol}, ${agg} as value
FROM uniscrm.event
WHERE tenant_id = ${tenantId} AND event_type = '${event_type}' ${timeFilter} ${filterClauses}
GROUP BY period${dimGroup} ORDER BY period`;
  }

  if (type === "interval") {
    const { event_type_a, event_type_b, time_range_start, time_range_end } = params as {
      event_type_a: string; event_type_b: string; time_range_start?: string; time_range_end?: string;
    };
    const timeFilter = [
      time_range_start ? `AND event_time >= '${time_range_start}'` : "",
      time_range_end ? `AND event_time <= '${time_range_end}'` : "",
    ].join(" ");

    return `WITH ordered AS (
  SELECT user_id, event_type, event_time,
    LEAD(event_type) OVER (PARTITION BY user_id ORDER BY event_time) as next_type,
    LEAD(event_time) OVER (PARTITION BY user_id ORDER BY event_time) as next_time
  FROM uniscrm.event
  WHERE tenant_id = ${tenantId} AND event_type IN ('${event_type_a}', '${event_type_b}') ${timeFilter}
)
SELECT user_id, event_time, next_time
FROM ordered
WHERE event_type = '${event_type_a}' AND next_type = '${event_type_b}'`;
  }

  if (type === "user") {
    const { measure, measure_field, dimension, buckets, filters } = params as {
      measure: string; measure_field?: string; dimension?: string;
      buckets?: number[];
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    let dimExpr = "";
    let dimGroup = "";
    if (dimension) {
      if (buckets && buckets.length > 0) {
        const cases = buckets.map((b, i) => {
          const prev = i === 0 ? 0 : buckets[i - 1];
          return `WHEN ${dimension} < ${b} THEN '${prev}-${b}'`;
        });
        cases.push(`ELSE '${buckets[buckets.length - 1]}+'`);
        dimExpr = `, CASE ${cases.join(" ")} END as dimension`;
        dimGroup = " GROUP BY dimension ORDER BY dimension";
      } else {
        dimExpr = `, ${dimension} as dimension`;
        dimGroup = ` GROUP BY ${dimension} ORDER BY value DESC`;
      }
    }

    const agg = measure === "avg" && measure_field ? `AVG(CAST(${measure_field} AS DOUBLE))`
      : measure === "sum" && measure_field ? `SUM(CAST(${measure_field} AS DOUBLE))`
      : "COUNT(*)";

    return `SELECT ${agg} as value${dimExpr}
FROM uniscrm.user
WHERE tenant_id = ${tenantId} ${filterClauses}${dimGroup}`;
  }

  if (type === "funnel") {
    const { steps, window_value, window_unit, time_range_start, time_range_end, filters } = params as {
      steps: string[]; window_value?: number; window_unit?: string;
      time_range_start?: string; time_range_end?: string;
      filters?: { field: string; operator: string; value: string; value2?: string }[];
    };

    if (!steps || steps.length < 2) return "SELECT 'error' as step, 0 as count";

    const winVal = window_value || 7;
    const winUnit = window_unit === "hour" ? "HOUR" : "DAY";

    const filterClauses = (filters || []).filter(f => f.field && f.operator).map(f => {
      if (f.operator === "has value") return `AND ${f.field} IS NOT NULL`;
      if (f.operator === "no value") return `AND ${f.field} IS NULL`;
      if (f.operator === "between") return `AND ${f.field} BETWEEN ${f.value} AND ${f.value2 || f.value}`;
      const op = f.operator === "≠" ? "!=" : f.operator;
      const val = isNaN(Number(f.value)) ? `'${f.value}'` : f.value;
      return `AND ${f.field} ${op} ${val}`;
    }).join(" ");

    const timeFilter = [
      time_range_start ? `AND event_time >= '${time_range_start}'` : "",
      time_range_end ? `AND event_time <= '${time_range_end}'` : "",
    ].join(" ");

    const ctes: string[] = [];
    ctes.push(`step1 AS (
  SELECT user_id, MIN(event_time) as t1
  FROM uniscrm.event
  WHERE tenant_id = ${tenantId} AND event_type = '${steps[0]}' ${timeFilter} ${filterClauses}
  GROUP BY user_id
)`);

    for (let i = 1; i < steps.length; i++) {
      const prevStep = `step${i}`;
      const curStep = `step${i + 1}`;
      ctes.push(`${curStep} AS (
  SELECT ${prevStep}.user_id
  FROM ${prevStep}
  JOIN uniscrm.event e ON e.user_id = ${prevStep}.user_id
    AND e.tenant_id = ${tenantId} AND e.event_type = '${steps[i]}'
    AND e.event_time > ${i === 1 ? `${prevStep}.t1` : `(SELECT MIN(ev.event_time) FROM uniscrm.event ev WHERE ev.user_id = ${prevStep}.user_id AND ev.tenant_id = ${tenantId} AND ev.event_type = '${steps[i - 1]}')`}
    AND e.event_time <= DATE_ADD(step1.t1, INTERVAL ${winVal} ${winUnit})
  ${i > 1 ? `JOIN step1 ON step1.user_id = ${prevStep}.user_id` : ""}
  GROUP BY ${prevStep}.user_id
)`);
    }

    const selects = steps.map((_, i) => `SELECT 'step${i + 1}' as step, COUNT(*) as count FROM step${i + 1}`);

    return `WITH ${ctes.join(",\n")}\n${selects.join("\nUNION ALL ")}`;
  }

  return "SELECT 1";
}

function processFunnelResults(rows: unknown[], steps: string[]): { steps: { step: string; eventType: string; count: number; conversionRate: number; totalRate: number }[] } {
  const stepData = (rows as { step: string; count: number }[]).map((r, i) => ({
    step: r.step,
    eventType: steps[i] || "",
    count: Number(r.count) || 0,
    conversionRate: 0,
    totalRate: 0,
  }));
  const first = stepData[0]?.count || 0;
  for (let i = 0; i < stepData.length; i++) {
    stepData[i].totalRate = first > 0 ? Math.round(stepData[i].count / first * 1000) / 10 : 0;
    stepData[i].conversionRate = i === 0 ? 100 : (stepData[i - 1].count > 0 ? Math.round(stepData[i].count / stepData[i - 1].count * 1000) / 10 : 0);
  }
  return { steps: stepData };
}

function processIntervalResults(rows: unknown[]): IntervalResults {
  const intervals: number[] = [];
  const userIds = new Set<string>();

  for (const row of rows as { user_id: string; event_time: string; next_time: string }[]) {
    const start = new Date(row.event_time).getTime();
    const end = new Date(row.next_time).getTime();
    if (!isNaN(start) && !isNaN(end) && end > start) {
      intervals.push((end - start) / 1000);
      userIds.add(row.user_id);
    }
  }

  const stats = computeStats(intervals);
  const buckets = computeDistribution(intervals);

  return { stats, buckets, total_profiles: userIds.size, total_pairs: intervals.length };
}

// ============ Export ============

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleQueueMessage(msg.body, env);
        msg.ack();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        await env.ANALYTICS_DB.prepare(
          "UPDATE analytics_reports SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(errMsg, msg.body.report_id).run();
        msg.ack();
      }
    }
  },
};
