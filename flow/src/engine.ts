export interface FlowNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface PendingWait {
  nodeId: string;
  durationMs: number;
}

export interface ActionResult {
  type: string;
  [key: string]: unknown;
}

export interface ExecutionResult {
  matched: boolean;
  actions: ActionResult[];
  pendingWaits: PendingWait[];
}

export interface EngineContext {
  db?: D1Database;
  userId?: string;
  triggerTime?: string;
}

function resolveValue(value: string, payload: Record<string, unknown>): number | null {
  if (!value.includes("$")) return parseFloat(value);

  const expr = value.replace(/\$(\w+)/g, (_, field) => {
    const v = payload[field];
    if (v === undefined || v === null) return "NaN";
    return String(Number(v));
  });

  if (expr.includes("NaN")) return null;
  return evaluateExpr(expr);
}

function evaluateExpr(expr: string): number {
  const tokens: (number | string)[] = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === " ") { i++; continue; }
    if ("+-*/()".includes(expr[i])) {
      tokens.push(expr[i]);
      i++;
    } else {
      let num = "";
      while (i < expr.length && (expr[i] >= "0" && expr[i] <= "9" || expr[i] === "." || (expr[i] === "-" && num === ""))) {
        num += expr[i];
        i++;
      }
      tokens.push(parseFloat(num));
    }
  }

  let pos = 0;
  function parseExprInner(): number {
    let result = parseTerm();
    while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
      const op = tokens[pos++];
      const right = parseTerm();
      result = op === "+" ? result + right : result - right;
    }
    return result;
  }
  function parseTerm(): number {
    let result = parseFactor();
    while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
      const op = tokens[pos++];
      const right = parseFactor();
      result = op === "*" ? result * right : result / right;
    }
    return result;
  }
  function parseFactor(): number {
    if (tokens[pos] === "(") {
      pos++;
      const result = parseExprInner();
      pos++;
      return result;
    }
    return tokens[pos++] as number;
  }

  return parseExprInner();
}

export function evaluateCondition(
  field: string,
  operator: string,
  value: string,
  payload: Record<string, unknown>
): boolean {
  const actual = payload[field];
  if (actual === undefined || actual === null) return false;

  const actualStr = String(actual);

  if (value.includes(",") && !value.includes("$")) {
    const values = value.split(",");
    if (operator === "==") return values.includes(actualStr);
    if (operator === "!=") return !values.includes(actualStr);
  }

  switch (operator) {
    case "==":
      return actualStr === value;
    case "!=":
      return actualStr !== value;
    case ">":
    case "<":
    case ">=":
    case "<=": {
      const resolved = resolveValue(value, payload);
      if (resolved === null) return false;
      const actualNum = parseFloat(actualStr);
      if (operator === ">") return actualNum > resolved;
      if (operator === "<") return actualNum < resolved;
      if (operator === ">=") return actualNum >= resolved;
      return actualNum <= resolved;
    }
    case "contains":
      return actualStr.includes(value);
    default:
      return false;
  }
}

async function checkEventHistory(
  db: D1Database,
  userId: string,
  eventType: string,
  channelId: string,
  sinceTime: string
): Promise<boolean> {
  let sql: string;
  let params: string[];

  if (channelId) {
    sql = `SELECT 1 FROM event WHERE user_id = ? AND event_type = ? AND channel_id = ? AND created_at > ? LIMIT 1`;
    params = [userId, eventType, channelId, sinceTime];
  } else {
    sql = `SELECT 1 FROM event WHERE user_id = ? AND event_type = ? AND created_at > ? LIMIT 1`;
    params = [userId, eventType, sinceTime];
  }

  const row = await db.prepare(sql).bind(...params).first();
  return row !== null;
}

export function executeFlow(
  graph: FlowGraph,
  eventType: string,
  payload: Record<string, unknown>
): ExecutionResult {
  const triggerNodes = graph.nodes.filter(
    (n) => n.type === "trigger" && (n.data.eventType === eventType || n.data.triggerType === eventType)
  );

  if (triggerNodes.length === 0) return { matched: false, actions: [], pendingWaits: [] };

  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];

  for (const trigger of triggerNodes) {
    collectActionsSync(graph, trigger.id, payload, actions, pendingWaits);
  }

  return { matched: actions.length > 0 || pendingWaits.length > 0, actions, pendingWaits };
}

export async function resumeFromNode(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  ctx: EngineContext
): Promise<ExecutionResult> {
  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];
  await collectActionsAsync(graph, nodeId, payload, actions, pendingWaits, ctx);
  return { matched: actions.length > 0 || pendingWaits.length > 0, actions, pendingWaits };
}

function durationToMs(duration: number, unit: string): number {
  switch (unit) {
    case "minutes": return duration * 60 * 1000;
    case "hours": return duration * 60 * 60 * 1000;
    case "days": return duration * 24 * 60 * 60 * 1000;
    default: return duration * 60 * 1000;
  }
}

function collectActionsSync(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  actions: ActionResult[],
  pendingWaits: PendingWait[]
): void {
  const outEdges = graph.edges.filter((e) => e.source === nodeId);

  for (const edge of outEdges) {
    const targetNode = graph.nodes.find((n) => n.id === edge.target);
    if (!targetNode) continue;

    if (targetNode.type === "action") {
      const actionType = targetNode.data.actionType as string;
      const actionData: ActionResult = { type: actionType };
      if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
      if (actionType === "xAction") { actionData.xEvent = targetNode.data.xEvent as string; actionData.channelId = targetNode.data.channelId as string; }
      actions.push(actionData);
      continue;
    }

    if (targetNode.type === "wait") {
      const duration = Number(targetNode.data.duration || 0);
      const unit = String(targetNode.data.unit || "minutes");
      if (duration > 0) {
        pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit) });
      }
      continue;
    }

    if (targetNode.type === "condition" || targetNode.type === "eventHistory") {
      if (targetNode.type === "eventHistory") {
        // Event history conditions are skipped in sync mode (only evaluated after Wait)
        continue;
      }

      const { field, operator, value } = targetNode.data as {
        field?: string; operator?: string; value?: string;
      };

      if (!field || !operator || value === undefined || value === "") {
        collectActionsSync(graph, targetNode.id, payload, actions, pendingWaits);
        continue;
      }

      if (evaluateCondition(field, operator, String(value), payload)) {
        collectActionsSync(graph, targetNode.id, payload, actions, pendingWaits);
      }
    }
  }
}

async function collectActionsAsync(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  actions: ActionResult[],
  pendingWaits: PendingWait[],
  ctx: EngineContext
): Promise<void> {
  const outEdges = graph.edges.filter((e) => e.source === nodeId);

  for (const edge of outEdges) {
    const targetNode = graph.nodes.find((n) => n.id === edge.target);
    if (!targetNode) continue;

    if (targetNode.type === "action") {
      const actionType = targetNode.data.actionType as string;
      const actionData: ActionResult = { type: actionType };
      if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
      if (actionType === "xAction") { actionData.xEvent = targetNode.data.xEvent as string; actionData.channelId = targetNode.data.channelId as string; }
      actions.push(actionData);
      continue;
    }

    if (targetNode.type === "wait") {
      const duration = Number(targetNode.data.duration || 0);
      const unit = String(targetNode.data.unit || "minutes");
      if (duration > 0) {
        pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit) });
      }
      continue;
    }

    if (targetNode.type === "eventHistory") {
      const checkEventType = targetNode.data.eventType as string;
      const channelId = targetNode.data.channelId as string || "";

      if (!checkEventType || !ctx.db || !ctx.userId || !ctx.triggerTime) continue;

      const hasEvent = await checkEventHistory(ctx.db, ctx.userId, checkEventType, channelId, ctx.triggerTime);
      const branch = hasEvent ? "yes" : "no";

      const branchEdges = graph.edges.filter((e) => e.source === targetNode.id && e.sourceHandle === branch);
      for (const branchEdge of branchEdges) {
        const nextNode = graph.nodes.find((n) => n.id === branchEdge.target);
        if (!nextNode) continue;

        if (nextNode.type === "action") {
          const actionType = nextNode.data.actionType as string;
          const actionData: ActionResult = { type: actionType };
          if (actionType === "addToList") actionData.listId = nextNode.data.listId as string;
          if (actionType === "xAction") { actionData.xEvent = nextNode.data.xEvent as string; actionData.channelId = nextNode.data.channelId as string; }
          actions.push(actionData);
        } else {
          await collectActionsAsync(graph, nextNode.id, payload, actions, pendingWaits, ctx);
        }
      }
      continue;
    }

    if (targetNode.type === "condition") {
      const { field, operator, value } = targetNode.data as {
        field?: string; operator?: string; value?: string;
      };

      if (!field || !operator || value === undefined || value === "") {
        await collectActionsAsync(graph, targetNode.id, payload, actions, pendingWaits, ctx);
        continue;
      }

      if (evaluateCondition(field, operator, String(value), payload)) {
        await collectActionsAsync(graph, targetNode.id, payload, actions, pendingWaits, ctx);
      }
    }
  }
}
