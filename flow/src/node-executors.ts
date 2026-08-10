// Backend behavior maps for every node type the engine can encounter, keyed by the registry's
// literal type unions so TypeScript forces exhaustiveness: a new NODE_TYPE_REGISTRY entry whose
// reactFlowType / trigger role / action role isn't covered here is a compile error, not a
// silently-dead node at runtime. The registry (flow/nodeTypeRegistry.ts) stays declarative;
// this file is the flow-worker side of the behavior split (the frontend side is
// frontend/nodes/index.ts + Inspector.tsx's inspector maps).
//
// Import cycle note: engine.ts imports these maps; the legacy "condition" executor imports
// evaluateCondition back from engine.ts. That cycle is safe — both modules only reference the
// other's bindings inside function bodies, never during module evaluation.
import {
  NODE_TYPE_REGISTRY,
  CONTENT_X_TRIGGER_MODE_LIST_POSTS,
  resolveYouTubeSubscriptions,
  resolveGitHubRepos,
  type ReactFlowNodeType,
  type TriggerTypeKey,
  type ActionTypeKey,
} from "../nodeTypeRegistry";
import { evaluateCondition } from "./engine";
import type { FlowNode, ActionResult, PendingWait, NodeLog } from "./engine";

// ---------------------------------------------------------------------------
// Trigger matching (executeFlow)
// ---------------------------------------------------------------------------

export type TriggerMatcher = (
  node: FlowNode,
  eventType: string,
  payload: Record<string, unknown>
) => boolean;

// One predicate per trigger-role registry key. executeFlow derives its trigger-type set from
// this map — formerly an inline OR-literal over four node types.
export const TRIGGER_MATCHERS: Record<TriggerTypeKey, TriggerMatcher> = {
  xTrigger: (n, eventType, payload) =>
    (n.data.eventType === eventType || n.data.triggerType === eventType)
    && n.data.channelId === payload.channel_id,
  cronTrigger: (_n, eventType) => eventType === "cron.trigger",
  xContentTrigger: (n, eventType, payload) =>
    eventType === "content.created"
    && n.data.channelId === payload.channel_id
    && (n.data.mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
        ? n.data.listId === payload.list_id
        : payload.list_id === undefined || payload.list_id === null),
  youtubeContentTrigger: (n, eventType, payload) =>
    eventType === "content.created"
    && n.data.channelId === payload.channel_id
    && resolveYouTubeSubscriptions(n.data)
         .some((s) => s.channelId === payload.subscription_channel_id),
  githubContentTrigger: (n, eventType, payload) =>
    eventType === "content.created"
    && n.data.channelId === payload.channel_id
    && resolveGitHubRepos(n.data).some((r) => r.fullName === payload.repo_full_name)
    // prerelease 的过滤在这里，不在 link：轮询器按 repo 走，同一个 repo 可能被两个
    // includePrerelease 不同的 flow 盯着，它没资格替它们决定。
    && (n.data.includePrerelease === true || payload.is_prerelease !== 1),
};

/** Runtime lookup for possibly-unknown node types; undefined = not a trigger type. */
export function getTriggerMatcher(nodeType: string): TriggerMatcher | undefined {
  return (TRIGGER_MATCHERS as Record<string, TriggerMatcher | undefined>)[nodeType];
}

// ---------------------------------------------------------------------------
// Action data building (per-actionType, data.actionType-discriminated)
// ---------------------------------------------------------------------------

type ActionDataBuilder = (targetNode: FlowNode, actionData: ActionResult) => void;

// Per-actionType field mapping — formerly buildActionData's second if-chain in engine.ts.
const ACTION_DATA_BUILDERS: Record<ActionTypeKey, ActionDataBuilder> = {
  addToList: (node, a) => {
    a.listId = node.data.listId as string;
  },
  xAction: (node, a) => {
    a.xEvent = node.data.xEvent as string;
    a.channelId = node.data.channelId as string;
    if (node.data.messageText) a.messageText = node.data.messageText as string;
  },
  xContentAction: (node, a) => {
    a.operation = (node.data.operation as string) || "create-post";
    // The X account that acts. Absent on nodes built before the picker existed — the executor
    // then falls back to the triggering channel, which is only correct for X-triggered flows.
    a.channelId = node.data.channelId as string;
    a.prompt = node.data.prompt as string;
    a.provider = node.data.provider as string;
    a.skillId = (node.data.skillId as string) || "none";
    a.attachVideo = !!node.data.attachVideo;
  },
  tiktokContentAction: (node, a) => {
    a.operation = (node.data.operation as string) || "photo-post";
    a.channelId = node.data.channelId as string;
    a.prompts = (node.data.prompts as Record<string, string>) || {};
    a.textProvider = node.data.textProvider as string;
    a.textSkillId = (node.data.textSkillId as string) || "none";
    a.imageCount = (node.data.imageCount as number) || 1;
    a.imageProvider = node.data.imageProvider as string;
    a.imageSkillId = (node.data.imageSkillId as string) || "none";
  },
  youtubeContentAction: (node, a) => {
    a.operation = (node.data.operation as string) || "save-to-playlist";
    a.playlistId = (node.data.playlistId as string) || "";
  },
  videoAction: (node, a) => {
    a.operation = (node.data.operation as string) || "add-subtitle";
    a.targetLanguage = (node.data.targetLanguage as string) || "zh";
  },
};

export function buildActionData(targetNode: FlowNode): ActionResult {
  const actionType = targetNode.data.actionType as string;
  // hasBranches comes from the registry's externalApi facet (flow/CLAUDE.md: third-party API
  // actions get success/failed branches) — formerly a hand-maintained string list here.
  // Unknown actionTypes (absent from the registry) keep their legacy shape: a generic
  // { type, nodeId, hasBranches: false } action with no extra fields.
  const isExternalApi = NODE_TYPE_REGISTRY[actionType]?.externalApi === true;
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  const builder = (ACTION_DATA_BUILDERS as Record<string, ActionDataBuilder | undefined>)[actionType];
  if (builder) builder(targetNode, actionData);
  return actionData;
}

// ---------------------------------------------------------------------------
// Node execution (processTargetNode)
// ---------------------------------------------------------------------------

export interface NodeExecutorContext {
  payload: Record<string, unknown>;
  actions: ActionResult[];
  pendingWaits: PendingWait[];
  nodeLogs: NodeLog[];
  /** Continue traversal into the given node's outgoing edges (engine's collectActions). */
  continueFrom: (nodeId: string) => void;
}

export type NodeExecutor = (node: FlowNode, ctx: NodeExecutorContext) => void;

function durationToMs(duration: number, unit: string): number {
  switch (unit) {
    case "minutes": return duration * 60 * 1000;
    case "hours": return duration * 60 * 60 * 1000;
    case "days": return duration * 24 * 60 * 60 * 1000;
    default: return duration * 60 * 1000;
  }
}

// A trigger wired as an edge TARGET is a malformed graph (the editor's connection rules forbid
// it, but replaceGraph/AI generation doesn't). Long-standing behavior: "enter" is logged by the
// dispatcher, then nothing runs — preserved verbatim, distinct from the unknown-type error path.
const triggerAsTargetNoop: NodeExecutor = () => {};

// Legacy "condition" node type: predates the registry (no entry), still present in old graphs.
// Passes through when unconfigured; gates children on evaluateCondition otherwise.
const legacyConditionExecutor: NodeExecutor = (targetNode, ctx) => {
  const { field, operator, value } = targetNode.data as { field?: string; operator?: string; value?: string };
  if (!field || !operator || value === undefined || value === "") {
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    ctx.continueFrom(targetNode.id);
    return;
  }
  if (evaluateCondition(field, operator, String(value), ctx.payload)) {
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    ctx.continueFrom(targetNode.id);
  }
};

// Every React Flow node type the registry declares, plus the legacy "condition" type above.
type ExecutableNodeType = ReactFlowNodeType | "condition";

// One executor per node type — formerly processTargetNode's flat if-chain in engine.ts, whose
// missing `else` meant an unknown type silently killed the flow. The dispatcher (engine.ts's
// processTargetNode) logs "enter", then looks up here; unknown types get an explicit
// console.error + skip instead of the silent fall-through.
export const NODE_EXECUTORS: Record<ExecutableNodeType, NodeExecutor> = {
  xTrigger: triggerAsTargetNoop,
  cronTrigger: triggerAsTargetNoop,
  xContentTrigger: triggerAsTargetNoop,
  youtubeContentTrigger: triggerAsTargetNoop,
  githubContentTrigger: triggerAsTargetNoop,

  action: (targetNode, ctx) => {
    const actionData = buildActionData(targetNode);
    ctx.actions.push(actionData);
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    if (!actionData.hasBranches) {
      ctx.continueFrom(targetNode.id);
    }
  },

  wait: (targetNode, ctx) => {
    const duration = Number(targetNode.data.duration || 0);
    const unit = String(targetNode.data.unit || "minutes");
    if (duration > 0) {
      ctx.pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit) });
    }
    // wait node: enter logged, exit will be logged when cron resumes
  },

  waitForEvent: (targetNode, ctx) => {
    const awaitingEvent = targetNode.data.eventType as string;
    const duration = Number(targetNode.data.duration || 1);
    const unit = String(targetNode.data.unit || "days");
    const conditions = (targetNode.data.conditions as { field: string; operator: string; value: string }[]) || [];
    if (awaitingEvent) {
      ctx.pendingWaits.push({
        nodeId: targetNode.id,
        durationMs: durationToMs(duration, unit),
        awaitingEvent,
        conditions: conditions.length > 0 ? conditions : undefined,
        // 无条件带上：OR + 0 条是有语义的（恒不通过），丢了会让它在 resume 时被当成 AND 放行。
        // String() 规整畸形值——D1 的 bind 不接受对象。
        conditionLogic: String(targetNode.data.conditionLogic ?? ""),
      });
    }
    // eventHistory: enter logged, exit will be logged on resolution
  },

  condition: legacyConditionExecutor,

  timeCondition: (targetNode, ctx) => {
    ctx.pendingWaits.push({ nodeId: targetNode.id, durationMs: 0, timeCondition: true } as any);
  },

  userPropsCondition: (targetNode, ctx) => {
    ctx.actions.push({ type: "userPropsCondition", nodeId: targetNode.id, conditions: targetNode.data.conditions, hasBranches: true });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },

  abSplit: (targetNode, ctx) => {
    ctx.actions.push({ type: "abSplit", nodeId: targetNode.id, mode: targetNode.data.mode, percentA: targetNode.data.percentA, conditions: targetNode.data.conditions, hasBranches: true });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },

  webhook: (targetNode, ctx) => {
    ctx.actions.push({ type: "webhook", nodeId: targetNode.id, hasBranches: true, url: targetNode.data.url, method: targetNode.data.method, headers: targetNode.data.headers, body: targetNode.data.body });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },

  videoCondition: (targetNode, ctx) => {
    ctx.actions.push({ type: "videoCondition", nodeId: targetNode.id, operation: (targetNode.data.operation as string) || "check-face", hasBranches: true });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },

  youtubeCondition: (targetNode, ctx) => {
    // conditions 留在 graph 里（executeContentActions 用 nodeId 回查），不塞进 ActionResult——
    // 与 videoCondition 把 operator/threshold 留在 graph 的做法一致：阈值改了是纯配置变更。
    ctx.actions.push({ type: "youtubeCondition", nodeId: targetNode.id, hasBranches: true });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },
};

/** Runtime lookup for possibly-unknown node types; undefined = unknown (caller logs + skips). */
export function getNodeExecutor(nodeType: string): NodeExecutor | undefined {
  return (NODE_EXECUTORS as Record<string, NodeExecutor | undefined>)[nodeType];
}
