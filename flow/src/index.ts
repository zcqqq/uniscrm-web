import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, FlowQueueMessage, FlowLogMessage } from "./types";
import { executeFlow, resumeFromNode, evaluateCondition, type FlowGraph, type ActionResult, type NodeLog } from "./engine";
import { EventMetadata_X } from "../../metadata/x";
import { TenantDataDB } from "../../shared/tenant-data-db";

function emitNodeLogs(nodeLogs: NodeLog[], flowId: string, userId: string, tenantId: number, env: Env) {
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
    env.PIPELINE_FLOW_NODE_LOG.send(records).catch(() => {});

    env.FLOW_LOG_QUEUE.send({
      flowId,
      userId,
      tenantId,
      timestamp,
      logs: nodeLogs,
    });
  }
}

interface ActionExecResult {
  stmts: D1PreparedStatement[];
  rateLimited: { action: ActionResult; retryAt: string }[];
}

async function executeActions(actions: ActionResult[], userId: string, tenantId: string, env: Env, payload?: Record<string, unknown>): Promise<ActionExecResult> {
  const stmts: D1PreparedStatement[] = [];
  const rateLimited: { action: ActionResult; retryAt: string }[] = [];

  for (const action of actions) {
    if (action.type === "addToList" && action.listId) {
      const profileUrl = env.PROFILE_URL || "https://profile-dev.uni-scrm.com";
      await fetch(`${profileUrl}/internal/lists/${action.listId}/users`, {
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

      const linkSocialUrl = env.LINK_SOCIAL_URL || "https://link-social-dev.uni-scrm.com";
      const xEvent = action.xEvent as string;
      const xAction = xEvent === "follow-user" ? "follow"
        : xEvent === "unfollow-user" ? "unfollow"
        : xEvent;
      const actionBody: Record<string, unknown> = { channelId: action.channelId, targetUserId: userId, action: xAction };
      if (xAction === "create-dm" && action.messageText) {
        actionBody.messageText = String(action.messageText).replace(/\$(user|event)\.(\w+)/g, (_, _prefix, field) => {
          const val = payload?.[field];
          return val != null ? String(val) : "";
        });
      }
      const res = await fetch(`${linkSocialUrl}/internal/x/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify(actionBody),
      });

      const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitRemaining?: number; rateLimitReset?: string };

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
    }
  }

  return { stmts, rateLimited };
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
};

app.use("/api/flows", authMiddleware);
app.use("/api/flows/*", authMiddleware);
app.use("/api/channels", authMiddleware);

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

// Proxy lists from profile worker
app.use("/api/lists", authMiddleware);
app.get("/api/lists", async (c) => {
  const profileUrl = c.env.PROFILE_URL || "https://profile-dev.uni-scrm.com";
  const res = await fetch(`${profileUrl}/api/lists`, {
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
  const linkUrl = c.env.LINK_SOCIAL_URL || "https://link-dev.uni-scrm.com";
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
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const countRow = await c.env.FLOW_DB.prepare(
    `SELECT COUNT(*) as total FROM flows WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT id, name, description, status, created_at, updated_at
     FROM flows WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, limit, offset)
    .all();

  return c.json({ flows: rows.results, total, page, totalPages: Math.ceil(total / limit) });
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

// Analytics: node counts (from tenant D1 flow_node_log)
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
      "SELECT node_id, direction, COUNT(*) as count FROM flow_node_log WHERE flow_id = ? GROUP BY node_id, direction",
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
       FROM flow_node_log l LEFT JOIN user u ON u.id = l.user_id
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

const FLOW_NODE_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS flow_node_log (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
const FLOW_NODE_LOG_INDEX = `CREATE INDEX IF NOT EXISTS idx_fnl_flow_node ON flow_node_log(flow_id, node_id)`;

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
          `INSERT OR IGNORE INTO flow_node_log (id, flow_id, node_id, user_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, log.flowId, log.nodeId, log.userId, log.direction, log.timestamp]
        );
      }
      console.log(JSON.stringify({ event: "flow_node_log_written", tenantId, count: logs.length }));
    } catch (e) {
      console.error(JSON.stringify({ event: "flow_node_log_error", tenantId, error: String(e) }));
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

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    // Route by queue name
    if (batch.queue === "flow-log-dev" || batch.queue === "flow-log") {
      await handleLogQueue(batch, env);
      return;
    }

    for (const message of batch.messages) {
      try {
        const { tenantId, eventType, userId, payload } = message.body as FlowQueueMessage;

        const rows = await env.FLOW_DB.prepare(
          `SELECT id, graph_json FROM flows WHERE tenant_id = ? AND status = 'published'`
        )
          .bind(tenantId)
          .all<{ id: string; graph_json: string }>();

        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, payload);
          if (result.nodeLogs.length > 0) emitNodeLogs(result.nodeLogs, flow.id, userId, Number(tenantId), env);

          if (result.actions.length > 0) {
            const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, userId, tenantId, env, payload);
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

          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(pending.flow_id).first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(pending.id).run();
            continue;
          }

          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const pendingPayload = JSON.parse(pending.payload);
          const result = resumeFromNode(graph, pending.node_id, pendingPayload, "yes");

          const stmts: D1PreparedStatement[] = [
            env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(pending.id),
          ];
          if (result.actions.length > 0) {
            const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, pending.user_id, pending.tenant_id, env);
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
          await env.FLOW_DB.batch(stmts);
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
          const { stmts: actionStmts, rateLimited: rl } = await executeActions([action], retryUserId, row.tenant_id, env);

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

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();

        if (!flow || flow.status !== "published") {
          await env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id).run();
          continue;
        }

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);

        const branch = row.awaiting_event ? "no" : undefined;
        const result = resumeFromNode(graph, row.node_id, payload, branch);

        const stmts: D1PreparedStatement[] = [
          env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id),
        ];

        if (result.actions.length > 0) {
          const { stmts: actionStmts, rateLimited: rl } = await executeActions(result.actions, row.user_id, row.tenant_id, env);
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

        await env.FLOW_DB.batch(stmts);
        console.log(JSON.stringify({ event: "flow_pending_executed", flowId: row.flow_id, userId: row.user_id, branch: branch || "continue", actions: result.actions }));
      } catch (e) {
        console.error(JSON.stringify({ event: "flow_pending_error", id: row.id, error: String(e) }));
      }
    }
  },
};
