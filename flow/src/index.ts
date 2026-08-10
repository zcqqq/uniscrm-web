import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, FlowQueueMessage } from "./types";
import { executeFlow, resumeFromNode, evaluateFaceRatioBranch, evaluateOrientationBranch, conditionsPass, type FlowGraph, type ActionResult, type NodeLog, type PendingWait } from "./engine";
import { EventMetadata_X } from "../../metadata/x";
import { passesPropsFilter } from "../../metadata/props-filter";
import { r2Query, latestRowsSql, sqlStr, sqlInt } from "../../shared/r2-sql";
import { buildFlowGenerateSystemPrompt, type FlowDomain } from "./generate-prompt";
import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, NODE_TYPE_REGISTRY, CONDITION_LOGIC_OR, resolveYouTubeSubscriptions, resolveGitHubRepos } from "../nodeTypeRegistry";
import { fetchActiveChannelIds, triggerBindsChannel, findBrokenTrigger, brokenTriggerMessage, findGitHubTriggerNoRepos, githubNoRepoMessage } from "./trigger-health";
import { conditionsNeedAuthor, youtubeConditionRequest, resolveYouTubeCondition, type VideoStatsResponse } from "./youtube-condition";
import { createInternalAuthMiddleware, resolveAuthMe, resolveSession, spaLoginGuard } from "../../shared/auth";

// node ids are NOT always UUIDs: flow/frontend/config/templates.ts hardcodes short ids like
// "t1"/"w1"/"a1" for template-instantiated flows, and those ids persist forever unless the node
// is deleted and re-added. queryNodeLogRows interpolates a node id directly into an R2 SQL
// string, so this character class is a hard security boundary there — not just a format nicety.
// Enforced at both ends of the id's lifecycle: here at save time (reject a non-conforming graph
// outright) and again at the node-logs route (defense in depth, in case old data predates this).
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Malformed JSON is the caller's problem elsewhere (this graph won't render either way) — only
// the id shape is this guard's concern.
function findInvalidNodeIds(graphJson: string): string[] {
  let graph: { nodes?: { id?: unknown }[] };
  try {
    graph = JSON.parse(graphJson);
  } catch {
    return [];
  }
  return (graph.nodes || [])
    .map((n) => String(n?.id ?? ""))
    .filter((id) => !NODE_ID_RE.test(id));
}

// A flow's domain is stored on the row (migration 0014), set at creation and never changed.
// It used to be sniffed from graph_json for a content trigger node type, which broke as soon
// as the graph lost its trigger — the flow then read the user-domain counts/log tables.
async function isContentDomainFlow(env: Env, flowId: string, tenantId: string): Promise<boolean | null> {
  const row = await env.FLOW_DB.prepare("SELECT domain FROM flows WHERE id = ? AND tenant_id = ?")
    .bind(flowId, tenantId).first<{ domain: string }>();
  return row ? row.domain === "content" : null;
}

async function emitNodeLogs(nodeLogs: NodeLog[], flowId: string, userId: string, tenantId: number, env: Env): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  const records = nodeLogs.map((log) => ({
    tenant_id: tenantId,
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    user_id: userId,
    direction: log.direction,
    outcome: log.direction === "outcome" ? log.outcome : undefined,
    failure_reason: log.direction === "outcome" && log.outcome === "failed" ? log.failureReason : undefined,
    created_at: timestamp,
  }));
  await env.PIPELINE_FLOW_LOG?.send(records).catch(() => {});
}

async function emitContentNodeLogs(
  nodeLogs: NodeLog[],
  flowId: string,
  contentId: string,
  tenantId: string,
  env: Env,
  payload: Record<string, unknown>
): Promise<void> {
  if (nodeLogs.length === 0) return;
  const timestamp = new Date().toISOString();
  // processed_video_url (set once a videoAction node produces a new video) takes priority over
  // the originating trigger's content_url — any node downstream of a resolved videoAction is
  // now "about" that produced video, including a second chained videoAction (see engine.ts's
  // videoAction handling in executeContentActions).
  const contentUrl = (payload?.processed_video_url as string) || (payload?.content_url as string) || undefined;
  const records = nodeLogs.map((log) => ({
    tenant_id: Number(tenantId),
    id: crypto.randomUUID(),
    flow_id: flowId,
    node_id: log.nodeId,
    content_id: contentId,
    direction: log.direction,
    outcome: log.direction === "outcome" ? log.outcome : undefined,
    failure_reason: log.direction === "outcome" && log.outcome === "failed" ? log.failureReason : undefined,
    title: payload?.title as string | undefined,
    content_text: payload?.content_text as string | undefined,
    content_url: contentUrl,
    created_at: timestamp,
  }));
  await env.PIPELINE_CONTENT_FLOW_LOG?.send(records).catch(() => {});
}

interface CountRow {
  tenant_id: number;
  flow_id: string;
  node_id: string;
  direction: string;
  cnt: number;
}

// null = the query failed (as opposed to []: the table is genuinely empty). The caller treats
// them very differently — a failure must keep the last good counts, an empty table must wipe.
// r2Query throws R2SqlError on any failure (non-2xx, {"error"} or {"success": false} bodies),
// which is exactly the signal that maps to null here.
//
// No tenant_id filter on purpose: this is the scheduled() cross-tenant aggregate that rebuilds
// flow_counts/content_flow_counts, keyed BY tenant_id in the GROUP BY — every resulting row
// lands in D1 with its tenant_id and every read of those tables filters on it.
async function queryR2Counts(env: Env, table: string): Promise<CountRow[] | null> {
  try {
    // DISTINCT id: Cloudflare Pipelines delivery is at-least-once — the same record (same
    // worker-generated UUID) has been observed landing in the Iceberg table twice. id is
    // the idempotency key, so duplicates collapse here instead of inflating counts.
    return await r2Query<CountRow>(
      env,
      `SELECT tenant_id, flow_id, node_id, direction, COUNT(DISTINCT id) as cnt FROM ${table} GROUP BY tenant_id, flow_id, node_id, direction`
    );
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_counts_query_failed", table, error: String(e) }));
    return null;
  }
}

export interface NodeLogRow {
  subjectId: string;
  created_at: string;
  direction: string;
  outcome: string | null;
  failure_reason: string | null;
  title: string | null;
  content_text: string | null;
  content_url: string | null;
}

export async function queryNodeLogRows(
  env: Env,
  table: "uniscrm.flow_log" | "uniscrm.content_flow_log",
  subjectColumn: "user_id" | "content_id",
  tenantId: number,
  flowId: string,
  nodeId: string
): Promise<NodeLogRow[]> {
  // Guard adjacent to the hazard: nodeId lands inside an R2 SQL string below. sqlStr escaping
  // already makes that injection-safe, but the shape check stays here too (the route validates
  // as well — defense in depth) so this function is safe no matter who calls it.
  if (!NODE_ID_RE.test(nodeId)) {
    throw new Error(`queryNodeLogRows: node id fails NODE_ID_RE: ${JSON.stringify(nodeId)}`);
  }
  // title/content_text/content_url exist only on content_flow_log — selecting them against
  // flow_log makes R2 SQL reject the whole query (success:false), which silently emptied every
  // user-domain node-log drawer. Keep the column list table-specific.
  const contentColumns = table === "uniscrm.content_flow_log" ? ", title, content_text, content_url" : "";
  const sql = `SELECT ${subjectColumn}, created_at, direction, outcome, failure_reason${contentColumns} FROM ${table}
                WHERE tenant_id = ${sqlInt(tenantId)} AND flow_id = ${sqlStr(flowId)} AND node_id = ${sqlStr(nodeId)} AND direction IN ('enter', 'outcome')
                ORDER BY created_at DESC LIMIT 50`;
  let rows: Record<string, unknown>[];
  try {
    rows = await r2Query<Record<string, unknown>>(env, sql);
  } catch (e) {
    // A rejected R2 SQL query used to return [] indistinguishably from "this node has no rows",
    // which is how a bad column list stayed invisible. r2Query throws on any failure; the drawer
    // degrades to empty but the failure is never silent.
    console.error(JSON.stringify({ event: "node_logs_query_failed", table, tenantId, flowId, nodeId, error: String(e) }));
    return [];
  }
  return rows.map((r) => ({
    subjectId: String(r[subjectColumn]),
    created_at: String(r.created_at),
    direction: String(r.direction),
    outcome: (r.outcome as string | null) ?? null,
    failure_reason: (r.failure_reason as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    content_text: (r.content_text as string | null) ?? null,
    content_url: (r.content_url as string | null) ?? null,
  }));
}

// Mirrors link/src/services/r2-entities.ts's getUserDisplayNames column-for-column (name,
// username, is_deleted; same partition; is_deleted in outerWhere per latestRowsSql's doc comment
// on why a pre-QUALIFY is_deleted filter resurrects deleted rows) without importing across the
// module boundary — 各模块间尽量减少逻辑耦合，通过数据（Cloudflare 各组件）耦合. flow's node-log
// drawer only renders `name`, but keeping the same column list as link's query means the two
// can't silently diverge in behavior (e.g. a future is_deleted fix) without someone noticing the
// duplication and porting it — a leaner projection here would hide that.
//
// Looked up by `source_user_id`, NOT `id`: the `ids` this is called with are flow_log.user_id
// values, which are flow's own user identity — the EXTERNAL platform id (X's numeric user id),
// never entity_state's/uniscrm.user's minted uuid `id` (see resolveUserPropsForFilter's comment
// above and docs/adr/0005). Filtering `id IN (...)` against an X id population always misses,
// which is how the node-log drawer used to render every row nameless (final review I3). Unlike
// link/src/routes-lists.ts's list_users (a genuinely MIXED uuid/X-id population — see
// getUserDisplayNamesMixed in link/src/services/r2-entities.ts), flow_log.user_id is always an
// X id (the only FLOW_QUEUE sender for the user domain is link/src/webhook.ts, which always
// sends `userId: userData.id`) — a single source_user_id lookup is correct here, no uuid branch
// needed.
async function getUserNames(env: Env, tenantId: number, sourceUserIds: string[]): Promise<Map<string, string | null>> {
  if (sourceUserIds.length === 0) return new Map();
  const list = sourceUserIds.map(sqlStr).join(", ");
  const rows = await r2Query<{ source_user_id: string; name: string | null; username: string | null }>(
    env,
    latestRowsSql({
      table: "uniscrm.user",
      columns: ["source_user_id", "name", "username", "is_deleted"],
      partitionBy: ["channel_id", "source_user_id"],
      where: [`tenant_id = ${sqlInt(tenantId)}`, `source_user_id IN (${list})`],
      outerWhere: ["is_deleted = 0"],
    })
  );
  return new Map(rows.map((r) => [r.source_user_id, r.name ?? null]));
}

export async function recomputeFlowCounts(env: Env): Promise<void> {
  const [flowRows, contentFlowRows] = await Promise.all([
    queryR2Counts(env, "uniscrm.flow_log"),
    queryR2Counts(env, "uniscrm.content_flow_log"),
  ]);

  const now = new Date().toISOString();

  // Full replace, not upsert: the R2 aggregate above is the complete source of truth, and the
  // log tables can be rebuilt (schema changes archive/drop them) — upsert-only left ghost
  // counts behind for combos that no longer exist in R2. DELETE + INSERT run in one D1 batch
  // (a transaction), so a failure keeps the previous counts intact rather than leaving a
  // half-wiped table.
  const replaceCounts = async (table: "flow_counts" | "content_flow_counts", rows: CountRow[] | null) => {
    if (rows === null) return; // query failed — last good counts beat a wipe
    const stmts = [env.FLOW_DB.prepare(`DELETE FROM ${table}`)];
    for (const r of rows) {
      stmts.push(
        env.FLOW_DB.prepare(
          `INSERT INTO ${table} (tenant_id, flow_id, node_id, direction, count, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(r.tenant_id, r.flow_id, r.node_id, r.direction, r.cnt, now)
      );
    }
    try {
      await env.FLOW_DB.batch(stmts);
    } catch (e) {
      console.error(JSON.stringify({ event: `${table}_replace_error`, rows: rows.length, error: String(e) }));
    }
  };
  await replaceCounts("flow_counts", flowRows);
  await replaceCounts("content_flow_counts", contentFlowRows);

  // trigger_count needs BOTH aggregates (a content flow's count would be zeroed by a view that
  // only includes flow_log) — skip the pass entirely if either query failed.
  if (flowRows === null || contentFlowRows === null) {
    console.log(JSON.stringify({ event: "flow_counts_recomputed_partial", flowOk: flowRows !== null, contentOk: contentFlowRows !== null }));
    return;
  }
  const allRows = [...flowRows, ...contentFlowRows];

  // Cache each flow's trigger-node "entered" count directly on flows.trigger_count, so the list
  // page's GET /api/flows can read it as a plain column with no per-request join, R2 call, or
  // tenant-db round-trip. "enter" rows for both domains are already in allRows above.
  const enterCountByFlowNode = new Map<string, number>();
  for (const r of allRows) {
    if (r.direction === "enter") enterCountByFlowNode.set(`${r.flow_id}:${r.node_id}`, r.cnt);
  }

  const flows = await env.FLOW_DB.prepare(`SELECT id, graph_json FROM flows`).all<{ id: string; graph_json: string }>();
  for (const flow of flows.results) {
    let triggerNodeId: string | undefined;
    try {
      const graph = JSON.parse(flow.graph_json) as { nodes: { id: string; type: string }[] };
      triggerNodeId = graph.nodes.find((n) => NODE_TYPE_REGISTRY[n.type]?.role === "trigger")?.id;
    } catch (e) {
      console.error(JSON.stringify({ event: "flow_counts_recompute_graph_parse_error", flowId: flow.id, error: String(e) }));
      continue;
    }
    if (!triggerNodeId) continue;
    // Absent from R2 → NULL, always written: after a log-table rebuild, a trigger that lost its
    // rows must not keep its pre-rebuild count forever. NULL (not 0) keeps "no data yet" and
    // "never counted" identical, which is what the list page already renders.
    const count = enterCountByFlowNode.get(`${flow.id}:${triggerNodeId}`) ?? null;
    try {
      await env.FLOW_DB.prepare(`UPDATE flows SET trigger_count = ? WHERE id = ?`).bind(count, flow.id).run();
    } catch (e) {
      console.error(JSON.stringify({ event: "flow_trigger_count_update_error", flowId: flow.id, count, error: String(e) }));
    }
  }

  console.log(JSON.stringify({ event: "flow_counts_recomputed", flowRows: flowRows.length, contentFlowRows: contentFlowRows.length }));
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
  // The action node's own outcome row PLUS every enter/exit reached by resolving its branch —
  // resumeFromNode returns both in one list and the caller emits them together. Callers that
  // pass no `graph` still get the outcome row alone (branch resolution is skipped, exactly as
  // it behaved before).
  nodeLogs: NodeLog[];
}

// Depth cap on branch-resolution recursion. The editor lets a user wire an action's success/failed
// handle back into an upstream node, and executeActions -> resumeFromNode -> executeActions would
// then never terminate. 10 is far past any real flow's action chain; hitting it means a cycle.
const MAX_BRANCH_DEPTH = 10;

// flow 唯一的 user props 热读是 metadata/x.ts 的 userPropsFilter,而它只用到 is_follow(/is_followed)。
// 这两列常驻 entity_state(link 的 D1 index table,毫秒级),不走 R2 —— R2 单次查询 1-3s,
// 会把每次 xAction 都拖慢。
//
// `userId` here is flow's own user identity, which — unlike `uniscrm.user.id`/entity_state's
// `entity_id` — is the EXTERNAL platform id (X's numeric user id), never the uuid entity_state
// mints in EntityStateStore.claim(). webhook.ts sends `userId: userData.id` into FLOW_QUEUE, and
// routes-internal.ts posts that same value straight to api.x.com/2/users/{sourceUserId}/... — so
// it must keep meaning "X id" everywhere in flow. Looking it up against entity_id (as this used
// to) always misses, silently skipping every userPropsFilter-gated action (see final review C1).
// The correct key mirrors EntityStateStore's own shape exactly (link/src/services/entity-state.ts):
// entity='user', channel_id=action's channelId, secondary_id='' (EntityStateStore.sec()'s
// default for an omitted secondaryId), source_id=the X user id.
export async function resolveUserPropsForFilter(
  env: Env,
  tenantId: number,
  channelId: string,
  userId: string
): Promise<Record<string, unknown>> {
  const row = await env.LINK_DB
    .prepare(
      `SELECT is_follow, is_followed FROM entity_state
       WHERE tenant_id = ? AND entity = 'user' AND channel_id = ? AND secondary_id = '' AND source_id = ?`
    )
    .bind(tenantId, channelId, userId)
    .first<{ is_follow: number | null; is_followed: number | null }>();
  // Unknown user → empty props object → passesPropsFilter's every-condition-must-match semantics
  // fail closed (no matching props means no condition can pass), so the action is skipped rather
  // than fired against stale/missing follow state.
  if (!row) return {};
  return { is_follow: row.is_follow, is_followed: row.is_followed };
}

// 分支解析的四步收尾（resumeFromNode → 节点日志 → 递归执行下游 action → 落 pending wait），
// user / content 两域共用的唯一实现——此前 content 域内联了十余份副本并各自漂移（有的漏写
// conditions，全部漏写 condition_logic）。
//
// 不变量：
// - resumed.nodeLogs[0] 是被解析节点自己的重复 exit，被 resumeFromNode 改标为
//   direction:"outcome"（wait/waitForEvent/timeCondition 除外，它们此刻才记真正的 exit）。
//   调用方绝不能再补一条 outcome 行，否则该节点被重复计数。
// - pending wait 行的 conditions / condition_logic 必须与 wait 节点同源快照一起写入
//   （见 migrations/0016、0017 的注释）：等待期间用户改 flow，不能出现"旧条件 + 新逻辑"。
// - emitLogs / runActions 是仅有的两个域注入点：user 域把日志累积进 executeActions 的本地
//   数组、下游动作递归 executeActions（带 depth+1）；content 域立即 emitContentNodeLogs、
//   下游递归 executeContentActions。四步的顺序与 pending 落库形状两域完全一致。
interface OutcomeEpilogueOps {
  table: "flow_pending" | "content_flow_pending";
  subjectColumn: "user_id" | "content_id";
  subjectId: string;
  // 保持各域既有的绑定类型不变：user 域一直绑字符串 tenantId，content 域绑数值。
  tenantId: string | number;
  flowId: string;
  // 落进 pending 行的 payload 串由调用方给定（content 域要混入 channel_id；sweep 场景直接
  // 复用行里已有的原串）——它与传给 resumeFromNode 的运行时 payload 可以不同。
  storedPayload: string;
  emitLogs(nodeLogs: NodeLog[]): Promise<void>;
  runActions(actions: ActionResult[]): Promise<void>;
  onWaitScheduled?(wait: PendingWait, executeAt: string): void;
}

async function recordBranchOutcome(
  env: Env,
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  branch: string | undefined,
  failureReason: string | undefined,
  ops: OutcomeEpilogueOps
): Promise<void> {
  const resumed = resumeFromNode(graph, nodeId, payload, branch, failureReason);
  if (resumed.nodeLogs.length > 0) await ops.emitLogs(resumed.nodeLogs);
  if (resumed.actions.length > 0) await ops.runActions(resumed.actions);
  // Written directly rather than returned for the caller to batch: each call site persists its
  // own top-level pendingWaits in its own shape, and a wait reached through a branch belongs to
  // none of them.
  for (const wait of resumed.pendingWaits) {
    const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
    await env.FLOW_DB.prepare(
      `INSERT INTO ${ops.table} (id, flow_id, node_id, ${ops.subjectColumn}, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), ops.flowId, wait.nodeId, ops.subjectId, ops.tenantId,
      ops.storedPayload, executeAt, new Date().toISOString(),
      wait.awaitingEvent || "",
      wait.conditions ? JSON.stringify(wait.conditions) : "",
      wait.conditionLogic || ""
    ).run();
    ops.onWaitScheduled?.(wait, executeAt);
  }
}

// `graph` is what makes an action node's success/failed branch actually continue: without it the
// node's outcome is only recorded for the analytics drawer and the flow stops there (which is how
// a user-flow X Action's "failed" edge silently led nowhere — see flow/CLAUDE.md's rule that every
// third-party-API action has success/failed branches). It stays optional so a caller that has no
// graph in hand degrades to the old outcome-only behaviour rather than crashing.
async function executeActions(
  actions: ActionResult[],
  userId: string,
  tenantId: string,
  env: Env,
  payload?: Record<string, unknown>,
  flowId?: string,
  graph?: FlowGraph,
  depth = 0
): Promise<ActionExecResult> {
  const stmts: D1PreparedStatement[] = [];
  const rateLimited: { action: ActionResult; retryAt: string }[] = [];
  const nodeLogs: NodeLog[] = [];

  // Resolves one action node's outcome. With a graph it walks the matching branch — the returned
  // nodeLogs[0] IS the outcome row (resumeFromNode relabels the duplicate exit as direction
  // "outcome"), so this must never also push its own, or every action would be counted twice.
  const recordOutcome = async (action: ActionResult, ok: boolean, failureReason?: string) => {
    const nodeId = action.nodeId as string | undefined;
    if (!nodeId) return;
    const branch = ok ? "success" : "failed";
    if (!graph || !action.hasBranches) {
      nodeLogs.push({ nodeId, direction: "outcome", outcome: branch, failureReason: ok ? undefined : failureReason });
      return;
    }
    if (depth >= MAX_BRANCH_DEPTH) {
      console.error(JSON.stringify({ event: "flow_branch_depth_exceeded", flowId, nodeId, depth }));
      nodeLogs.push({ nodeId, direction: "outcome", outcome: branch, failureReason: ok ? undefined : failureReason });
      return;
    }
    await recordBranchOutcome(env, graph, nodeId, payload || {}, branch, failureReason, {
      table: "flow_pending",
      subjectColumn: "user_id",
      subjectId: userId,
      tenantId,
      flowId: flowId || "",
      storedPayload: JSON.stringify(payload || {}),
      emitLogs: async (logs) => { nodeLogs.push(...logs); },
      runActions: async (resumedActions) => {
        const nested = await executeActions(resumedActions, userId, tenantId, env, payload, flowId, graph, depth + 1);
        stmts.push(...nested.stmts);
        rateLimited.push(...nested.rateLimited);
        nodeLogs.push(...nested.nodeLogs);
      },
      onWaitScheduled: (wait) => console.log(JSON.stringify({ event: "flow_wait_scheduled", flowId, nodeId: wait.nodeId, awaitingEvent: wait.awaitingEvent || "", viaBranch: branch })),
    });
  };

  for (const action of actions) {
    if (action.type === "addToList" && action.listId) {
      const linkUrl = env.LINK_URL;
      const listRes = await fetch(`${linkUrl}/internal/lists/${action.listId}/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": env.INTERNAL_SECRET,
          "X-Tenant-Id": tenantId,
        },
        body: JSON.stringify({ userId }),
      });
      await recordOutcome(action, listRes.ok, `list_add_failed: HTTP ${listRes.status}`);
    } else if (action.type === "xAction" && action.xEvent && action.channelId) {
      // Check userPropsFilter before executing action
      const meta = EventMetadata_X.find(m => m.eventType === action.xEvent);
      if (meta?.userPropsFilter?.length) {
        const row = await resolveUserPropsForFilter(env, Number(tenantId), action.channelId as string, userId);
        const pass = passesPropsFilter(meta.userPropsFilter, row);
        if (!pass) {
          console.log(JSON.stringify({ event: "flow_action_skipped_filter", xEvent: action.xEvent, userId, filter: meta.userPropsFilter, actual: row }));
          continue;
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

      const body = await res.json() as { ok: boolean; rateLimited?: boolean; rateLimitRemaining?: number; rateLimitReset?: string; insufficientCredit?: boolean; reason?: string };

      // Credit exhausted: link declined to call the X API at all (non-BYOK channel, balance <= 0)
      if (body.insufficientCredit) {
        console.log(JSON.stringify({ event: "xaction_insufficient_credit", tenantId, xEvent: action.xEvent, channelId: action.channelId }));
        await recordOutcome(action, false, "insufficient_credit: no credit balance left on this non-BYOK channel");
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
        // Not an outcome yet — per flow/CLAUDE.md a 429 only becomes "failed" once retries are
        // exhausted, so this reschedules without recording anything.
        rateLimited.push({ action: { ...action, userId }, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
      } else {
        await recordOutcome(action, body.ok, body.reason || "x_api_error");
      }
    } else if (action.type === "webhook" && action.url) {
      const method = (action.method as string) || "POST";
      const headers: Record<string, string> = { "Content-Type": "application/json", ...(action.headers as Record<string, string> || {}) };
      const bodyStr = action.body ? String(action.body).replace(/\$(user|event)\.(\w+)/g, (_, _p, field) => String(payload?.[field] ?? "")) : JSON.stringify({ userId, ...payload });
      let ok = false;
      let reason: string | undefined;
      try {
        const res = await fetch(action.url as string, { method, headers, body: method !== "GET" ? bodyStr : undefined });
        ok = res.ok;
        reason = ok ? undefined : `webhook_failed: HTTP ${res.status}`;
      } catch (e) {
        reason = `webhook_error: ${String(e)}`;
      }
      (action as any).success = ok;
      await recordOutcome(action, ok, reason);
    }
  }

  return { stmts, rateLimited, nodeLogs };
}

export function youtubeActionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  action: { operation?: string; playlistId?: string };
  channelId: string; contentId: string; flowId?: string | null;
  payload: Record<string, unknown>;
}): { url: string; body: string } {
  const { env, action, channelId, contentId, flowId, payload } = args;
  const videoId = String(payload?.source_content_id ?? "");
  const operation = action.operation || "save-to-playlist";
  if (operation === "rate-like") {
    return {
      url: `${env.LINK_URL}/internal/youtube/rate`,
      body: JSON.stringify({ channelId, contentId, videoId, flowId: flowId || null }),
    };
  }
  return {
    url: `${env.LINK_URL}/internal/youtube/playlist-insert`,
    body: JSON.stringify({ channelId, contentId, videoId, playlistId: action.playlistId || "", flowId: flowId || null }),
  };
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

  // content 域对 recordBranchOutcome 的绑定。epiloguePayload 默认是本次调用的 payload，
  // 只有 youtubeCondition 用它传 outcome.payload（条件求值可能往 payload 里合并了作者 props）。
  const recordContentOutcome = async (
    nodeId: string,
    branch: string,
    failureReason?: string,
    epiloguePayload: Record<string, unknown> = payload
  ) => {
    await recordBranchOutcome(env, graph, nodeId, epiloguePayload, branch, failureReason, {
      table: "content_flow_pending",
      subjectColumn: "content_id",
      subjectId: contentId,
      tenantId: Number(tenantId),
      flowId: flowId || "",
      // channel_id 混入存储 payload：content_flow_pending 没有 channel_id 列，resume 时
      // 要靠它拿回 SOURCE channel（见 queue() 里同样做法的注释）。
      storedPayload: JSON.stringify({ ...epiloguePayload, channel_id: channelId }),
      emitLogs: (logs) => emitContentNodeLogs(logs, flowId || "", contentId, tenantId, env, epiloguePayload),
      runActions: async (resumedActions) => {
        const nested = await executeContentActions(graph, resumedActions, contentId, channelId, tenantId, env, epiloguePayload, flowId);
        rateLimited.push(...nested.rateLimited);
      },
    });
  };

  for (const action of actions) {
    if (action.type === "xContentAction") {
      const operation = (action.operation as string) || "create-post";
      // The X account that ACTS. Falls back to the triggering channel so flows published before
      // the node gained a channel picker keep working — but that fallback is exactly what made
      // an X Action downstream of a YouTube trigger always fail (link rejects a non-X channel),
      // so a configured channelId always wins. The outer `channelId` stays the SOURCE channel
      // and must keep being passed to nested executeContentActions/pending rows unchanged.
      const xChannelId = (action.channelId as string) || channelId;
      let res: Response;
      let logEvent: string;
      let logExtra: Record<string, unknown>;

      if (operation === "create-bookmark") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/bookmark`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId: xChannelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_bookmark";
        logExtra = { channelId: xChannelId, tweetId };
      } else if (operation === "like-post") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/like`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId: xChannelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_like";
        logExtra = { channelId: xChannelId, tweetId };
      } else if (operation === "repost-post") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId: xChannelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_repost";
        logExtra = { channelId: xChannelId, tweetId };
      } else {
        const provider = action.provider as string;
        const skillId = (action.skillId as string) || "none";
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));

        if (action.attachVideo) {
          const videoUrl = String(payload?.processed_video_url ?? "");
          if (!videoUrl) {
            console.log(JSON.stringify({ event: "content_action_x_content_action_missing_video", contentId, channelId: xChannelId }));
            await recordContentOutcome(action.nodeId as string, "failed", "missing_video: no upstream Video Action produced a video to attach");
            continue;
          }
          res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
            body: JSON.stringify({ contentId, interpolatedPrompt, provider, channelId: xChannelId, flowId: flowId || null, skillId, videoUrl }),
          });
          const videoBody = await res.json().catch(() => ({})) as {
            ok?: boolean; pending?: boolean; rateLimited?: boolean; rateLimitReset?: string;
            mediaId?: string; channelId?: string; text?: string; checkAfterSecs?: number; reason?: string;
          };
          if (videoBody.pending) {
            const nodeId = action.nodeId as string;
            const executeAt = new Date(Date.now() + Math.max(videoBody.checkAfterSecs || 60, 60) * 1000).toISOString();
            await env.FLOW_DB.prepare(
              `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
            ).bind(
              crypto.randomUUID(), flowId || "", nodeId, contentId, Number(tenantId),
              JSON.stringify({ ...payload, channel_id: channelId }), executeAt, new Date().toISOString(),
              JSON.stringify({ type: "xVideoStatusPoll", channelId: videoBody.channelId, mediaId: videoBody.mediaId, text: videoBody.text, nodeId })
            ).run();
            console.log(JSON.stringify({ event: "content_action_x_video_pending", contentId, channelId, mediaId: videoBody.mediaId }));
            continue;
          }
          if (videoBody.rateLimited) {
            // Video already uploaded to X successfully — only the final createPost() call hit
            // a rate limit. Reschedule like the non-video rate-limit path below does, rather than
            // treating this as a permanent failure (the uploaded media_id would otherwise be
            // wasted and the tenant's video silently dropped).
            rateLimited.push({ action, retryAt: videoBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
            continue;
          }
          console.log(JSON.stringify({ event: "content_action_x_content_action", contentId, status: res.status, ok: !!videoBody.ok, channelId: xChannelId, provider, skillId, attachVideo: true, reason: videoBody.reason }));
          await recordContentOutcome(action.nodeId as string, videoBody.ok ? "success" : "failed", videoBody.reason);
          continue;
        }

        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, channelId: xChannelId, flowId: flowId || null, skillId }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { channelId: xChannelId, provider, skillId };
      }

      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string; reason?: string };
      console.log(JSON.stringify({ event: logEvent, contentId, status: res.status, ok: body.ok, ...logExtra, reason: body.reason }));

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      await recordContentOutcome(action.nodeId as string, body.ok ? "success" : "failed", body.reason);
    } else if (action.type === "tiktokContentAction") {
      const interpolate = (s: string) => String(s || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
      const operation = (action.operation as string) || "photo-post";

      if (operation === "video-post") {
        const videoUrl = String(payload?.processed_video_url ?? "");
        if (!videoUrl) {
          console.log(JSON.stringify({ event: "content_action_tiktok_video_post_missing_video", contentId, channelId: action.channelId }));
          await recordContentOutcome(action.nodeId as string, "failed", "missing_video: no upstream Video Action produced a video to post");
          continue;
        }
        const rawPrompts = (action.prompts as Record<string, string>) || {};
        const body = {
          contentId,
          channelId: action.channelId as string,
          prompts: { title: interpolate(rawPrompts.title), description: interpolate(rawPrompts.description) },
          textProvider: action.textProvider as string,
          textSkillId: action.textSkillId as string,
          videoUrl,
          flowId: flowId || null,
        };
        const res = await fetch(`${env.LINK_URL}/internal/tiktok/video-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify(body),
        });
        const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string; reason?: string };
        console.log(JSON.stringify({ event: "content_action_tiktok_content_action", contentId, status: res.status, ok: respBody.ok, channelId: body.channelId, operation: "video-post" }));

        if (respBody.rateLimited) {
          rateLimited.push({ action, retryAt: respBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
          continue;
        }

        await recordContentOutcome(action.nodeId as string, respBody.ok ? "success" : "failed", respBody.reason);
        continue;
      }

      const rawPrompts = (action.prompts as Record<string, string>) || {};
      const interpolatedPrompts: Record<string, string> = {};
      for (const key of Object.keys(rawPrompts)) {
        interpolatedPrompts[key] = interpolate(rawPrompts[key]);
      }
      const body = {
        contentId,
        channelId: action.channelId as string,
        prompts: interpolatedPrompts,
        textProvider: action.textProvider as string,
        textSkillId: action.textSkillId as string,
        imageCount: action.imageCount as number,
        imageProvider: action.imageProvider as string,
        imageSkillId: action.imageSkillId as string,
        flowId: flowId || null,
      };
      const res = await fetch(`${env.LINK_URL}/internal/tiktok/photo-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string; reason?: string };
      console.log(JSON.stringify({ event: "content_action_tiktok_content_action", contentId, status: res.status, ok: respBody.ok, channelId: body.channelId }));

      if (respBody.rateLimited) {
        rateLimited.push({ action, retryAt: respBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      await recordContentOutcome(action.nodeId as string, respBody.ok ? "success" : "failed", respBody.reason);
    } else if (action.type === "youtubeContentAction") {
      const { url, body } = youtubeActionRequest({ env, action, channelId, contentId, flowId, payload });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body,
      });
      const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string; reason?: string };
      console.log(JSON.stringify({ event: "content_action_youtube", contentId, status: res.status, ok: respBody.ok, channelId, operation: action.operation || "save-to-playlist" }));

      if (respBody.rateLimited) {
        rateLimited.push({ action, retryAt: respBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      await recordContentOutcome(action.nodeId as string, respBody.ok ? "success" : "failed", respBody.reason);
    } else if (action.type === "youtubeCondition") {
      // 同步执行：videos.list 是一次几百毫秒的读调用，不像 videoCondition 的人脸检测需要
      // 拉视频跑容器，所以不进队列、不写 content_flow_pending。
      const nodeId = action.nodeId as string;
      // Array.isArray, not just a truthy check: a malformed graph whose `conditions` is an object
      // or a string would throw ".every is not a function" inside resolveYouTubeCondition — and in
      // the queue path a throw means the message is retried, re-running every action already
      // executed in that batch. An unusable value degrades to "no conditions" instead.
      const conditionNode = graph.nodes.find((n) => n.id === nodeId);
      const rawConditions = conditionNode?.data?.conditions;
      const conditions = (Array.isArray(rawConditions) ? rawConditions : []) as
        { field: string; operator: string; value: string }[];
      // 与 conditions 同一份 node data 读出来，两者必须同源，否则会出现"旧条件 + 新逻辑"。
      const conditionLogic = conditionNode?.data?.conditionLogic;
      const withAuthor = conditionsNeedAuthor(conditions);
      const { url, body } = youtubeConditionRequest({ env, contentId, flowId, payload, withAuthor });

      let resp: VideoStatsResponse;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body,
        });
        resp = res.ok
          ? (await res.json().catch(() => ({ ok: false, reason: "youtube_api_error: malformed response" })) as VideoStatsResponse)
          : { ok: false, reason: `youtube_api_error: link returned ${res.status}` };
      } catch (e) {
        resp = { ok: false, reason: `youtube_api_error: ${String(e)}` };
      }

      const outcome = resolveYouTubeCondition(conditions, payload, resp, conditionLogic);
      // reason 一并打出来：Finding 2 之后 link 的 reason 是有界的短码，flow 这边不再有
      // 别的地方留下"为什么 failed"。
      console.log(JSON.stringify({ event: "content_condition_youtube", contentId, flowId: flowId || null, nodeId, branch: outcome.branch, ok: resp.ok, withAuthor, logic: conditionLogic === CONDITION_LOGIC_OR ? "or" : "and", reason: outcome.failureReason || resp.reason || null }));

      await recordContentOutcome(nodeId, outcome.branch, outcome.failureReason, outcome.payload);
    } else if (action.type === "videoAction" || action.type === "videoCondition") {
      // videoCondition shares this whole dispatch path with videoAction: both need the same
      // video (upstream-processed if any, else the original), the same duration cap, the same
      // content_flow_pending row and the same queue. They differ only in what content does
      // with the video and which branch names the node has — and "failed", the only branch
      // either resolves synchronously here, exists on both.
      const isCondition = action.type === "videoCondition";
      const duration = Number(payload?.duration ?? 0);
      const MAX_DURATION_SECONDS = 600;
      const nodeId = action.nodeId as string;

      if (duration > MAX_DURATION_SECONDS) {
        console.log(JSON.stringify({ event: "content_action_video_action_duration_exceeded", contentId, duration, actionType: action.type }));
        await recordContentOutcome(nodeId, "failed", `duration_exceeded: ${duration}s exceeds the ${MAX_DURATION_SECONDS}s limit`);
        continue;
      }

      const sourceContentId = String(payload?.source_content_id ?? "");
      let videoUrl: string | null = String(payload?.processed_video_url ?? "") || null;
      if (!videoUrl) {
        try {
          const res = await fetch(`${env.LINK_URL}/internal/content/video-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
            body: JSON.stringify({ contentId, channelId, sourceContentId }),
          });
          if (res.ok) {
            const body = await res.json() as { url: string | null };
            videoUrl = body.url;
          }
        } catch {
          // network error: treated the same as "no video" below
        }
      }

      if (!videoUrl) {
        console.log(JSON.stringify({ event: "content_action_video_action_no_video", contentId, actionType: action.type }));
        await recordContentOutcome(nodeId, "failed", "missing_video: the content has no downloadable video URL");
        continue;
      }

      // NOTE: unlike every other branch above, this does NOT call resumeFromNode on this
      // success path — the branch resolves later, asynchronously, when content's video-action
      // queue consumer calls back into POST /internal/video-action/resume with this pendingId
      // ("success"/"failed" for videoAction, "true"/"false"/"failed" for videoCondition, which
      // that route derives from the measured face ratio). Only the two early-exit paths above
      // (duration cap, no video) resolve synchronously here.
      const pendingId = crypto.randomUUID();
      const now = new Date().toISOString();
      const executeAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await env.FLOW_DB.prepare(
        `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        pendingId, flowId || "", nodeId, contentId, Number(tenantId),
        JSON.stringify({ ...payload, channel_id: channelId }), executeAt, now, "video_action_complete"
      ).run();

      await env.VIDEO_ACTION_QUEUE.send({
        pendingId, contentId, tenantId: Number(tenantId),
        videoUrl,
        operation: (action.operation as string) || (isCondition ? "check-face" : "add-subtitle"),
        targetLanguage: (action.targetLanguage as string) || "zh",
        flowId: flowId || "", nodeId, payload,
      });

      console.log(JSON.stringify({ event: "content_action_video_action_dispatched", contentId, pendingId, actionType: action.type }));
    }
  }

  return { rateLimited };
}

type HonoEnv = { Bindings: Env; Variables: { tenantId: string; memberId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

// Auth middleware — session resolution via shared/auth.ts against the WEB_DB binding,
// no HTTP hop to web.
const authMiddleware = async (c: any, next: any) => {
  const session = await resolveSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", session.tenantId);
  c.set("memberId", session.memberId);
  await next();
};

app.use("/api/flows", authMiddleware);
app.use("/api/flows/*", authMiddleware);
app.use("/api/channels", authMiddleware);
app.use("/api/channels/*", authMiddleware);

app.get("/health", (c) => c.json({ status: "ok" }));

// Shared fail-closed X-Internal-Secret check (shared/auth.ts) for every /internal route,
// replacing the per-route inline copies that used to open each handler below.
app.use("/internal/*", createInternalAuthMiddleware());

// Internal: mock trigger event for testing
app.post("/internal/trigger", async (c) => {
  const { tenantId, eventType, userId, channelId, payload } = await c.req.json<any>();
  const flows = await c.env.FLOW_DB.prepare("SELECT id, graph_json FROM flows WHERE tenant_id = ? AND status = 'published'")
    .bind(tenantId).all<{ id: string; graph_json: string }>();
  const results: any[] = [];
  for (const flow of flows.results) {
    const graph: FlowGraph = JSON.parse(flow.graph_json);
    const result = executeFlow(graph, eventType, payload || {});
    if (result.matched) {
      const { stmts, nodeLogs } = await executeActions(result.actions, userId || "", String(tenantId), c.env, payload, flow.id, graph);
      if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, flow.id, userId || "", Number(tenantId), c.env);
      if (stmts.length > 0) await c.env.FLOW_DB.batch(stmts);
      results.push({ flowId: flow.id, actions: result.actions.length, matched: true });
    }
  }
  return c.json({ triggered: results.length, results });
});

// Internal: resolves the "success"/"failed" branch of a videoAction node once content's
// video-action queue consumer finishes processing (transcribe/translate/burn-in), or reports
// a failure at any stage. See content/src/queue-video-action.ts's resumeFlow(), and the
// content_flow_pending row inserted at this file's videoAction dispatch (awaiting_event:
// "video_action_complete"). The periodic sweep below is the backstop if this callback never
// arrives (queue consumer crash, dropped fetch, etc.) within the row's execute_at timeout.
app.post("/internal/video-action/resume", async (c) => {
  const { pendingId, branch, props, reason } = await c.req.json<{
    pendingId: string; branch: "success" | "failed"; props?: Record<string, unknown>; reason?: string;
  }>();

  // SELECT before DELETE: the row's fields are needed after the claim, and the claim itself
  // (the DELETE) is what guards against a race with the sweep also resolving this same row on
  // timeout — see the content_flow_pending sweep's identical claim pattern in scheduled().
  const row = await c.env.FLOW_DB.prepare(
    `SELECT flow_id, node_id, content_id, tenant_id, payload FROM content_flow_pending WHERE id = ?`
  ).bind(pendingId).first<{ flow_id: string; node_id: string; content_id: string; tenant_id: number; payload: string }>();
  if (!row) return c.json({ ok: true, alreadyResolved: true });

  const claim = await c.env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(pendingId).run();
  if (!claim.meta.changes) return c.json({ ok: true, alreadyResolved: true });

  const flow = await c.env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
    .bind(row.flow_id).first<{ graph_json: string; status: string }>();
  if (!flow || flow.status !== "published") return c.json({ ok: true });

  const graph: FlowGraph = JSON.parse(flow.graph_json);
  const payload = { ...JSON.parse(row.payload), ...(props || {}) };

  // content reports "success" to mean "the face ratio was measured" — it never learns that a
  // threshold exists. The comparison happens here, against the node's CURRENT operator and
  // threshold in the graph, so re-tuning the threshold is pure config with no re-detection.
  const resumedNode = graph.nodes.find((n) => n.id === row.node_id);
  const nodeOperation = resumedNode?.data?.operation as string | undefined;
  const effectiveBranch = resumedNode?.type === "videoCondition"
    ? (branch === "success"
        ? (nodeOperation === "check-orientation"
            ? evaluateOrientationBranch(resumedNode.data || {}, payload.aspect_ratio)
            : evaluateFaceRatioBranch(resumedNode.data || {}, payload.face_ratio))
        : "failed")
    : branch;

  // The measured value is deliberately not persisted to any table (it rides the payload into
  // the node log), so without this line the one number the whole node turns on is invisible in
  // production — the container's own stdout is not queryable, and the node log reaches R2 with
  // a lag. Logs the decision, not just the measurement, so a wrong threshold is diagnosable.
  if (resumedNode?.type === "videoCondition" && nodeOperation === "check-orientation") {
    console.log(JSON.stringify({
      event: "video_condition_orientation", contentId: row.content_id, nodeId: row.node_id,
      aspectRatio: payload.aspect_ratio, operator: resumedNode.data?.operator, threshold: resumedNode.data?.threshold,
      reportedBranch: branch, branch: effectiveBranch,
    }));
  } else if (resumedNode?.type === "videoCondition") {
    console.log(JSON.stringify({
      event: "video_condition_face_ratio", contentId: row.content_id, nodeId: row.node_id,
      faceRatio: payload.face_ratio, operator: resumedNode.data?.operator, threshold: resumedNode.data?.threshold,
      reportedBranch: branch, branch: effectiveBranch,
    }));
  }

  // A videoCondition that content measured fine but whose threshold sent it down "failed" is a
  // rule outcome, not an error — content supplies no reason there, and none is invented.
  //
  // 被解析的这行 awaiting_event="video_action_complete"，其 conditions 列永远为空——它是
  // videoAction 派发时写的作业行，不是 waitForEvent 的条件快照，而且 videoAction/videoCondition
  // 的 outcome 本身就是解析结果（分支由测量值 + 节点阈值决定），user 域式的 conditionsPass
  // 门禁在这里语义上不适用，所以刻意不加条件检查。下游若走到新的 waitForEvent，其快照由
  // recordBranchOutcome 统一写入。
  await recordBranchOutcome(c.env, graph, row.node_id, payload, effectiveBranch, reason, {
    table: "content_flow_pending",
    subjectColumn: "content_id",
    subjectId: row.content_id,
    tenantId: row.tenant_id,
    flowId: row.flow_id,
    storedPayload: JSON.stringify(payload),
    emitLogs: (logs) => emitContentNodeLogs(logs, row.flow_id, row.content_id, String(row.tenant_id), c.env, payload),
    runActions: async (resumedActions) => {
      await executeContentActions(graph, resumedActions, row.content_id, String(payload.channel_id ?? ""), String(row.tenant_id), c.env, payload, row.flow_id);
    },
  });

  return c.json({ ok: true });
});

// Internal: which (channel, list) pairs any published flow's xContentTrigger List Posts
// node currently wants polled. link's cron pulls this before each polling cycle — flow's
// graph_json is the sole source of truth, nothing is persisted on link's side for this.
app.get("/internal/list-watches", async (c) => {
  const rows = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE status = 'published' AND graph_json LIKE '%xContentTrigger%'`
  ).all<{ graph_json: string }>();

  const seen = new Set<string>();
  const watches: { channelId: string; listId: string }[] = [];
  for (const row of rows.results) {
    let graph: FlowGraph;
    try {
      graph = JSON.parse(row.graph_json);
    } catch {
      continue;
    }
    // Guard: graph.nodes must exist and be an array
    if (!graph || !Array.isArray(graph.nodes)) continue;
    for (const node of graph.nodes) {
      // Guard: node.data must exist before accessing properties
      if (!node.data) continue;
      if (node.type !== "xContentTrigger" || node.data.mode !== CONTENT_X_TRIGGER_MODE_LIST_POSTS) continue;
      const channelId = node.data.channelId as string;
      const listId = node.data.listId as string;
      if (!channelId || !listId) continue;
      const key = `${channelId}:${listId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      watches.push({ channelId, listId });
    }
  }

  return c.json({ watches });
});

// Internal: which YouTube channelIds any published flow's youtubeContentTrigger node
// currently wants watched. link's renewal cron pulls this to decide which WebSub
// subscriptions to renew vs. let lapse — same "graph_json is the sole source of truth"
// pattern as /internal/list-watches above.
app.get("/internal/youtube-watches", async (c) => {
  const rows = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE status = 'published' AND graph_json LIKE '%youtubeContentTrigger%'`
  ).all<{ graph_json: string }>();

  const seen = new Set<string>();
  const watches: { channelId: string; subscriptionChannelId: string }[] = [];
  for (const row of rows.results) {
    let graph: FlowGraph;
    try {
      graph = JSON.parse(row.graph_json);
    } catch {
      continue;
    }
    if (!graph || !Array.isArray(graph.nodes)) continue;
    for (const node of graph.nodes) {
      if (!node.data) continue;
      if (node.type !== "youtubeContentTrigger") continue;
      const channelId = node.data.channelId as string;
      if (!channelId) continue;
      // 多订阅逐 pair 展开；旧标量经 resolver 回退后与改动前逐字节一致。
      for (const sub of resolveYouTubeSubscriptions(node.data)) {
        const key = `${channelId}:${sub.channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        watches.push({ channelId, subscriptionChannelId: sub.channelId });
      }
    }
  }

  return c.json({ watches });
});

// Internal: 哪些 (channel, repo) 被已发布 flow 的 githubContentTrigger 盯着。link 的
// 每小时 cron 拉这个来决定轮询谁 —— 与 /internal/list-watches、/internal/youtube-watches
// 同一个「graph_json 是唯一真相来源」模式：flow 里删掉节点，下一轮自然不再轮询。
app.get("/internal/github-watches", async (c) => {
  const rows = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE status = 'published' AND graph_json LIKE '%githubContentTrigger%'`
  ).all<{ graph_json: string }>();

  const seen = new Set<string>();
  const watches: { channelId: string; fullName: string }[] = [];
  for (const row of rows.results) {
    let graph: FlowGraph;
    try {
      graph = JSON.parse(row.graph_json);
    } catch {
      continue;
    }
    if (!graph || !Array.isArray(graph.nodes)) continue;
    for (const node of graph.nodes) {
      if (!node.data) continue;
      if (node.type !== "githubContentTrigger") continue;
      const channelId = node.data.channelId as string;
      if (!channelId) continue;
      for (const repo of resolveGitHubRepos(node.data)) {
        const key = `${channelId}:${repo.fullName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        watches.push({ channelId, fullName: repo.fullName });
      }
    }
  }

  return c.json({ watches });
});

// Answered locally from WEB_DB (shared/auth.ts) instead of proxying to web.
app.get("/api/auth/me", async (c) => {
  const me = await resolveAuthMe(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!me) return c.json({ error: "Unauthorized" }, 401);
  return c.json(me);
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

// Proxy X owned-lists lookup from link worker (for the xContentTrigger List Posts dropdown)
app.get("/api/channels/:channelId/x-lists", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const channelId = c.req.param("channelId");
  const res = await fetch(`${linkUrl}/api/channels/x/${channelId}/lists`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Proxy YouTube subscriptions lookup from link worker (for the youtubeContentTrigger Inspector)
app.get("/api/channels/youtube/subscriptions", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const res = await fetch(`${linkUrl}/api/channels/youtube/subscriptions`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json" } });
});

app.get("/api/channels/youtube/playlists", async (c) => {
  const linkUrl = c.env.LINK_URL;
  const res = await fetch(`${linkUrl}/api/channels/youtube/playlists`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json" } });
});

// Proxy watched-repo lookup from link worker (for the githubContentTrigger Inspector)
app.get("/api/channels/github/repos", async (c) => {
  const res = await fetch(`${c.env.LINK_URL}/api/channels/github/repos`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
});

// Proxy configured LLM providers from content worker (tenant-scoped, forwards the session cookie)
app.get("/api/llm-providers", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/llm-credentials`, {
    headers: { Cookie: c.req.raw.headers.get("Cookie") || "" },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
});

// Proxy the skill catalog from content worker (for the xContentAction Skill dropdown)
app.get("/api/skills", async (c) => {
  const res = await fetch(`${c.env.CONTENT_URL}/api/skills`, {
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

  const countRow = await c.env.FLOW_DB.prepare(
    `SELECT COUNT(*) as total FROM flows f WHERE f.tenant_id = ? AND f.domain = ?`
  )
    .bind(tenantId, domain)
    .first<{ total: number }>();
  const total = countRow?.total || 0;

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT f.id, f.name, f.description, f.status, f.member_id, f.created_at, f.updated_at, f.trigger_count, f.graph_json
     FROM flows f WHERE f.tenant_id = ? AND f.domain = ? ORDER BY f.updated_at DESC LIMIT ? OFFSET ?`
  )
    .bind(tenantId, domain, limit, offset)
    .all<{ id: string; name: string; description: string; status: string; member_id: string; created_at: string; updated_at: string; trigger_count: number | null; graph_json: string }>();

  const memberIds = [...new Set(rows.results.map(r => r.member_id).filter(Boolean))];
  let memberMap: Record<string, string> = {};
  if (memberIds.length > 0) {
    // tenant-scope-ok: memberIds are drawn only from this tenant's flows (WHERE f.tenant_id = ? above), so the id set is already tenant-scoped
    const members = await c.env.WEB_DB.prepare(
      `SELECT id, email FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`
    ).bind(...memberIds).all<{ id: string; email: string }>();
    memberMap = Object.fromEntries(members.results.map(m => [m.id, m.email]));
  }

  // 只有 published 的行才需要判定 —— draft 还没声称自己在跑。整页一行都不需要时就不打扰 link。
  const needsCheck = rows.results.some((r) => r.status === "published");
  const activeIds = needsCheck ? await fetchActiveChannelIds(c.env, tenantId) : null;

  const flows = rows.results.map(({ graph_json, ...f }) => ({
    ...f,
    member_email: memberMap[f.member_id] || "",
    // activeIds 为 null（link 不可达）时 findBrokenTrigger 一律返回 null —— fail-open。
    // 把一个租户的 flow 全标红是比几分钟的陈旧绿色更严重的误报。
    broken_trigger_type: f.status === "published" ? (findBrokenTrigger(graph_json, activeIds)?.nodeType ?? null) : null,
  }));

  return c.json({ flows, total, page, totalPages: Math.ceil(total / limit) });
});

// Create flow
app.post("/api/flows", async (c) => {
  const tenantId = c.get("tenantId");
  const memberId = c.get("memberId");
  const body = await c.req.json<{ name?: string; description?: string; graph_json?: string; domain?: string }>().catch(() => ({ name: undefined, description: undefined, graph_json: undefined, domain: undefined }));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = body.name || "Untitled Flow";
  const description = body.description || "";
  const graphJson = body.graph_json || '{"nodes":[],"edges":[]}';
  // Fixed at creation and never updated afterwards — see migration 0014.
  const domain = body.domain === "content" ? "content" : "user";

  const invalidIds = findInvalidNodeIds(graphJson);
  if (invalidIds.length > 0) {
    return c.json({ error: `Invalid node id(s): ${invalidIds.join(", ")}` }, 400);
  }

  await c.env.FLOW_DB.prepare(
    `INSERT INTO flows (id, tenant_id, member_id, name, description, graph_json, domain, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(id, tenantId, memberId, name, description, graphJson, domain, now, now)
    .run();

  return c.json({ flow: { id, name, description, domain } }, 201);
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
  if (body.graph_json !== undefined) {
    const invalidIds = findInvalidNodeIds(body.graph_json);
    if (invalidIds.length > 0) {
      return c.json({ error: `Invalid node id(s): ${invalidIds.join(", ")}` }, 400);
    }
    sets.push("graph_json = ?"); params.push(body.graph_json);
  }
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

  // tenant-scope-ok: ownership already proven by the tenant-scoped DELETE above (404 on 0 changes)
  await c.env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = ?`).bind(flowId).run();

  return c.json({ ok: true });
});

// Publish flow
app.post("/api/flows/:id/publish", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");

  const flow = await c.env.FLOW_DB.prepare(
    `SELECT graph_json FROM flows WHERE id = ? AND tenant_id = ?`
  ).bind(flowId, tenantId).first<{ graph_json: string }>();
  if (!flow) return c.json({ error: "Not found" }, 404);

  // cronTrigger 之类不绑 channel 的 flow 不问 link —— 它的可发布性与 link 无关，
  // 不该因为 link 抖动就发布不了。
  if (triggerBindsChannel(flow.graph_json)) {
    const activeIds = await fetchActiveChannelIds(c.env, tenantId);
    // 列表页在这里 fail-open，publish 不行：publish 是一次离散的用户动作，当场能提示重试，
    // 而带着未经验证的状态发布出去正是这个 gate 要防的事。
    if (!activeIds) {
      return c.json({ error: "Cannot verify channel status right now. Please try again." }, 503);
    }
    const broken = findBrokenTrigger(flow.graph_json, activeIds);
    if (broken) return c.json({ error: brokenTriggerMessage(broken.nodeType) }, 400);
  }

  // 排在 channel 门之后：账号没连是更根本的一步，两个问题同时存在时先说账号。
  // 这一条不问 link（纯本地判据），但直连 API 发布同样绕不开它 —— 前端的
  // findGitHubTriggerNoRepoIds 只挡住 UI 那条路径。
  const noRepo = findGitHubTriggerNoRepos(flow.graph_json);
  if (noRepo) return c.json({ error: githubNoRepoMessage() }, 400);

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

  const result = await c.env.FLOW_DB.prepare(
    `UPDATE flows SET status = 'draft', updated_at = ? WHERE id = ? AND tenant_id = ?`
  ).bind(new Date().toISOString(), flowId, tenantId).run();

  // Gate the flow_pending cleanup on ownership, exactly as DELETE /api/flows/:id
  // does: without the changes check, a caller passing another tenant's flowId
  // would fall through to a cross-tenant DELETE FROM flow_pending WHERE flow_id = ?.
  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);

  // tenant-scope-ok: ownership already proven by the tenant-scoped UPDATE above (404 on 0 changes)
  await c.env.FLOW_DB.prepare(`DELETE FROM flow_pending WHERE flow_id = ?`).bind(flowId).run();
  return c.json({ ok: true });
});

// Analytics: node counts (from precomputed flow_counts/content_flow_counts)
app.get("/api/flows/:id/analytics", async (c) => {
  const flowId = c.req.param("id");
  const tenantId = c.get("tenantId");

  const isContentDomain = await isContentDomainFlow(c.env, flowId, tenantId);
  if (isContentDomain === null) return c.json({ nodes: {} });
  const table = isContentDomain ? "content_flow_counts" : "flow_counts";

  const rows = await c.env.FLOW_DB.prepare(
    `SELECT node_id, direction, count FROM ${table} WHERE tenant_id = ? AND flow_id = ?`
  ).bind(Number(tenantId), flowId).all<{ node_id: string; direction: string; count: number }>();

  const nodes: Record<string, { enter: number; exit: number }> = {};
  for (const r of rows.results) {
    if (!nodes[r.node_id]) nodes[r.node_id] = { enter: 0, exit: 0 };
    if (r.direction === "enter") nodes[r.node_id].enter = r.count;
    if (r.direction === "exit") nodes[r.node_id].exit = r.count;
  }
  return c.json({ nodes });
});

// flow.id is always crypto.randomUUID() — set server-side at creation (POST /api/flows) and
// never accepted from the client — so the strict UUID shape is a safe invariant for it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Node logs: list which users/content items entered a specific node (two-step: R2 for the
// log rows, then a D1 lookup for names — cross-table JOIN in R2 SQL is untested in this
// codebase, so this avoids relying on it).
app.get("/api/flows/:id/nodes/:nodeId/logs", async (c) => {
  const tenantId = c.get("tenantId");
  const flowId = c.req.param("id");
  const nodeId = c.req.param("nodeId");
  if (!UUID_RE.test(flowId) || !NODE_ID_RE.test(nodeId)) return c.json({ logs: [] });

  try {
    const isContentDomain = await isContentDomainFlow(c.env, flowId, tenantId);
    if (isContentDomain === null) return c.json({ logs: [] });

    const rows = await queryNodeLogRows(
      c.env,
      isContentDomain ? "uniscrm.content_flow_log" : "uniscrm.flow_log",
      isContentDomain ? "content_id" : "user_id",
      Number(tenantId),
      flowId,
      nodeId
    );
    if (rows.length === 0) return c.json({ logs: [] });

    if (isContentDomain) {
      // Rows arrive ordered by created_at DESC; a content_id can have both an "enter" row
      // (outcome unresolved yet) and a later "outcome" row (same title/content_text/content_url,
      // since both come from the same payload batch) — keep only the first (= latest) occurrence
      // per content_id, which is the outcome row whenever one exists. No D1 join: every display
      // field now lives directly on the R2 row.
      const seen = new Set<string>();
      const logs = [];
      for (const r of rows) {
        if (seen.has(r.subjectId)) continue;
        seen.add(r.subjectId);
        logs.push({
          content_id: r.subjectId,
          created_at: r.created_at,
          outcome: r.outcome ?? undefined,
          failure_reason: r.failure_reason,
          title: r.title,
          content_text: r.content_text,
          content_url: r.content_url,
        });
      }
      return c.json({ logs });
    }

    // Same collapse the content branch does: rows are created_at DESC, and a user_id can have
    // both an "enter" row and a later "outcome" row for the same node — keep only the first
    // (= latest) occurrence, so the outcome (and its failure_reason) wins whenever one exists.
    const seen = new Set<string>();
    const latest: typeof rows = [];
    for (const r of rows) {
      if (seen.has(r.subjectId)) continue;
      seen.add(r.subjectId);
      latest.push(r);
    }

    // Display names are decorative — the row's user_id, timestamp and outcome are the payload.
    // getUserNames (via r2Query) throws on any R2 SQL failure rather than returning [] — that's
    // the right default everywhere else, but here it must degrade to "no names" instead of
    // blanking the entire drawer, so this one narrow spot deliberately catches it.
    let nameMap = new Map<string, string | null>();
    try {
      nameMap = await getUserNames(c.env, Number(tenantId), latest.map((r) => r.subjectId));
    } catch (e) {
      console.error(JSON.stringify({ event: "node_logs_name_lookup_failed", tenantId, flowId, nodeId, error: String(e) }));
    }

    const logs = latest.map((r) => ({
      user_id: r.subjectId,
      name: nameMap.get(r.subjectId) ?? null,
      created_at: r.created_at,
      outcome: r.outcome ?? undefined,
      failure_reason: r.failure_reason,
    }));
    return c.json({ logs });
  } catch (e) {
    console.error(JSON.stringify({ event: "node_logs_error", tenantId, flowId, nodeId, error: String(e) }));
    return c.json({ logs: [] });
  }
});

app.post("/api/flows/generate", async (c) => {
  const { prompt, currentContext, currentGraph, domain } = await c.req.json<{
    prompt: string;
    currentContext?: any;
    currentGraph?: any;
    domain?: string;
  }>();
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const flowDomain: FlowDomain = domain === "content" ? "content" : "user";
  const ctx = currentContext || currentGraph;
  const hasContext = ctx && (Array.isArray(ctx.nodes) ? ctx.nodes.length > 0 : Object.keys(ctx).length > 0);
  const userMessage = hasContext
    ? `Current flow: ${JSON.stringify(ctx)}\n\nUser request: ${prompt}`
    : `Create a new flow: ${prompt}`;

  try {
    const stream = await c.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
      messages: [
        { role: "system", content: buildFlowGenerateSystemPrompt(flowDomain) },
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const accept = request.headers.get("Accept") || "";
    const loginRedirect = await spaLoginGuard(request, env.WEB_DB, env.WEB_URL);
    if (loginRedirect) return loginRedirect;

    if (!url.pathname.startsWith("/api") && env.ASSETS) {
      // Clone before probing ASSETS: Fetcher.fetch() locks/consumes the Request body it's
      // given (confirmed empirically — reproduces in vitest-pool-workers' workerd, so this is
      // real production behavior too), which would otherwise leave nothing for app.fetch()
      // below to read on a POST body once ASSETS 404s (e.g. /internal/* routes, none of which
      // are static assets). The clone's body is what gets locked; `request` itself stays intact.
      const assetRes = await env.ASSETS.fetch(request.clone() as Request);
      if (assetRes.status !== 404) return assetRes;
    }

    const res = await app.fetch(request, env);
    if (res.status === 404 && accept.includes("text/html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }
    return res;
  },

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const { tenantId, eventType, userId, contentId, channelId, listId, subscriptionChannelId, repoFullName, payload } = message.body as FlowQueueMessage;

        const rows = await env.FLOW_DB.prepare(
          `SELECT id, graph_json FROM flows WHERE tenant_id = ? AND status = 'published'`
        )
          .bind(tenantId)
          .all<{ id: string; graph_json: string }>();

        if (contentId) {
          const matchPayload = {
            ...payload,
            channel_id: channelId,
            ...(listId ? { list_id: listId } : {}),
            ...(subscriptionChannelId ? { subscription_channel_id: subscriptionChannelId } : {}),
            ...(repoFullName ? { repo_full_name: repoFullName } : {}),
          };
          for (const flow of rows.results) {
            const graph: FlowGraph = JSON.parse(flow.graph_json);
            const result = executeFlow(graph, eventType, matchPayload);
            // 加工后的 payload —— githubContentTrigger 在这里才拿到三个计数。用原始的
            // matchPayload 会让等待恢复后的条件读不到计数（fail-closed 静默不通过）。
            const flowPayload = result.payload;
            if (result.nodeLogs.length > 0) await emitContentNodeLogs(result.nodeLogs, flow.id, contentId, tenantId, env, flowPayload);
            if (result.actions.length > 0) {
              const { rateLimited } = await executeContentActions(graph, result.actions, contentId, channelId, tenantId, env, flowPayload, flow.id);
              for (const rl of rateLimited) {
                await env.FLOW_DB.prepare(
                  `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                   VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
                ).bind(crypto.randomUUID(), flow.id, contentId, tenantId, JSON.stringify(flowPayload), rl.retryAt, new Date().toISOString(), JSON.stringify(rl.action)).run();
              }
              console.log(JSON.stringify({ event: "content_flow_matched", flowId: flow.id, contentId, eventType, actions: result.actions, rateLimited: rateLimited.length }));
            }

            for (const wait of result.pendingWaits) {
              const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
              // Stash channelId inside the stored payload (under channel_id) — content_flow_pending
              // has no channel_id column of its own, and the resume path in scheduled() (Task 6)
              // needs the source channel to execute repost/xContentAction once the wait elapses.
              // condition_logic 与 conditions 同源快照一起写（migrations/0017）——此前只写
              // conditions，OR 组在 sweep 解析时会被错当成 AND。
              await env.FLOW_DB.prepare(
                `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                crypto.randomUUID(), flow.id, wait.nodeId, contentId, tenantId,
                JSON.stringify(flowPayload), executeAt, new Date().toISOString(), wait.awaitingEvent || "",
                wait.conditions ? JSON.stringify(wait.conditions) : "",
                wait.conditionLogic || ""
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

        const matchPayload = { ...payload, channel_id: channelId };
        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, matchPayload);
          if (result.nodeLogs.length > 0) await emitNodeLogs(result.nodeLogs, flow.id, userId, Number(tenantId), env);

          if (result.actions.length > 0) {
            const { stmts: actionStmts, rateLimited: rl, nodeLogs } = await executeActions(result.actions, userId, tenantId, env, payload, flow.id, graph);
            if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, flow.id, userId, Number(tenantId), env);
            const stmts: D1PreparedStatement[] = [...actionStmts];

            for (const r of rl) {
              stmts.push(env.FLOW_DB.prepare(
                `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                 VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
              ).bind(crypto.randomUUID(), flow.id, userId, tenantId, JSON.stringify(payload), r.retryAt, new Date().toISOString(), JSON.stringify(r.action)));
            }

            if (stmts.length > 0) await env.FLOW_DB.batch(stmts);
            console.log(JSON.stringify({ event: "flow_matched", flowId: flow.id, userId, eventType, actions: result.actions, rateLimited: rl.length }));
          }

          for (const wait of result.pendingWaits) {
            const executeAt = new Date(Date.now() + wait.durationMs).toISOString();
            await env.FLOW_DB.prepare(
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(), flow.id, wait.nodeId, userId, tenantId,
              JSON.stringify(payload), executeAt, new Date().toISOString(), wait.awaitingEvent || "",
              wait.conditions ? JSON.stringify(wait.conditions) : "",
              wait.conditionLogic || ""
            ).run();
            console.log(JSON.stringify({ event: "flow_wait_scheduled", flowId: flow.id, nodeId: wait.nodeId, executeAt, awaitingEvent: wait.awaitingEvent || "" }));
          }
        }

        // Resolve any pending Wait-for-Event waits that match this event
        const pendingMatches = await env.FLOW_DB.prepare(
          `SELECT id, flow_id, node_id, user_id, tenant_id, payload, conditions, condition_logic FROM flow_pending
           WHERE user_id = ? AND awaiting_event = ? AND execute_at > ?`
        )
          .bind(userId, eventType, new Date().toISOString())
          .all<{ id: string; flow_id: string; node_id: string; user_id: string; tenant_id: string; payload: string; conditions: string; condition_logic: string }>();

        for (const pending of pendingMatches.results) {
          // conditions 与 logic 都取自建 wait 时的快照，不看 live graph——等待期间用户改了
          // flow，不能让旧条件套上新逻辑。
          // JSON.parse 必须被 try 包住：坏 JSON 抛出去会让整条队列消息重试，把这一批里
          // 已经执行过的 action 全部重跑。降级成"没有条件"是可接受的最坏情况，崩溃不是。
          let snapshotConditions: unknown = [];
          try {
            snapshotConditions = pending.conditions ? JSON.parse(pending.conditions) : [];
          } catch {
            snapshotConditions = [];
          }
          // 不再用 `if (pending.conditions)` 做前置守卫：OR + 0 条恒不通过是有语义的，
          // 跳过检查会把它错当成放行。conditionsPass 自己处理空集。
          // 顺带改了空 field 半成品行的语义（design doc §1.2）：这里改动前是裸的
          // `conditions.every((c) => evaluateCondition(c.field, ...))`，没有任何空 field 跳过——
          // 一条带半成品空白条件行的 waitForEvent 此前 evaluateCondition("", ...) 恒 false，
          // 永远无法解析、只会超时走 "No"。统一到 conditionsPass 之后空 field 行被过滤掉，
          // 其余条件正常求值——这是知情接受的行为变化，见 design doc，不是本次改动的意外副作用。
          if (!conditionsPass(snapshotConditions, pending.condition_logic, payload)) continue;

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
            const { stmts: actionStmts, rateLimited: rl, nodeLogs } = await executeActions(result.actions, pending.user_id, pending.tenant_id, env, pendingPayload, pending.flow_id, graph);
            if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, pending.flow_id, pending.user_id, Number(pending.tenant_id), env);
            stmts.push(...actionStmts);
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

    await recomputeFlowCounts(env).catch((e) => {
      console.error(JSON.stringify({ event: "flow_counts_recompute_fatal", error: String(e) }));
    });

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
              const { stmts, nodeLogs } = await executeActions(result.actions, "", flow.tenant_id, env, {}, flow.id, graph);
              if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, flow.id, "", Number(flow.tenant_id), env);
              if (stmts.length > 0) await env.FLOW_DB.batch(stmts);
              console.log(JSON.stringify({ event: "cron_trigger_fired", flowId: flow.id, actions: result.actions.length }));
            }
          }
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "cron_trigger_error", flowId: flow.id, error: String(e) }));
      }
    }

    // content_flow_pending sweep: resumes wait/timeCondition/abSplit nodes downstream of a
    // xContentTrigger, mirroring the flow_pending sweep below but for the content domain
    // (executeContentActions, keyed by content_id instead of user_id).
    // Placed before the flow_pending sweep (rather than strictly after it, per the plan) so that
    // the flow_pending sweep's own early return on an empty flow_pending table can't skip this
    // block — the two sweeps are independent (different tables), so order between them doesn't
    // matter functionally.
    const contentPending = await env.FLOW_DB.prepare(
      `SELECT id, flow_id, node_id, content_id, tenant_id, payload, awaiting_event, conditions, condition_logic, retry_action, retry_count FROM content_flow_pending WHERE execute_at <= ?`
    )
      .bind(now)
      .all<{ id: string; flow_id: string; node_id: string; content_id: string; tenant_id: string; payload: string; awaiting_event: string; conditions: string; condition_logic: string; retry_action: string; retry_count: number }>();

    // content sweep 三个分支解析点（xVideoStatusPoll 兑现、重试耗尽、到期 claim）共用的
    // recordBranchOutcome 绑定：storedPayload 直接复用行里已有的原串（channel_id 早已混在
    // 里面），嵌套 rateLimited 落成 retry_action 行——与改动前各点内联的行为逐字一致。
    const contentSweepOps = (
      row: { flow_id: string; content_id: string; tenant_id: string; payload: string },
      graph: FlowGraph,
      payload: Record<string, unknown>,
      channelId: string
    ): OutcomeEpilogueOps => ({
      table: "content_flow_pending",
      subjectColumn: "content_id",
      subjectId: row.content_id,
      tenantId: row.tenant_id,
      flowId: row.flow_id,
      storedPayload: row.payload,
      emitLogs: (logs) => emitContentNodeLogs(logs, row.flow_id, row.content_id, row.tenant_id, env, payload),
      runActions: async (resumedActions) => {
        const { rateLimited: nestedRateLimited } = await executeContentActions(graph, resumedActions, row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);
        for (const rl of nestedRateLimited) {
          await env.FLOW_DB.prepare(
            `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
             VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
          ).bind(crypto.randomUUID(), row.flow_id, row.content_id, row.tenant_id, row.payload, rl.retryAt, now, JSON.stringify(rl.action)).run();
        }
      },
    });

    for (const row of contentPending.results) {
      try {
        if (row.retry_action) {
          const action = JSON.parse(row.retry_action) as ActionResult;
          const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(row.flow_id)
            .first<{ graph_json: string; status: string }>();
          if (!flow || flow.status !== "published") {
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            continue;
          }
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const payload = JSON.parse(row.payload);
          const channelId = String(payload.channel_id ?? "");

          if (action.type === "xVideoStatusPoll") {
            const statusRes = await fetch(`${env.LINK_URL}/internal/content/x-video-status`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
              body: JSON.stringify({ channelId: action.channelId, mediaId: action.mediaId, text: action.text, contentId: row.content_id, flowId: row.flow_id }),
            });
            // A non-JSON body here is link crashing mid-request (e.g. an uncaught token-refresh
            // throw becoming a plain-text 500) — synthesize a reason so the node log never shows
            // a failed outcome with a blank failure_reason again.
            const statusBody = await statusRes.json().catch(() => ({
              ok: false,
              reason: `x_video_status_unreachable: HTTP ${statusRes.status} non-JSON response from link`,
            })) as { ok?: boolean; pending?: boolean; checkAfterSecs?: number; rateLimited?: boolean; rateLimitReset?: string; reason?: string };

            if (statusBody.pending && row.retry_count < 5) {
              const nextAt = new Date(Date.now() + Math.max(statusBody.checkAfterSecs || 60, 60) * 1000).toISOString();
              await env.FLOW_DB.prepare(
                `UPDATE content_flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
              ).bind(nextAt, row.retry_count + 1, row.id).run();
              console.log(JSON.stringify({ event: "x_video_poll_rescheduled", id: row.id, retryCount: row.retry_count + 1 }));
              continue;
            }

            // A 429 on the final createPost is transient, not a video failure — reschedule like
            // pending does ("Rate limit重试耗尽后才走failed分支").
            if (statusBody.rateLimited && row.retry_count < 5) {
              const nextAt = statusBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString();
              await env.FLOW_DB.prepare(
                `UPDATE content_flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
              ).bind(nextAt, row.retry_count + 1, row.id).run();
              console.log(JSON.stringify({ event: "x_video_poll_rate_limited", id: row.id, retryCount: row.retry_count + 1 }));
              continue;
            }

            const branch = !statusBody.pending && !statusBody.rateLimited && statusBody.ok ? "success" : "failed";
            const failureReason = branch === "success" ? undefined
              : statusBody.pending ? `video_processing_timeout: X still processing after ${row.retry_count + 1} polls`
              : statusBody.rateLimited ? `rate_limit_exhausted: still rate limited after ${row.retry_count + 1} retries`
              : statusBody.reason;
            await recordBranchOutcome(env, graph, action.nodeId as string, payload, branch, failureReason, contentSweepOps(row, graph, payload, channelId));
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
            console.log(JSON.stringify({ event: statusBody.pending ? "x_video_poll_exhausted" : "x_video_poll_resolved", id: row.id, branch }));
            continue;
          }

          const { rateLimited } = await executeContentActions(graph, [action], row.content_id, channelId, row.tenant_id, env, payload, row.flow_id);

          if (rateLimited.length > 0 && row.retry_count < 5) {
            await env.FLOW_DB.prepare(
              `UPDATE content_flow_pending SET execute_at = ?, retry_count = ? WHERE id = ?`
            ).bind(rateLimited[0].retryAt, row.retry_count + 1, row.id).run();
            console.log(JSON.stringify({ event: "content_flow_retry_rescheduled", id: row.id, retryCount: row.retry_count + 1 }));
          } else {
            if (rateLimited.length > 0) {
              // Retries exhausted (retry_count >= 5, still rate-limited): resolve the "failed"
              // branch downstream of the retried action, mirroring the resolved-branch handling
              // below (lines ~983-1004) — mustn't just drop the row per flow/CLAUDE.md's
              // "Rate limit重试耗尽后才走failed分支" rule.
              await recordBranchOutcome(env, graph, action.nodeId as string, payload, "failed", `rate_limit_exhausted: still rate limited after ${row.retry_count + 1} retries`, contentSweepOps(row, graph, payload, channelId));
              console.log(JSON.stringify({ event: "content_flow_retry_exhausted", id: row.id, retryCount: row.retry_count }));
            }
            await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
          }
          continue;
        }

        const claim = await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE id = ?`).bind(row.id).run();
        if (!claim.meta.changes) continue;

        const flow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
          .bind(row.flow_id)
          .first<{ graph_json: string; status: string }>();
        if (!flow || flow.status !== "published") continue;

        const graph: FlowGraph = JSON.parse(flow.graph_json);
        const payload = JSON.parse(row.payload);
        // Neither node dispatched to the video queue has a "no" branch — videoAction has
        // "success"/"failed", videoCondition has "true"/"false"/"failed" — so if its
        // content_flow_pending row times out (queue consumer never called back into
        // /internal/video-action/resume), resolving the old hardcoded "no" branch silently
        // no-ops (no edge matches sourceHandle "no") and the flow dies without a trace.
        // Node.type is generically "action" for videoAction nodes (see flow/nodeTypeRegistry.ts:
        // videoAction's reactFlowType is "action"), with the specific action identity in
        // data.actionType; videoCondition keeps its own node type.
        const timedOutNode = graph.nodes.find((n) => n.id === row.node_id);
        const isTimedOutVideoJob =
          (timedOutNode?.type === "action" && timedOutNode?.data?.actionType === "videoAction") ||
          timedOutNode?.type === "videoCondition";
        let branch: string | undefined;
        if (isTimedOutVideoJob) {
          branch = "failed";
        } else if (row.awaiting_event) {
          // content 域没有事件驱动的 wait 解析（content.created 每次都带全新的 content_id，
          // 不存在"同一主体的后续事件"能像 user 域那样按 user_id 命中 pending 行），所以
          // sweep 到期就是 waitForEvent 条件快照的唯一求值点：对行里存的流 payload props
          // 求值，通过走 "yes"，不通过走 "no"。快照语义与 user 域的 queue 解析逐字一致
          // （条件与 AND/OR 逻辑同源快照、不看 live graph；坏 JSON 降级为"没有条件"而不是
          // 抛出让整个 sweep 回合报错；空集落在 AND/OR 的恒等元上——AND 放行、OR 恒不过）。
          // 此前这里硬编码 "no"，conditions 列写了却没人读。
          let snapshotConditions: unknown = [];
          try {
            snapshotConditions = row.conditions ? JSON.parse(row.conditions) : [];
          } catch {
            snapshotConditions = [];
          }
          branch = conditionsPass(snapshotConditions, row.condition_logic, payload) ? "yes" : "no";
        }
        const channelId = String(payload.channel_id ?? "");
        await recordBranchOutcome(env, graph, row.node_id, payload, branch, undefined, contentSweepOps(row, graph, payload, channelId));
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
          // A retried action's success/failed branch has to continue like any other action's, so
          // the graph is loaded here too. A retry row for a flow that has since been unpublished
          // or deleted still executes (that was always true), just without branch continuation.
          const retryFlow = await env.FLOW_DB.prepare(`SELECT graph_json, status FROM flows WHERE id = ?`)
            .bind(row.flow_id).first<{ graph_json: string; status: string }>();
          const retryGraph = retryFlow && retryFlow.status === "published"
            ? JSON.parse(retryFlow.graph_json) as FlowGraph : undefined;
          const retryPayload = JSON.parse(row.payload || "{}");
          const { stmts: actionStmts, rateLimited: rl, nodeLogs } = await executeActions([action], retryUserId, row.tenant_id, env, retryPayload, row.flow_id, retryGraph);
          if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, row.flow_id, retryUserId, Number(row.tenant_id), env);

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
              // Retries exhausted, still rate limited — flow/CLAUDE.md: "Rate limit重试耗尽后才走
              // failed分支". Until now this branch only logged, so a rate-limited action that ran
              // out of retries left the flow dead with no outcome row at all.
              const retryNodeId = action.nodeId as string | undefined;
              if (retryGraph && retryNodeId) {
                const failedResult = resumeFromNode(retryGraph, retryNodeId, retryPayload, "failed", `rate_limit_exhausted: still rate limited after ${row.retry_count + 1} retries`);
                if (failedResult.nodeLogs.length > 0) await emitNodeLogs(failedResult.nodeLogs, row.flow_id, retryUserId, Number(row.tenant_id), env);
                if (failedResult.actions.length > 0) {
                  const nested = await executeActions(failedResult.actions, retryUserId, row.tenant_id, env, retryPayload, row.flow_id, retryGraph, 1);
                  if (nested.nodeLogs.length > 0) await emitNodeLogs(nested.nodeLogs, row.flow_id, retryUserId, Number(row.tenant_id), env);
                  if (nested.stmts.length > 0) await env.FLOW_DB.batch(nested.stmts);
                  for (const r of nested.rateLimited) {
                    await env.FLOW_DB.prepare(
                      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, retry_action, retry_count)
                       VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0)`
                    ).bind(crypto.randomUUID(), row.flow_id, retryUserId, row.tenant_id, row.payload, r.retryAt, now, JSON.stringify(r.action)).run();
                  }
                }
                for (const wait of failedResult.pendingWaits) {
                  await env.FLOW_DB.prepare(
                    `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                  ).bind(
                    crypto.randomUUID(), row.flow_id, wait.nodeId, retryUserId, row.tenant_id, row.payload,
                    new Date(Date.now() + wait.durationMs).toISOString(), now,
                    wait.awaitingEvent || "", wait.conditions ? JSON.stringify(wait.conditions) : "",
                    wait.conditionLogic || ""
                  ).run();
                }
              }
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
          const { stmts: actionStmts, rateLimited: rl, nodeLogs } = await executeActions(result.actions, row.user_id, row.tenant_id, env, payload, row.flow_id, graph);
          if (nodeLogs.length > 0) await emitNodeLogs(nodeLogs, row.flow_id, row.user_id, Number(row.tenant_id), env);
          stmts.push(...actionStmts);
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
              // conditions 与 condition_logic 都必须写：此前这一处只写 awaiting_event，
              // 于是 sweep 里重新排期的 waitForEvent 会被任意匹配事件唤醒，用户设的条件
              // 全部失效。其余三处 INSERT 一直是写的，只有这里漏了。
              `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, created_at, awaiting_event, conditions, condition_logic)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              crypto.randomUUID(), row.flow_id, wait.nodeId, row.user_id, row.tenant_id, row.payload,
              executeAt, now, wait.awaitingEvent || "",
              wait.conditions ? JSON.stringify(wait.conditions) : "",
              wait.conditionLogic || ""
            )
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
