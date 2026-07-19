import { CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../nodeTypeRegistry";

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
  conditions?: { field: string; operator: string; value: string }[];
}

export interface ActionResult {
  type: string;
  [key: string]: unknown;
}

export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit";
}

export interface ExecutionResult {
  matched: boolean;
  actions: ActionResult[];
  pendingWaits: PendingWait[];
  nodeLogs: NodeLog[];
}

function resolveValue(value: string, payload: Record<string, unknown>): number | null {
  if (!value.includes("$")) return parseFloat(value);

  const expr = value.replace(/\$(?:event\.|user\.)?(\w+)/g, (_, field) => {
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

function resolveStringValue(value: string, payload: Record<string, unknown>): string {
  if (!value.includes("$")) return value;
  return value.replace(/\$(?:event\.|user\.)?(\w+)/g, (_, field) => {
    const v = payload[field];
    if (v === undefined || v === null) return "";
    return String(v);
  });
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
  const resolved = resolveStringValue(value, payload);

  if (resolved.includes(",") && !value.includes("$")) {
    const values = resolved.split(",");
    if (operator === "==") return values.includes(actualStr);
    if (operator === "!=") return !values.includes(actualStr);
  }

  switch (operator) {
    case "==":
      return actualStr === resolved;
    case "!=":
      return actualStr !== resolved;
    case ">":
    case "<":
    case ">=":
    case "<=": {
      const numVal = resolveValue(value, payload);
      if (numVal === null) return false;
      const actualNum = parseFloat(actualStr);
      if (operator === ">") return actualNum > numVal;
      if (operator === "<") return actualNum < numVal;
      if (operator === ">=") return actualNum >= numVal;
      return actualNum <= numVal;
    }
    case "contains":
      return actualStr.includes(resolved);
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
    (n) => (n.type === "xTrigger" && (n.data.eventType === eventType || n.data.triggerType === eventType)
            && n.data.channelId === payload.channel_id)
      || (n.type === "cronTrigger" && eventType === "cron.trigger")
      || (n.type === "xContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && (n.data.mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
              ? n.data.listId === payload.list_id
              : payload.list_id === undefined || payload.list_id === null))
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && n.data.subscriptionChannelId === payload.subscription_channel_id)
  );

  if (triggerNodes.length === 0) return { matched: false, actions: [], pendingWaits: [], nodeLogs: [] };

  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];
  const nodeLogs: NodeLog[] = [];

  for (const trigger of triggerNodes) {
    nodeLogs.push({ nodeId: trigger.id, direction: "enter" });
    const conditions = (trigger.data.conditions as { field: string; operator: string; value: string }[]) || [];
    const allPass = conditions.every((c) =>
      !c.field || evaluateCondition(c.field, c.operator, String(c.value), payload)
    );
    if (allPass) {
      nodeLogs.push({ nodeId: trigger.id, direction: "exit" });
      collectActions(graph, trigger.id, payload, actions, pendingWaits, nodeLogs);
    }
  }

  return { matched: actions.length > 0 || pendingWaits.length > 0, actions, pendingWaits, nodeLogs };
}

export function resumeFromNode(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  branch?: string
): ExecutionResult {
  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];
  const nodeLogs: NodeLog[] = [];

  nodeLogs.push({ nodeId, direction: "exit" });

  if (branch) {
    const branchEdges = graph.edges.filter((e) => e.source === nodeId && e.sourceHandle === branch);
    for (const edge of branchEdges) {
      const target = graph.nodes.find((n) => n.id === edge.target);
      if (!target) continue;
      if (target.type === "action") {
        nodeLogs.push({ nodeId: target.id, direction: "enter" });
        const actionData = buildActionData(target);
        actions.push(actionData);
        nodeLogs.push({ nodeId: target.id, direction: "exit" });
        if (!actionData.hasBranches) {
          collectActions(graph, target.id, payload, actions, pendingWaits, nodeLogs);
        }
      } else if (target.type === "wait") {
        nodeLogs.push({ nodeId: target.id, direction: "enter" });
        const duration = Number(target.data.duration || 0);
        const unit = String(target.data.unit || "minutes");
        if (duration > 0) {
          pendingWaits.push({ nodeId: target.id, durationMs: durationToMs(duration, unit) });
        }
        // wait node: enter logged, exit will be logged when cron resumes
      } else if (target.type === "waitForEvent") {
        nodeLogs.push({ nodeId: target.id, direction: "enter" });
        const awaitingEvent = target.data.eventType as string;
        const duration = Number(target.data.duration || 1);
        const unit = String(target.data.unit || "days");
        const conditions = (target.data.conditions as { field: string; operator: string; value: string }[]) || [];
        if (awaitingEvent) {
          pendingWaits.push({ nodeId: target.id, durationMs: durationToMs(duration, unit), awaitingEvent, conditions: conditions.length > 0 ? conditions : undefined });
        }
        // waitForEvent node: enter logged, exit will be logged when event triggers or timeout occurs
      } else {
        collectActions(graph, target.id, payload, actions, pendingWaits, nodeLogs);
      }
    }
  } else {
    collectActions(graph, nodeId, payload, actions, pendingWaits, nodeLogs);
  }

  return { matched: actions.length > 0 || pendingWaits.length > 0, actions, pendingWaits, nodeLogs };
}

function durationToMs(duration: number, unit: string): number {
  switch (unit) {
    case "minutes": return duration * 60 * 1000;
    case "hours": return duration * 60 * 60 * 1000;
    case "days": return duration * 24 * 60 * 60 * 1000;
    default: return duration * 60 * 1000;
  }
}

function buildActionData(targetNode: FlowNode): ActionResult {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction" || actionType === "tiktokContentAction" || actionType === "videoAction";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
  if (actionType === "xAction") {
    actionData.xEvent = targetNode.data.xEvent as string;
    actionData.channelId = targetNode.data.channelId as string;
    if (targetNode.data.messageText) actionData.messageText = targetNode.data.messageText as string;
  }
  if (actionType === "xContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "create-post";
    actionData.prompt = targetNode.data.prompt as string;
    actionData.provider = targetNode.data.provider as string;
    actionData.skillId = (targetNode.data.skillId as string) || "none";
    actionData.attachVideo = !!targetNode.data.attachVideo;
  }
  if (actionType === "tiktokContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "photo-post";
    actionData.channelId = targetNode.data.channelId as string;
    actionData.prompts = (targetNode.data.prompts as Record<string, string>) || {};
    actionData.textProvider = targetNode.data.textProvider as string;
    actionData.textSkillId = (targetNode.data.textSkillId as string) || "none";
    actionData.imageCount = (targetNode.data.imageCount as number) || 1;
    actionData.imageProvider = targetNode.data.imageProvider as string;
    actionData.imageSkillId = (targetNode.data.imageSkillId as string) || "none";
  }
  if (actionType === "videoAction") {
    actionData.targetLanguage = (targetNode.data.targetLanguage as string) || "zh";
  }
  return actionData;
}

function collectActions(
  graph: FlowGraph,
  nodeId: string,
  payload: Record<string, unknown>,
  actions: ActionResult[],
  pendingWaits: PendingWait[],
  nodeLogs: NodeLog[]
): void {
  const outEdges = graph.edges.filter((e) => e.source === nodeId);

  for (const edge of outEdges) {
    const targetNode = graph.nodes.find((n) => n.id === edge.target);
    if (!targetNode) continue;

    nodeLogs.push({ nodeId: targetNode.id, direction: "enter" });

    if (targetNode.type === "action") {
      const actionData = buildActionData(targetNode);
      actions.push(actionData);
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });

      if (!actionData.hasBranches) {
        collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      }
      continue;
    }

    if (targetNode.type === "wait") {
      const duration = Number(targetNode.data.duration || 0);
      const unit = String(targetNode.data.unit || "minutes");
      if (duration > 0) {
        pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit) });
      }
      // wait node: enter logged, exit will be logged when cron resumes
      continue;
    }

    if (targetNode.type === "waitForEvent") {
      const awaitingEvent = targetNode.data.eventType as string;
      const duration = Number(targetNode.data.duration || 1);
      const unit = String(targetNode.data.unit || "days");
      const conditions = (targetNode.data.conditions as { field: string; operator: string; value: string }[]) || [];
      if (awaitingEvent) {
        pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit), awaitingEvent, conditions: conditions.length > 0 ? conditions : undefined });
      }
      // eventHistory: enter logged, exit will be logged on resolution
      continue;
    }

    if (targetNode.type === "condition") {
      const { field, operator, value } = targetNode.data as { field?: string; operator?: string; value?: string };
      if (!field || !operator || value === undefined || value === "") {
        nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
        collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
        continue;
      }
      if (evaluateCondition(field, operator, String(value), payload)) {
        nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
        collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      }
      continue;
    }

    if (targetNode.type === "timeCondition") {
      pendingWaits.push({ nodeId: targetNode.id, durationMs: 0, timeCondition: true } as any);
      continue;
    }

    if (targetNode.type === "userPropsCondition") {
      actions.push({ type: "userPropsCondition", nodeId: targetNode.id, conditions: targetNode.data.conditions, hasBranches: true });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      continue;
    }

    if (targetNode.type === "abSplit") {
      actions.push({ type: "abSplit", nodeId: targetNode.id, mode: targetNode.data.mode, percentA: targetNode.data.percentA, conditions: targetNode.data.conditions, hasBranches: true });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      continue;
    }

    if (targetNode.type === "webhook") {
      actions.push({ type: "webhook", nodeId: targetNode.id, hasBranches: true, url: targetNode.data.url, method: targetNode.data.method, headers: targetNode.data.headers, body: targetNode.data.body });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      continue;
    }

    if (targetNode.type === "videoCondition") {
      actions.push({ type: "videoCondition", nodeId: targetNode.id, operation: (targetNode.data.operation as string) || "check-face", hasBranches: true });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      continue;
    }

    if (targetNode.type === "changeUserProps") {
      actions.push({ type: "changeUserProps", nodeId: targetNode.id, updates: targetNode.data.updates });
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      continue;
    }
  }
}
