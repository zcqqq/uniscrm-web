import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import type { Env, IntervalResults, AnalyticsReport } from "./types";
import { computeStats } from "./services/stats";

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
    `SELECT id, name, type, params_json, status, results_json, error_message, computed_at, created_at, updated_at
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
  const body = await c.req.json<{ name?: string | null; type: string; params: Record<string, unknown> }>();

  if (!body.type || !body.params) {
    return c.json({ error: "type and params are required" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.ANALYTICS_DB.prepare(
    `INSERT INTO analytics_reports (id, tenant_id, member_id, name, type, params_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, tenantId, memberId, body.name || null, body.type, JSON.stringify(body.params), now, now).run();

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

// Params fields that must be excluded when deciding whether to re-queue
// computation:
// - "chart_type"/"name": purely display preferences, never affect the query.
// - "time_range_start": derived fresh from "time_range" (the relative
//   selector, e.g. "30" days) as `now - N days` every time params are built,
//   so it naturally drifts forward with real time even when the user
//   changes nothing. The relative "time_range" value itself is what
//   reflects real user intent and is NOT excluded.
const COSMETIC_PARAM_FIELDS = ["chart_type", "name", "time_range_start"] as const;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function queryParamsChanged(oldParams: Record<string, unknown>, newParams: Record<string, unknown>): boolean {
  const strip = (p: Record<string, unknown>) => {
    const copy = { ...p };
    for (const field of COSMETIC_PARAM_FIELDS) delete copy[field];
    return copy;
  };
  return stableStringify(strip(oldParams)) !== stableStringify(strip(newParams));
}

app.patch("/api/reports/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");
  const body = await c.req.json<{ name?: string | null; type?: string; params?: Record<string, unknown> }>();

  const existing = await c.env.ANALYTICS_DB.prepare(
    "SELECT type, params_json FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).first<{ type: string; params_json: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // Only re-queue computation if a *query-relevant* param actually changed —
  // editing the name or a cosmetic chart-type preference must not touch the
  // previously computed results.
  const resolvedType = body.type !== undefined ? body.type : existing.type;
  let paramsChanged = false;
  if (body.params !== undefined) {
    const oldParams = existing.params_json ? JSON.parse(existing.params_json) : {};
    paramsChanged = queryParamsChanged(oldParams, body.params);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name); }
  if (body.type !== undefined) { sets.push("type = ?"); values.push(body.type); }
  if (body.params !== undefined) { sets.push("params_json = ?"); values.push(JSON.stringify(body.params)); }
  if (paramsChanged) {
    sets.push("status = ?", "results_json = ?", "error_message = ?");
    values.push("pending", null, null);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());

  await c.env.ANALYTICS_DB.prepare(
    `UPDATE analytics_reports SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`
  ).bind(...values, reportId, tenantId).run();

  if (paramsChanged) {
    await c.env.ANALYTICS_QUEUE.send({
      report_id: reportId,
      type: resolvedType,
      params: body.params,
      tenant_id: tenantId,
      warehouse: c.env.R2_WAREHOUSE,
    });
  }

  return c.json({ ok: true, requeued: paramsChanged });
});

// Manual "Re-compute" — unlike PATCH, always re-queues regardless of whether
// params changed (e.g. to refresh a relative "Last N days" report whose
// underlying data has simply moved forward in time).
app.post("/api/reports/:id/recompute", async (c) => {
  const tenantId = c.get("tenantId");
  const reportId = c.req.param("id");

  const existing = await c.env.ANALYTICS_DB.prepare(
    "SELECT type, params_json FROM analytics_reports WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).first<{ type: string; params_json: string }>();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const params = existing.params_json ? JSON.parse(existing.params_json) : {};

  await c.env.ANALYTICS_DB.prepare(
    "UPDATE analytics_reports SET status = 'pending', results_json = NULL, error_message = NULL, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?"
  ).bind(reportId, tenantId).run();

  await c.env.ANALYTICS_QUEUE.send({
    report_id: reportId,
    type: existing.type,
    params,
    tenant_id: tenantId,
    warehouse: c.env.R2_WAREHOUSE,
  });

  return c.json({ ok: true });
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

  // A single `summary` number is computed once here and stored alongside
  // each report's results, so every consumer (Dashboard widgets, Analytics
  // Detail headline) reads the same pre-computed value instead of each
  // re-aggregating the raw data client-side.
  let resultsJson: string;
  if (type === "interval") {
    const granularity = ((params as any).granularity as string) || "day";
    const intervalResults = processIntervalResults(result.data, granularity);
    resultsJson = JSON.stringify({ sql, ...intervalResults, summary: intervalResults.total_pairs });
  } else if (type === "funnel") {
    const steps = ((params as any).steps || []) as string[];
    const funnelResults = processFunnelResults(result.data, steps);
    resultsJson = JSON.stringify({ sql, ...funnelResults, summary: funnelResults.steps[0]?.count || 0 });
  } else {
    const data = result.data as { value?: number }[];
    const summary = data.reduce((sum, d) => sum + (Number(d.value) || 0), 0);
    resultsJson = JSON.stringify({ sql, data: result.data, summary });
  }

  await env.ANALYTICS_DB.prepare(
    "UPDATE analytics_reports SET status = 'ready', results_json = ?, computed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).bind(resultsJson, report_id).run();
}

export function buildSQL(type: string, params: Record<string, unknown>, tenantId: string): string {
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
    return buildSnapshotSQL("uniscrm.user", params, tenantId);
  }

  if (type === "content") {
    return buildSnapshotSQL("uniscrm.content", params, tenantId);
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

export function buildSnapshotSQL(tableName: string, params: Record<string, unknown>, tenantId: string): string {
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
FROM ${tableName}
WHERE tenant_id = ${tenantId} ${filterClauses}${dimGroup}`;
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

function truncatePeriod(dateMs: number, granularity: string): string {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  if (granularity === "month") {
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  if (granularity === "week") {
    // Align to Monday (ISO week), matching DATE_TRUNC('week', ...) used for event analysis.
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    return new Date(Date.UTC(y, m, day - daysSinceMonday)).toISOString().slice(0, 10);
  }
  // day (default)
  return new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
}

function processIntervalResults(rows: unknown[], granularity: string): IntervalResults {
  const byPeriod = new Map<string, number[]>();
  let totalPairs = 0;
  const allUserIds = new Set<string>();

  for (const row of rows as { user_id: string; event_time: string; next_time: string }[]) {
    const start = new Date(row.event_time).getTime();
    const end = new Date(row.next_time).getTime();
    if (isNaN(start) || isNaN(end) || end <= start) continue;

    // Period is anchored on the first event's time (event_time), matching how
    // Event Analysis buckets by event occurrence time.
    const period = truncatePeriod(start, granularity);
    if (!byPeriod.has(period)) byPeriod.set(period, []);
    byPeriod.get(period)!.push((end - start) / 1000);

    totalPairs++;
    allUserIds.add(row.user_id);
  }

  const periods = Array.from(byPeriod.entries())
    .map(([period, intervals]) => ({ period, ...computeStats(intervals) }))
    .sort((a, b) => a.period.localeCompare(b.period));

  return { periods, total_profiles: allUserIds.size, total_pairs: totalPairs };
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

  // Daily refresh (see [triggers] in wrangler.toml) for every report pinned
  // to a dashboard — their "Last N days" style time ranges silently go stale
  // as real time passes, even with no user edits. Scoped to dashboard-pinned
  // reports only to keep load predictable; reports already mid-computation
  // are left alone so we don't clobber an in-flight manual edit/recompute.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const { results } = await env.ANALYTICS_DB.prepare(
      `SELECT DISTINCT ar.id, ar.tenant_id, ar.type, ar.params_json
       FROM analytics_reports ar
       JOIN dashboard_items di ON di.report_id = ar.id
       WHERE ar.status NOT IN ('pending', 'computing')`
    ).all<{ id: string; tenant_id: number; type: string; params_json: string }>();

    for (const row of results) {
      const params = row.params_json ? JSON.parse(row.params_json) : {};
      await env.ANALYTICS_DB.prepare(
        "UPDATE analytics_reports SET status = 'pending', updated_at = datetime('now') WHERE id = ?"
      ).bind(row.id).run();
      await env.ANALYTICS_QUEUE.send({
        report_id: row.id,
        type: row.type,
        params,
        tenant_id: String(row.tenant_id),
        warehouse: env.R2_WAREHOUSE,
      });
    }
  },
};
