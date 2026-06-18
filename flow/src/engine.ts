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
  awaitingEvent?: string;
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
    collectActions(graph, trigger.id, payload, actions, pendingWaits);
  }

  return { matched: actions.length > 0 || pendingWaits.length > 0, actions, pendingWaits };
}

export function resumeFromNode(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  branch?: string
): ExecutionResult {
  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];

  if (branch) {
    const branchEdges = graph.edges.filter((e) => e.source === nodeId && e.sourceHandle === branch);
    for (const edge of branchEdges) {
      const target = graph.nodes.find((n) => n.id === edge.target);
      if (!target) continue;
      if (target.type === "action") {
        const actionType = target.data.actionType as string;
        const actionData: ActionResult = { type: actionType };
        if (actionType === "addToList") actionData.listId = target.data.listId as string;
        if (actionType === "xAction") { actionData.xEvent = target.data.xEvent as string; actionData.channelId = target.data.channelId as string; }
        actions.push(actionData);
      } else {
        collectActions(graph, target.id, payload, actions, pendingWaits);
      }
    }
  } else {
    collectActions(graph, nodeId, payload, actions, pendingWaits);
  }

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

function collectActions(
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

    if (targetNode.type === "eventHistory") {
      const awaitingEvent = targetNode.data.eventType as string;
      const duration = Number(targetNode.data.duration || 1);
      const unit = String(targetNode.data.unit || "days");
      if (awaitingEvent) {
        pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit), awaitingEvent });
      }
      continue;
    }

    if (targetNode.type === "condition") {
      const { field, operator, value } = targetNode.data as {
        field?: string; operator?: string; value?: string;
      };

      if (!field || !operator || value === undefined || value === "") {
        collectActions(graph, targetNode.id, payload, actions, pendingWaits);
        continue;
      }

      if (evaluateCondition(field, operator, String(value), payload)) {
        collectActions(graph, targetNode.id, payload, actions, pendingWaits);
      }
    }
  }
}
