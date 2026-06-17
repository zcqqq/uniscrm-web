import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, FlowQueueMessage } from "./types";
import { executeFlow, resumeFromNode, type FlowGraph, type ActionResult } from "./engine";

async function executeActions(actions: ActionResult[], userId: string, tenantId: string, env: Env): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];

  for (const action of actions) {
    if (action.type === "addPoint") {
      stmts.push(env.DB.prepare(`UPDATE user SET point = point + 1 WHERE id = ?`).bind(userId));
    } else if (action.type === "addToList" && action.listId) {
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
      const linkSocialUrl = env.LINK_SOCIAL_URL || "https://link-social-dev.uni-scrm.com";
      const xAction = (action.xEvent as string) === "follow-user" ? "follow" : "unfollow";
      await fetch(`${linkSocialUrl}/internal/x/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify({ channelId: action.channelId, targetUserId: userId, action: xAction }),
      });
    }
  }

  return stmts;
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

// List channels for tenant by type
app.get("/api/channels", async (c) => {
  const memberId = c.get("memberId");
  const type = (c.req.query("type") || "").toUpperCase();
  const channelType = type === "X" ? "X" : type;

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.config FROM channels c
     WHERE c.user_id = ? AND c.channel_type IN (?, 'TWITTER')`
  )
    .bind(memberId, channelType)
    .all<{ id: string; config: string }>();

  const channels = rows.results.map((r) => {
    const config = JSON.parse(r.config || "{}");
    return { id: r.id, username: config.x_username || config.username || "" };
  });

  return c.json(channels);
});

// List flows
app.get("/api/flows", async (c) => {
  const tenantId = c.get("tenantId");
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query("limit") || "20", 10)));
  const offset = (page - 1) * limit;

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM flows WHERE tenant_id = ?`
  )
    .bind(tenantId)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.DB.prepare(
    `SELECT id, name, description, enabled, created_at, updated_at
     FROM flows WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, limit, offset)
    .all();

  return c.json({ flows: rows.results, total, page, totalPages: Math.ceil(total / limit) });
});

// Create flow
app.post("/api/flows", async (c) => {
  const tenantId = c.get("tenantId");
  const body = await c.req.json<{ name?: string; description?: string; graph_json?: string }>().catch(() => ({ name: undefined, description: undefined, graph_json: undefined }));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = body.name || "Untitled Flow";
  const description = body.description || "";
  const graphJson = body.graph_json || '{"nodes":[],"edges":[]}';

  await c.env.DB.prepare(
    `INSERT INTO flows (id, tenant_id, name, description, graph_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
  )
    .bind(id, tenantId, name, description, graphJson, now, now)
    .run();

  return c.json({ flow: { id, name, description } }, 201);
});

// Get flow
app.get("/api/flows/:id", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const flow = await c.env.DB.prepare(
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
    enabled?: boolean;
  }>();

  const existing = await c.env.DB.prepare(
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
  if (body.enabled !== undefined) { sets.push("enabled = ?"); params.push(body.enabled ? 1 : 0); }

  if (sets.length === 0) return c.json({ error: "No fields to update" }, 400);

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(flowId);
  params.push(tenantId);

  await c.env.DB.prepare(
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

  const result = await c.env.DB.prepare(
    `DELETE FROM flows WHERE id = ? AND tenant_id = ?`
  )
    .bind(flowId, tenantId)
    .run();

  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);

  await c.env.DB.prepare(`DELETE FROM flow_pending WHERE flow_id = ?`).bind(flowId).run();

  return c.json({ ok: true });
});

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

  async queue(batch: MessageBatch<FlowQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const { tenantId, eventType, userId, payload } = message.body;

        const rows = await env.DB.prepare(
          `SELECT id, graph_json FROM flows WHERE tenant_id = ? AND enabled = 1`
        )
          .bind(tenantId)
          .all<{ id: string; graph_json: string }>();

        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, payload);

          if (result.actions.length > 0) {
            const actionStmts = await executeActions(result.actions, userId, tenantId, env);
            const stmts: D1PreparedStatement[] = [
              env.DB.prepare(
                `INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at)
                 VALUES (?, ?, ?, ?, 1, ?)`
              ).bind(crypto.randomUUID(), flow.id, userId, tenantId, new Date().toISOString()),
              ...actionStmts,
            ];

            await env.DB.batch(stmts);
            console.log(JSON.stringify({ event: "flow_matched", flowId: flow.id, userId, eventType, actions: result.actions }));
          }

          for (const wait of result.pendingWaits) {
            const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
            await env.DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(), flow.id, wait.nodeId, userId, tenantId,
              JSON.stringify(payload), executeAt, new Date().toISOString()
            ).run();
            console.log(JSON.stringify({ event: "flow_wait_scheduled", flowId: flow.id, nodeId: wait.nodeId, executeAt }));
          }
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
    const pending = await env.DB.prepare(
      `SELECT id, flow_id, node_id, user_id, tenant_id, payload, created_at FROM flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; user_id: string; tenant_id: string; payload: string; created_at: string }>();

    if (pending.results.length === 0) return;

    for (const row of pending.results) {
      try {
        const flow = await env.DB.prepare(`SELECT graph_json, enabled FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; enabled: number }>();

        if (!flow || !flow.enabled) {
          await env.DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id).run();
          console.log(JSON.stringify({ event: "flow_pending_orphan_deleted", id: row.id, reason: !flow ? "flow_deleted" : "flow_disabled" }));
          continue;
        }

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);
        const result = await resumeFromNode(graph, row.node_id, payload, {
          db: env.DB,
          userId: row.user_id,
          triggerTime: row.created_at,
        });

        const stmts: D1PreparedStatement[] = [
          env.DB.prepare(`DELETE FROM flow_pending WHERE id = ?`).bind(row.id),
        ];

        if (result.actions.length > 0) {
          const actionStmts = await executeActions(result.actions, row.user_id, row.tenant_id, env);
          stmts.push(
            env.DB.prepare(
              `INSERT INTO flow_executions (id, flow_id, user_id, tenant_id, matched, created_at)
               VALUES (?, ?, ?, ?, 1, ?)`
            ).bind(crypto.randomUUID(), row.flow_id, row.user_id, row.tenant_id, now),
            ...actionStmts
          );
        }

        for (const wait of result.pendingWaits) {
          const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
          stmts.push(
            env.DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(crypto.randomUUID(), row.flow_id, wait.nodeId, row.user_id, row.tenant_id, row.payload, executeAt, now)
          );
        }

        await env.DB.batch(stmts);
        console.log(JSON.stringify({ event: "flow_pending_executed", flowId: row.flow_id, userId: row.user_id, actions: result.actions }));
      } catch (e) {
        console.error(JSON.stringify({ event: "flow_pending_error", id: row.id, error: String(e) }));
      }
    }
  },
};
