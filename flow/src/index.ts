import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, FlowQueueMessage, FlowLogMessage } from "./types";
import { executeFlow, resumeFromNode, evaluateCondition, type FlowGraph, type ActionResult, type NodeLog } from "./engine";
import { EventMetadata_X } from "../../metadata/x";
import { TenantDataDB } from "../../shared/tenant-data-db";

async function emitNodeLogs(nodeLogs: NodeLog[], flowId: string, userId: string, tenantId: number, env: Env): Promise<void> {
  const timestamp = new Date().toISOString();
  if (nodeLogs.length > 0) {
    const records = nodeLogs.map((log) => ({
      tenant_id: tenantId,
      id: crypto.randomUUID(),
      flow_id: flowId,
      node_id: log.nodeId,
      user_id: userId,
      direction: log.direction,
      created_at: timestamp,
    }));
    await Promise.all([
      env.PIPELINE_FLOW_LOG?.send(records).catch(() => {}),
      env.FLOW_LOG_QUEUE?.send({
        flowId,
        userId,
        tenantId,
        timestamp,
        logs: nodeLogs,
      }).catch(() => {}),
    ]);
  }
}

function shouldCronFire(data: Record<string, unknown>, now: Date): boolean {
  const type = data.scheduleType as string;
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();

  if (type === "daily") {
    const [h, m] = (data.dailyTime as string || "09:00").split(":").map(Number);
    return hour === h && minute === m;
  }
  if (type === "interval") {
    const val = Number(data.intervalValue || 60);
    const unit = data.intervalUnit as string || "minutes";
    if (unit === "minutes") return minute % val === 0;
    if (unit === "hours") return minute === 0 && hour % val === 0;
    return minute === 0 && hour === 0;
  }
  if (type === "cron") {
    const expr = data.cronExpr as string || "0 * * * *";
    const [cm, ch] = expr.split(" ");
    const matchMin = cm === "*" || cm.includes("/") ? (minute % parseInt(cm.replace("*/", ""))) === 0 : parseInt(cm) === minute;
    const matchHour = ch === "*" || ch.includes("/") ? (hour % parseInt(ch.replace("*/", ""))) === 0 : parseInt(ch) === hour;
    return matchMin && matchHour;
  }
  return false;
}

interface ActionExecResult {
  stmts: D1PreparedStatement[];
  rateLimited: { action: ActionResult; retryAt: string }[];
}

async function executeActions(actions: ActionResult[], userId: string, tenantId: string, env: Env, payload?: Record<string, unknown>, flowId?: string): Promise<ActionExecResult> {
  const stmts: D1PreparedStatement[] = [];
  const rateLimited: { action: ActionResult; retryAt: string }[] = [];

  for (const action of actions) {
    if (action.type === "addToList" && action.listId) {
      const linkUrl = env.LINK_URL;
      await fetch(`${linkUrl}/internal/lists/${action.listId}/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_SECRET,
          "X-Tenant-Id": tenantId,
        },
        body: JSON.stringify({ userId }),
      });
    } else if (action.type === "xAction" && action.xEvent && action.channelId) {
      // Check userPropsFilter before executing action
      const meta = EventMetadata_X.find(m => m.eventType === action.xEvent);
      if (meta?.userPropsFilter?.length) {
        const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
          .bind(Number(tenantId)).first<{ d1_database_id: string }>();
        if (tenantRow?.d1_database_id) {
          const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
          const fields = meta.userPropsFilter.map(f => f.propId).join(", ");
          const rows = await tdb.query<Record<string, unknown>>(`SELECT ${fields} FROM user WHERE id = ?`, [userId]);
          const row = rows[0];
          const pass = meta.userPropsFilter.every(f => row?.[f.propId] === f.value);
          if (!pass) {
            console.log(JSON.stringify({ event: "flow_action_skipped_filter", xEvent: action.xEvent, userId, filter: meta.userPropsFilter, actual: row }));
            continue;
          }
        }
      }

      const rateLimitKey = `x:${action.xEvent}:${action.channelId}`;

      // Check stored rate limit
      const rl = await env.FLOW_DB.prepare(`SELECT remaining, reset_at FROM rate_limits WHERE key = ?`)
        .bind(rateLimitKey).first<{ remaining: number; reset_at: string }>();
      if (rl && rl.remaining <= 0 && rl.reset_at && new Date(rl.reset_at) > new Date()) {
        rateLimited.push({ action: { ...action, userId }, retryAt: rl.reset_at });
        continue;
      }

      const linkUrl = env.LINK_URL;
      const xEvent = action.xEvent as string;
      const xAction = xEvent === "follow-user" ? "follow"
        : xEvent === "unfollow-user" ? "unfollow"
        : xEvent;
      const actionBody: Record<string, unknown> = { channelId: action.channelId, targetUserId: userId, action: xAction, flowId: flowId || null };
      if (xAction === "create-dm" && action.messageText) {
        actionBody.messageText = String(action.messageText).replace(/\$(user|event)\.(\w+)/g, (_, _prefix, field) => {
          const val = payload?.[field];
          return val != null ? String(val) : "";
        });
      }
      const res = await fetch(`${linkUrl}/internal/x/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify(actionBody),
      });

      const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitRemaining?: number; rateLimitReset?: string; insufficientCredit?: boolean };

      // Credit exhausted: link declined to call the X API at all (non-BYOK channel, balance <= 0)
      if (body.insufficientCredit) {
        console.log(JSON.stringify({ event: "xaction_insufficient_credit", tenantId, xEvent: action.xEvent, channelId: action.channelId }));
        continue;
      }

      // Update rate limit tracking
      if (body.rateLimitReset) {
        await env.FLOW_DB.prepare(
          `INSERT INTO rate_limits (key, remaining, reset_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET remaining = excluded.remaining, reset_at = excluded.reset_at`
        ).bind(rateLimitKey, body.rateLimitRemaining ?? 0, body.rateLimitReset).run();
      }

      if (body.rateLimited) {
        rateLimited.push({ action: { ...action, userId }, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
      }
    } else if (action.type === "webhook" && action.url) {
      const method = (action.method as string) || "POST";
      const headers: Record<string, string> = { "Content-Type": "application/json", ...(action.headers as Record<string, string> || {}) };
      const bodyStr = action.body ? String(action.body).replace(/\$(user|event)\.(\w+)/g, (_, _p, field) => String(payload?.[field] ?? "")) : JSON.stringify({ userId, ...payload });
      try {
        const res = await fetch(action.url as string, { method, headers, body: method !== "GET" ? bodyStr : undefined });
        (action as any).success = res.ok;
      } catch {
        (action as any).success = false;
      }
    } else if (action.type === "changeUserProps" && action.updates) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        const updates = action.updates as { field: string; value: string }[];
        for (const u of updates) {
          const val = u.value.replace(/\$(user|event)\.(\w+)/g, (_, _p, field) => String(payload?.[field] ?? ""));
          await tdb.run(`UPDATE user SET ${u.field} = ? WHERE id = ?`, [val, userId]);
        }
      }
    }
  }

  return { stmts, rateLimited };
}

interface ContentActionExecResult {
  rateLimited: { action: ActionResult; retryAt: string }[];
}

async function executeContentActions(
  graph: FlowGraph,
  actions: ActionResult[],
  contentId: string,
  channelId: string,
  tenantId: string,
  env: Env,
  payload: Record<string, unknown> = {},
  flowId?: string
): Promise<ContentActionExecResult> {
  const rateLimited: { action: ActionResult; retryAt: string }[] = [];

  for (const action of actions) {
    if (action.type === "repost") {
      const res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ channelId, contentId, flowId: flowId || null }),
      });
      console.log(JSON.stringify({ event: "content_action_repost", contentId, channelId, status: res.status }));
    } else if (action.type === "aiRewritePublish") {
      const targetChannelId = action.targetChannelId as string;
      const skillId = action.skillId as string;
      const res = await fetch(`${env.LINK_URL}/internal/content/ai-rewrite-publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify({ contentId, sourceChannelId: channelId, targetChannelId, skillId, flowId: flowId || null }),
      });
      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: "content_action_ai_rewrite_publish", contentId, targetChannelId, skillId, status: res.status, ok: body.ok }));

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = body.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
        rateLimited.push(...nested.rateLimited);
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
      }
      for (const wait of resumed.pendingWaits) {
        const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), flowId || "", wait.nodeId, contentId, Number(tenantId),
          JSON.stringify({ ...payload, channel_id: channelId }), executeAt, new Date().toISOString(),
          wait.awaitingEvent || "", wait.conditions ? JSON.stringify(wait.conditions) : ""
        ).run();
      }
    } else if (action.type === "updateContentStatus" && action.status) {
      const tenantRow = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(Number(tenantId)).first<{ d1_database_id: string }>();
      if (tenantRow?.d1_database_id) {
        const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
        await tdb.run(`UPDATE content SET status = ? WHERE id = ?`, [action.status as string, contentId]);
      }
    }
  }

  return { rateLimited };
}

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Auth middleware
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
  await next();
};

app.use("/api/flows", authMiddleware);
app.use("/api/flows/*", authMiddleware);
app.use("/api/channels", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

// Internal: mock trigger event for testing
app.post("/internal/trigger", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) return c.json({ error: "Unauthorized" }, 401);
  const { tenantId, eventType, userId, channelId, payload } = await c.req.json<any>();
  const now = new Date().toISOString();
  const flows = await c.env.FLOW_DB.prepare("SELECT id, graph_json FROM flows WHERE tenant_id = ? AND status = 'published'")
    .bind(tenantId).all<{ id: string; graph_json: string }>();
  const results: any[] = [];
  for (const flow of flows.results) {
    const graph: FlowGraph = JSON.parse(flow.graph_json);
    const result = executeFlow(graph, eventType, payload || {});
    if (result.matched) {
      const { stmts } = await executeActions(result.actions, userId || "", String(tenantId), c.env, payload, flow.id);
      await c.env.FLOW_DB.batch([
        c.env.FLOW_DB.prepare("INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at) VALUES (?, ?, ?, ?, 1, ?)")
          .bind(crypto.randomUUID(), flow.id, userId || "", tenantId, now),
        ...stmts,
      ]);
      results.push({ flowId: flow.id, actions: result.actions.length, matched: true });
    }
  }
  return c.json({ triggered: results.length, results });
});

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

// Proxy lists from profile worker
app.use("/api/lists", authMiddleware);
app.get("/api/lists", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const res = await fetch(`${linkUrl}/api/lists`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Proxy channels from link worker
app.get("/api/channels", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const type = c.req.query("type") || "";
  const res = await fetch(`${linkUrl}/api/channels?type=${type}`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// List flows
app.get("/api/flows", async (c) => {
  const tenantId = c.get("tenantId");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "10", 10)));
  const offset = (page - 1) * limit;
  const domain = c.req.query("domain") === "content" ? "content" : "user";
  const domainClause = domain === "content" ? "AND f.graph_json LIKE '%contentTrigger%'" : "AND f.graph_json NOT LIKE '%contentTrigger%'";

  const countRow = await c.env.FLOW_DB.prepare(
    `SELECT COUNT(*) as total FROM flows f WHERE f.tenant_id = ? ${domainClause}`
  )
    .bind(tenantId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT f.id, f.name, f.description, f.status, f.member_id, f.created_at, f.updated_at,
       (SELECT COUNT(*) FROM flow_executions WHERE flow_id = f.id) + (SELECT COUNT(*) FROM content_flow_executions WHERE flow_id = f.id) as trigger_count
     FROM flows f WHERE f.tenant_id = ? ${domainClause} ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, limit, offset)
    .all<{ id: string; name: string; description: string; status: string; member_id: string; created_at: string; updated_at: string; trigger_count: number }>();

  const memberIds = [...new Set(rows.results.map(r => r.member_id).filter(Boolean))];
  let memberMap: Record<string, string> = {};
  if (memberIds.length > 0) {
    const members = await c.env.WEB_DB.prepare(
      `SELECT id, email FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`
    ).bind(...memberIds).all<{ id: string; email: string }>();
    memberMap = Object.fromEntries(members.results.map(m => [m.id, m.email]));
  }

  const flows = rows.results.map(f => ({
    ...f,
    member_email: memberMap[f.member_id] || "",
  }));

  return c.json({ flows, total, page, totalPages: Math.ceil(total / limit) });
});

// Create flow
app.post("/api/flows", async (c) => {
  const tenantId = c.get("tenantId");
  const memberId = c.get("memberId");
  const body = await c.req.json<{ name?: string; description?: string; graph_json?: string }>().catch(() => ({ name: undefined, description: undefined, graph_json: undefined }));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = body.name || "Untitled Flow";
  const description = body.description || "";
  const graphJson = body.graph_json || '{"nodes":[],"edges":[]}';

  await c.env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, member_id, name, description, graph_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(id, tenantId, memberId, name, description, graphJson, now, now)
    .run();

  return c.json({ flow: { id, name, description } }, 201);
});

// Get flow
app.get("/api/flows/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const flow = await c.env.FLOW_DB.prepare(
    `SELECT * FROM flows WHERE id = ? AND tenant_id = ?`
  )
    .bind(flowId, tenantId)
    .first();

  if (!flow) return c.json({ error: "Not found" }, 404);
  return c.json({ flow });
});

// Update flow
app.put("/api/flows/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    graph_json?: string;
    status?: string;
  }>();

  const existing = await c.env.FLOW_DB.prepare(
    `SELECT id FROM flows WHERE id = ? AND tenant_id = ?`
  )
    .bind(flowId, tenantId)
    .first();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const sets: string[] = [];
  const params: any[] = [];

  if (body.name !== undefined) { sets.push("name = ?"); params.push(body.name); }
  if (body.description !== undefined) { sets.push("description = ?"); params.push(body.description); }
  if (body.graph_json !== undefined) { sets.push("graph_json = ?"); params.push(body.graph_json); }
  if (body.status !== undefined) { sets.push("status = ?"); params.push(body.status); }

  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(flowId);
  params.push(tenantId);

  await c.env.FLOW_DB.prepare(
    `UPDATE flows SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`
  )
    .bind(...params)
    .run();

  return c.json({ ok: true });
});

// Delete flow
app.delete("/api/flows/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const result = await c.env.FLOW_DB.prepare(
    `DELETE FROM flows WHERE id = ? AND tenant_id = ?`
  )
    .bind(flowId, tenantId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);

  await c.env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = ?`).bind(flowId).run();

  return c.json({ ok: true });
});

// Publish flow
app.post("/api/flows/:id/publish", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const result = await c.env.FLOW_DB.prepare(
    `UPDATE flows SET status = 'published', updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(new Date().toISOString(), flowId, tenantId).run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Unpublish (back to draft)
app.post("/api/flows/:id/unpublish", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  await c.env.FLOW_DB.prepare(
    `UPDATE flows SET status = 'draft', updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(new Date().toISOString(), flowId, tenantId).run();

  await c.env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = ?`).bind(flowId).run();
  return c.json({ ok: true });
});

// Analytics: node counts (from tenant D1 flow_log)
app.get("/api/flows/:id/analytics", async (c) => {
  const flowId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const row = await c.env.WEB_DB.prepare(
    "SELECT d1_database_id FROM tenants WHERE tenant_id = ?"
  ).bind(Number(tenantId)).first<{ d1_database_id: string | null }>();
  if (!row?.d1_database_id) return c.json({ nodes: {} });

  const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id);

  try {
    const rows = await tdb.query<{ node_id: string; direction: string; count: number }>(
      "SELECT node_id, direction, COUNT(*) as count FROM flow_log WHERE flow_id = ? GROUP BY node_id, direction",
      [flowId]
    );
    const nodes: Record<string, { enter: number; exit: number }> = {};
    for (const r of rows) {
      if (!nodes[r.node_id]) nodes[r.node_id] = { enter: 0, exit: 0 };
      if (r.direction === "enter") nodes[r.node_id].enter = r.count;
      if (r.direction === "exit") nodes[r.node_id].exit = r.count;
    }
    return c.json({ nodes });
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_analytics_query_error", error: String(e) }));
    return c.json({ nodes: {} });
  }
});

// Node logs: list users who entered a specific node
app.get("/api/flows/:id/nodes/:nodeId/logs", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");
  const nodeId = c.req.param("nodeId");

  try {
    const row = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId).first<{ d1_database_id: string | null }>();
    if (!row?.d1_database_id) return c.json({ logs: [] });

    const tdb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, row.d1_database_id);
    const logs = await tdb.query<{ user_id: string; name: string | null; created_at: string }>(
      `SELECT l.user_id, u.name, l.created_at
       FROM flow_log l LEFT JOIN user u ON u.id = l.user_id
       WHERE l.flow_id = ? AND l.node_id = ? AND l.direction = 'enter'
       GROUP BY l.user_id, l.created_at
       ORDER BY l.created_at DESC LIMIT 50`,
      [flowId, nodeId]
    );

    return c.json({ logs });
  } catch (e) {
    console.error(JSON.stringify({ event: "node_logs_error", tenantId, flowId, nodeId, error: String(e) }));
    return c.json({ logs: [] });
  }
});

const FLOW_GENERATE_SYSTEM_PROMPT = `You are a workflow graph generator for a social CRM.

Available node types:
1. xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: "follow.followed" (someone follows you), "follow.follow" (you follow someone), "follow.unfollowed" (someone unfollows you), "follow.unfollow" (you unfollow someone), "dm.received", "post.create", "like.create"

2. wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }

3. waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }

4. action - perform an action
   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: "follow-user", "unfollow-user", "create-dm", "mute-user"
   For list actions: data: { actionType: "addToList", listId: "", listName: "" }

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- Flow must start with exactly one xTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;

app.post("/api/flows/generate", async (c) => {
  const { prompt, currentContext, currentGraph } = await c.req.json<{ prompt: string; currentContext?: any; currentGraph?: any }>();
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const ctx = currentContext || currentGraph;
  const hasContext = ctx && (Array.isArray(ctx.nodes) ? ctx.nodes.length > 0 : Object.keys(ctx).length > 0);
  const userMessage = hasContext
    ? `Current flow: ${JSON.stringify(ctx)}\n\nUser request: ${prompt}`
    : `Create a new flow: ${prompt}`;

  try {
    const stream = await c.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
      messages: [
        { role: "system", content: FLOW_GENERATE_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2048,
      stream: true,
    });

    return new Response(stream as ReadableStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_generate_error", error: String(e) }));
    return c.json({ error: "Generation failed" }, 500);
  }
});

const FLOW_NODE_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS flow_log (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
const FLOW_NODE_LOG_INDEX = `CREATE INDEX IF NOT EXISTS idx_fnl_flow_node ON flow_log(flow_id, node_id)`;

async function deterministicId(parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("|"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function handleLogQueue(batch: MessageBatch<any>, env: Env): Promise<void> {
  const logsByTenant = new Map<number, { flowId: string; nodeId: string; userId: string; direction: string; timestamp: string }[]>();

  for (const message of batch.messages) {
    const { tenantId, flowId, userId, timestamp, logs } = message.body as {
      tenantId: number; flowId: string; userId: string; timestamp?: string; logs: { nodeId: string; direction: string }[];
    };
    const ts = timestamp || new Date().toISOString();
    if (!logsByTenant.has(tenantId)) logsByTenant.set(tenantId, []);
    for (const log of logs) {
      logsByTenant.get(tenantId)!.push({ flowId, nodeId: log.nodeId, userId, direction: log.direction, timestamp: ts });
    }
  }

  for (const [tenantId, logs] of logsByTenant) {
    try {
      const row = await env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
        .bind(tenantId).first<{ d1_database_id: string | null }>();
      if (!row?.d1_database_id) continue;

      const tdb = new TenantDataDB(env.CF_ACCOUNT_ID, env.CF_D1_API_TOKEN, row.d1_database_id);

      await tdb.run(FLOW_NODE_LOG_SCHEMA);
      await tdb.run(FLOW_NODE_LOG_INDEX);

      for (const log of logs) {
        const id = await deterministicId([log.flowId, log.nodeId, log.userId, log.direction, log.timestamp]);
        await tdb.run(
          `INSERT OR IGNORE INTO flow_log (id, flow_id, node_id, user_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, log.flowId, log.nodeId, log.userId, log.direction, log.timestamp]
        );
      }
      console.log(JSON.stringify({ event: "flow_log_written", tenantId, count: logs.length }));
    } catch (e) {
      console.error(JSON.stringify({ event: "flow_log_error", tenantId, error: String(e) }));
    }
  }

  for (const message of batch.messages) {
    message.ack();
  }
}

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

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    // Route by queue name
    if (batch.queue === "uniscrm-flow-log-dev" || batch.queue === "uniscrm-flow-log") {
      await handleLogQueue(batch, env);
      return;
    }

    for (const message of batch.messages) {
      try {
        const { tenantId, eventType, userId, contentId, channelId, payload } = message.body as FlowQueueMessage;

        const rows = await env.FLOW_DB.prepare(
          `SELECT id, graph_json FROM flows WHERE tenant_id = ? AND status = 'published'`
        )
          .bind(tenantId)
          .all<{ id: string; graph_json: string }>();

        if (contentId) {
          for (const flow of rows.results) {
            const graph: FlowGraph = JSON.parse(flow.graph_json);
            const result = executeFlow(graph, eventType, payload);
            // Content-domain execution intentionally skips emitNodeLogs/PIPELINE_FLOW_LOG —
            // that sink's schema is fixed and keyed on user_id; adding a content_id variant
            // is a Pipeline-schema migration out of scope here. content_flow_executions is
            // this domain's only execution history for now.
            if (result.actions.length > 0) {
              const { rateLimited } = await executeContentActions(graph, result.actions, contentId, channelId, tenantId, env, payload, flow.id);
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, new Date().toISOString()).run();
              for (const rl of rateLimited) {
                await env.FLOW_DB.prepare(
                  `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                   VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
                ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, JSON.stringify(payload), rl.retryAt, new Date().toISOString(), JSON.stringify(rl.action)).run();
              }
              console.log(JSON.stringify({ event: "content_flow_matched", flowId: flow.id, contentId, eventType, actions: result.actions, rateLimited: rateLimited.length }));
            }

            for (const wait of result.pendingWaits) {
              const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
              // Stash channelId inside the stored payload (under channel_id) — content_flow_pending
              // has no channel_id column of its own, and the resume path in scheduled() (Task 6)
              // needs the source channel to execute repost/aiRewritePublish once the wait elapses.
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                crypto.randomUUID(), flow.id, wait.nodeId, contentId, tenantId,
                JSON.stringify({ ...payload, channel_id: channelId }), executeAt, new Date().toISOString(), wait.awaitingEvent || "",
                wait.conditions ? JSON.stringify(wait.conditions) : ""
              ).run();
              console.log(JSON.stringify({ event: "content_flow_wait_scheduled", flowId: flow.id, nodeId: wait.nodeId, executeAt }));
            }
          }
          message.ack();
          continue;
        }

        // contentId and userId are mutually exclusive per FlowQueueMessage's contract, but
        // that's a domain invariant, not something TypeScript can infer from the `if (contentId)`
        // check above (they're separate optional properties). Guard explicitly so the rest of
        // this user-domain block gets real `userId: string` narrowing instead of an `as string`
        // stopgap cast. This can't fire for any message producible today (every non-content
        // message carries userId); if it ever did, the outer catch below retries the message,
        // same as the D1_TYPE_ERROR an undefined userId would otherwise throw further down.
        if (!userId) throw new Error("flow queue message has neither contentId nor userId");

        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, payload);
          if (result.nodeLogs.length > 0) await emitNodeLogs(result.nodeLogs, flow.id, userId, Number(tenantId), env);

          if (result.actions.length > 0) {
            const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, userId, tenantId, env, payload, flow.id);
            const stmts: D1PreparedStatement[] = [
              env.FLOW_DB.prepare(
                `INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flow.id, userId, tenantId, new Date().toISOString()),
              ...actionStmts,
            ];

            for (const r of rl) {
              stmts.push(env.FLOW_DB.prepare(
                `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                 VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
              ).bind(crypto.randomUUID(), flow.id, userId, tenantId, JSON.stringify(payload), r.retryAt, new Date().toISOString(), JSON.stringify(r.action)));
            }

            await env.FLOW_DB.batch(stmts);
            console.log(JSON.stringify({ event: "flow_matched", flowId: flow.id, userId, eventType, actions: result.actions, rateLimited: rl.length }));
          }

          for (const wait of result.pendingWaits) {
            const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
            await env.FLOW_DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(), flow.id, wait.nodeId, userId, tenantId,
              JSON.stringify(payload), executeAt, new Date().toISOString(), wait.awaitingEvent || "",
              wait.conditions ? JSON.stringify(wait.conditions) : ""
            ).run();
            console.log(JSON.stringify({ event: "flow_wait_scheduled", flowId: flow.id, nodeId: wait.nodeId, executeAt, awaitingEvent: wait.awaitingEvent || "" }));
          }
        }

        // Resolve any pending Wait-for-Event waits that match this event
        const pendingMatches = await env.FLOW_DB.prepare(
          `SELECT id, flow_id, node_id, user_id, tenant_id, payload, conditions FROM flow_pending
           WHERE user_id = ? AND awaiting_event = ? AND execute_at > ?`
        )
          .bind(userId, eventType, new Date().toISOString())
          .all<{ id: string; flow_id: string; node_id: string; user_id: string; tenant_id: string; payload: string; conditions: string }>();

        for (const pending of pendingMatches.results) {
          // Check conditions against the incoming event payload
          if (pending.conditions) {
            const conditions = JSON.parse(pending.conditions) as { field: string; operator: string; value: string }[];
            const allPass = conditions.every((c) => evaluateCondition(c.field, c.operator, c.value, payload));
            if (!allPass) continue; // Keep waiting — event doesn't match conditions
          }

          // Atomically claim this pending row before doing any async work. A duplicate/redelivered
          // event (e.g. X webhook at-least-once delivery) or an overlapping queue invocation could
          // otherwise match the same row twice, resolving the wait more than once and inflating
          // "exit" counts beyond "enter" counts in analytics.
          const claim = await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(pending.id).run();
          if (!claim.meta.changes) continue; // Already claimed/resolved by another invocation

          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(pending.flow_id).first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            continue;
          }

          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const pendingPayload = JSON.parse(pending.payload);
          const result = resumeFromNode(graph, pending.node_id, pendingPayload, "yes");
          if (result.nodeLogs.length > 0) await emitNodeLogs(result.nodeLogs, pending.flow_id, pending.user_id, Number(pending.tenant_id), env);

          const stmts: D1PreparedStatement[] = [];
          if (result.actions.length > 0) {
            const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, pending.user_id, pending.tenant_id, env, undefined, pending.flow_id);
            stmts.push(
              env.FLOW_DB.prepare(
                `INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at) VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), pending.flow_id, pending.user_id, pending.tenant_id, new Date().toISOString()),
              ...actionStmts
            );
            for (const r of rl) {
              stmts.push(env.FLOW_DB.prepare(
                `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                 VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
              ).bind(crypto.randomUUID(), pending.flow_id, pending.user_id, pending.tenant_id, pending.payload, r.retryAt, new Date().toISOString(), JSON.stringify(r.action)));
            }
          }
          if (stmts.length > 0) await env.FLOW_DB.batch(stmts);
          console.log(JSON.stringify({ event: "flow_pending_resolved_yes", flowId: pending.flow_id, userId: pending.user_id, eventType }));
        }

        message.ack();
      } catch (e) {
        console.error(JSON.stringify({ event: "flow_queue_error", error: String(e), body: message.body }));
        message.retry();
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const now = new Date().toISOString();

    // Cron trigger: check published flows with cronTrigger nodes
    const cronFlows = await env.FLOW_DB.prepare(
      `SELECT id, graph_json, tenant_id FROM flows WHERE status = 'published' AND graph_json LIKE '%cronTrigger%'`
    ).all<{ id: string; graph_json: string; tenant_id: string }>();

    for (const flow of cronFlows.results) {
      try {
        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const cronNodes = graph.nodes.filter(n => n.type === "cronTrigger");
        for (const node of cronNodes) {
          if (shouldCronFire(node.data, new Date())) {
            const result = executeFlow(graph, "cron.trigger", {});
            if (result.matched && result.actions.length > 0) {
              const { stmts } = await executeActions(result.actions, "", flow.tenant_id, env, {}, flow.id);
              await env.FLOW_DB.batch([
                env.FLOW_DB.prepare("INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at) VALUES (?, ?, '', ?, 1, ?)")
                  .bind(crypto.randomUUID(), flow.id, flow.tenant_id, now),
                ...stmts,
              ]);
              console.log(JSON.stringify({ event: "cron_trigger_fired", flowId: flow.id, actions: result.actions.length }));
            }
          }
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "cron_trigger_error", flowId: flow.id, error: String(e) }));
      }
    }

    // content_flow_pending sweep: resumes wait/timeCondition/abSplit nodes downstream of a
    // contentTrigger, mirroring the flow_pending sweep below but for the content domain (Task 5's
    // executeContentActions + content_flow_executions, keyed by content_id instead of user_id).
    // Placed before the flow_pending sweep (rather than strictly after it, per the plan) so that
    // the flow_pending sweep's own early return on an empty flow_pending table can't skip this
    // block — the two sweeps are independent (different tables), so order between them doesn't
    // matter functionally.
    const contentPending = await env.FLOW_DB.prepare(
      `SELECT id, flow_id, node_id, content_id, tenant_id, payload, awaiting_event FROM content_flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; content_id: string; tenant_id: string; payload: string; awaiting_event: string }>();

    for (const row of contentPending.results) {
      try {
        const claim = await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
        if (!claim.meta.changes) continue;

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();
        if (!flow || flow.status !== "published") continue;

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);
        const branch = row.awaiting_event ? "no" : undefined;
        const result = resumeFromNode(graph, row.node_id, payload, branch);

        if (result.actions.length > 0) {
          const channelId = String(payload.channel_id ?? "");
          const { rateLimited } = await executeContentActions(graph, result.actions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, now).run();
          for (const rl of rateLimited) {
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
            ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
          }
        }

        for (const wait of result.pendingWaits) {
          const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.content_id, row.tenant_id, row.payload, executeAt, now, wait.awaitingEvent || "").run();
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "content_flow_pending_error", id: row.id, error: String(e) }));
      }
    }

    const pending = await env.FLOW_DB.prepare(
      `SELECT id, flow_id, node_id, user_id, tenant_id, payload, awaiting_event, retry_action, retry_count FROM flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; user_id: string; tenant_id: string; payload: string; awaiting_event: string; retry_action: string; retry_count: number }>();

    if (pending.results.length === 0) return;

    for (const row of pending.results) {
      try {
        // Handle retry actions (rate-limited actions being retried)
        if (row.retry_action) {
          const action = JSON.parse(row.retry_action) as ActionResult & { userId?: string };
          const retryUserId = (action.userId as string) || row.user_id;
          const { stmts: actionStmts, rateLimited: rl } = await executeActions([action], retryUserId, row.tenant_id, env, undefined, row.flow_id);

          if (rl.length > 0 && row.retry_count < 5) {
            await env.FLOW_DB.prepare(
              `UPDATE flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
            ).bind(rl[0].retryAt, row.retry_count + 1, row.id).run();
            console.log(JSON.stringify({ event: "flow_retry_rescheduled", id: row.id, retryCount: row.retry_count + 1, retryAt: rl[0].retryAt }));
          } else {
            const stmts: D1PreparedStatement[] = [env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id), ...actionStmts];
            await env.FLOW_DB.batch(stmts);
            if (rl.length > 0) {
              console.log(JSON.stringify({ event: "flow_retry_exhausted", id: row.id, retryCount: row.retry_count }));
            }
          }
          continue;
        }

        // Atomically claim this pending row before doing any async work, to avoid double-resolving
        // it if a previous scheduled invocation is still running (long-running fetches can overrun
        // the 1-minute cron interval), which would otherwise emit duplicate "exit" node logs.
        const claim = await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id).run();
        if (!claim.meta.changes) continue;

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();

        if (!flow || flow.status !== "published") {
          continue;
        }

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);

        const branch = row.awaiting_event ? "no" : undefined;
        const result = resumeFromNode(graph, row.node_id, payload, branch);
        if (result.nodeLogs.length > 0) await emitNodeLogs(result.nodeLogs, row.flow_id, row.user_id, Number(row.tenant_id), env);

        const stmts: D1PreparedStatement[] = [];

        if (result.actions.length > 0) {
          const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, row.user_id, row.tenant_id, env, undefined, row.flow_id);
          stmts.push(
            env.FLOW_DB.prepare(
              `INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at)
               VALUES (?, ?, ?, ?, 1, ?)`
            ).bind(crypto.randomUUID(), row.flow_id, row.user_id, row.tenant_id, now),
            ...actionStmts
          );
          for (const r of rl) {
            stmts.push(env.FLOW_DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
            ).bind(crypto.randomUUID(), row.flow_id, row.user_id, row.tenant_id, row.payload, r.retryAt, now, JSON.stringify(r.action)));
          }
        }

        for (const wait of result.pendingWaits) {
          const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
          stmts.push(
            env.FLOW_DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.user_id, row.tenant_id, row.payload, executeAt, now, wait.awaitingEvent || "")
          );
        }

        if (stmts.length > 0) await env.FLOW_DB.batch(stmts);
        console.log(JSON.stringify({ event: "flow_pending_executed", flowId: row.flow_id, userId: row.user_id, branch: branch || "continue", actions: result.actions }));
      } catch (e) {
        console.error(JSON.stringify({ event: "flow_pending_error", id: row.id, error: String(e) }));
      }
    }
  },
};
