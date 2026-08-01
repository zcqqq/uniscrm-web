import { CONTENT_X_TRIGGER_MODE_LIST_POSTS, CONDITION_LOGIC_OR, resolveYouTubeSubscriptions } from "../nodeTypeRegistry";
import { USER_PROP_PREFIX } from "../../metadata/dataTypes";

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
  // 与 conditions 同源快照，一起写进 flow_pending。等待期间用户改了 flow 的 AND/OR，
  // 不能让已经排期的旧条件套上新逻辑。空串 = AND。
  conditionLogic?: string;
}

export interface ActionResult {
  type: string;
  playlistId?: string;
  [key: string]: unknown;
}

export interface NodeLog {
  nodeId: string;
  direction: "enter" | "exit" | "outcome";
  outcome?: string;
  // Only ever set on an outcome:"failed" row — the machine-stable reason code, optionally
  // followed by ": " and the external API's own (untranslatable) error text. Surfaced in the
  // analytics drawer so a failure says WHY, not just "Failed".
  failureReason?: string;
}

export interface ExecutionResult {
  matched: boolean;
  actions: ActionResult[];
  pendingWaits: PendingWait[];
  nodeLogs: NodeLog[];
}

// `$event.x` / `$user.x` / `$x` 三种引用形式。
//
// event. 是纯装饰前缀：剥掉后查裸键。它没有任何带点号的对应键，剥了无害，也让存量
// user flow 的写法继续有效。
//
// user. 则是**真命名空间**：content flow 的 payload 里作者字段的键就是
// "user.<propId>"（link 的 resolveAuthorProps 统一加的），与内容侧同名的
// like_count / view_count 靠它区分——两侧含义完全不同（推文被点赞数 vs 作者点过多少赞；
// 视频播放量 vs 频道历史总播放量）。
//
// 所以 user. **严格**解析，绝不降级到裸键：作者数据取不到时（配额耗尽、作者被封）
// payload 不带 user.*，一降级 $user.view_count 就会命中这个视频自己的播放量，条件照常
// 求值并给出一个看似合理的错误答案。严格解析下它取到 undefined，按 fail-closed 不通过。
// user flow 的 payload 由 link 的 flattenUserPayload 双写裸键与 user. 键，所以存量
// $user.x 写法在那边照常命中。
const PROP_REF_RE = /\$((?:event\.|user\.)?\w+)/g;

function lookupPropRef(ref: string, payload: Record<string, unknown>): unknown {
  const key = ref.startsWith("event.") ? ref.slice("event.".length) : ref;
  return payload[key];
}

function resolveValue(value: string, payload: Record<string, unknown>): number | null {
  if (!value.includes("$")) return parseFloat(value);

  const expr = value.replace(PROP_REF_RE, (_, ref: string) => {
    const v = lookupPropRef(ref, payload);
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

interface ResolvedString {
  text: string;
  // 值里出现了 $user.x，但 payload 里没有这个键。数值侧靠 NaN → null 天然 fail-closed，
  // 字符串侧没有这样的哨兵值：取不到只能替换成空串，而 "任何字符串".includes("") 恒为
  // true、!= 也几乎恒为 true——作者数据取不到反而让条件**通过**，与 fail-closed 相反。
  // 例：X List Posts 的作者被封时 includes.users[] 里没有他，payload 完全不带 user.*，
  // content_text contains $user.username 就会命中，下游自动转发/私信照跑。
  // 所以把"有未解析的 user. 引用"这件事显式带回 evaluateCondition 短路成 false。
  //
  // 只对 user. 前缀成立：$event.x 与裸 $x 取不到时替换成空串是存量已发布 flow 的既有语义，
  // 这个分支不动它们。
  missingUserRef: boolean;
}

function resolveStringValue(value: string, payload: Record<string, unknown>): ResolvedString {
  if (!value.includes("$")) return { text: value, missingUserRef: false };
  let missingUserRef = false;
  const text = value.replace(PROP_REF_RE, (_, ref: string) => {
    const v = lookupPropRef(ref, payload);
    if (v === undefined || v === null) {
      if (ref.startsWith(USER_PROP_PREFIX)) missingUserRef = true;
      return "";
    }
    return String(v);
  });
  return { text, missingUserRef };
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
  const { text: resolved, missingUserRef } = resolveStringValue(value, payload);
  // 作者字段取不到 → 一律不通过，与数值侧 resolveValue 的 NaN → null → false 对齐。
  // 放在算子分支之前，所有算子（含 contains / == / !=）统一 fail-closed。
  if (missingUserRef) return false;

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

export type Condition = { field: string; operator: string; value: string };

// 三处求值点共用：executeFlow 里的 trigger、flow_pending sweep 里的 waitForEvent、
// 以及 youtubeCondition。改这里就是三处一起改，不会再漂移。
//
// 空 field 的半成品行一律不参与判定 —— UI 的 "+ Add" 会先插一个空行，用户还没选字段时
// 它不该影响结果。这个口径与前端 publish 校验的 countUsableConditions
// （validate-flow-graph.ts）必须逐字一致，否则会出现"发布拦不住但运行时当没条件"。
//
// 可用条件为 0 时结果直接落在语言的恒等元上，不需要任何特判：
//   AND → [].every() === true  （没有过滤器 = 全部放行，与本功能上线前一致）
//   OR  → [].some()  === false （OR 的恒等元就是 false；这种节点由发布期校验挡住上线）
//
// conditions / logic 都收 unknown：AI 生成或手改的 graph 会带任意形状。这里必须把它们
// 全部降级成"没有条件 / AND"，绝不许升级成异常 —— 一次抛出会逃出 executeContentActions，
// 队列消息整条重试，这一批里已经执行过的 action 全部重跑（重复发帖 / 私信）。
export function conditionsPass(
  conditions: unknown,
  logic: unknown,
  payload: Record<string, unknown>
): boolean {
  const usable = (Array.isArray(conditions) ? conditions : []).filter(
    (c) => c && typeof c === "object" && String((c as { field?: unknown }).field ?? "") !== ""
  ) as Condition[];
  const check = (c: Condition) =>
    evaluateCondition(c.field, c.operator, String(c.value), payload);
  return logic === CONDITION_LOGIC_OR ? usable.some(check) : usable.every(check);
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
          && resolveYouTubeSubscriptions(n.data)
               .some((s) => s.channelId === payload.subscription_channel_id))
  );

  if (triggerNodes.length === 0) return { matched: false, actions: [], pendingWaits: [], nodeLogs: [] };

  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];
  const nodeLogs: NodeLog[] = [];

  for (const trigger of triggerNodes) {
    nodeLogs.push({ nodeId: trigger.id, direction: "enter" });
    const allPass = conditionsPass(trigger.data.conditions, trigger.data.conditionLogic, payload);
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
  branch?: string,
  failureReason?: string
): ExecutionResult {
  const actions: ActionResult[] = [];
  const pendingWaits: PendingWait[] = [];
  const nodeLogs: NodeLog[] = [];

  // wait/waitForEvent/timeCondition defer logging "exit" until resolution (collectActions never
  // logs it eagerly for these three types — see their branches below) — this IS their one
  // legitimate exit and must stay countable. Every other resumable type (all "action" nodes,
  // plus webhook/abSplit/userPropsCondition/videoCondition/youtubeCondition) already had "exit"
  // logged eagerly at dispatch time; this second push is a duplicate, so it's relabeled "outcome"
  // (carrying the resolved branch) instead of counted again.
  const originatingNode = graph.nodes.find((n) => n.id === nodeId);
  const DEFERRED_EXIT_TYPES = ["wait", "waitForEvent", "timeCondition"];
  if (originatingNode && DEFERRED_EXIT_TYPES.includes(originatingNode.type)) {
    nodeLogs.push({ nodeId, direction: "exit" });
  } else {
    nodeLogs.push({ nodeId, direction: "outcome", outcome: branch, failureReason: branch === "failed" ? failureReason : undefined });
  }

  if (branch) {
    // Each branch target is processed by the SAME routine collectActions uses, so a resumed
    // branch behaves identically to a freshly traversed edge. This used to be a partial copy
    // handling only action/wait/waitForEvent, with everything else falling through to
    // `collectActions(graph, target.id, ...)` — which walks the target's CHILDREN and therefore
    // skipped the target node itself. A videoCondition/webhook wired to a branch handle silently
    // never ran, and an abSplit ran both of its own branches at once.
    const branchEdges = graph.edges.filter((e) => e.source === nodeId && e.sourceHandle === branch);
    for (const edge of branchEdges) {
      const target = graph.nodes.find((n) => n.id === edge.target);
      if (!target) continue;
      processTargetNode(graph, target, payload, actions, pendingWaits, nodeLogs);
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

export const FACE_RATIO_DEFAULT_OPERATOR = "<=";
export const FACE_RATIO_DEFAULT_THRESHOLD = 0.2;
export const ORIENTATION_DEFAULT_OPERATOR = ">";
export const ORIENTATION_DEFAULT_THRESHOLD = 1;

// Shared by evaluateFaceRatioBranch and evaluateOrientationBranch: both turn a videoCondition
// node's single measured number into a branch by comparing it against the node's own
// operator/threshold. The value is measured once by content's container; the threshold lives
// only in the graph, so re-tuning it is pure config with no re-detection. A value of 0 is a
// real answer (e.g. "no faces") and must not be confused with a missing one — anything
// unmeasurable resolves to "failed", never a guess.
function evaluateRatioBranch(
  data: Record<string, unknown>,
  ratio: unknown,
  defaultOperator: string,
  defaultThreshold: number
): "true" | "false" | "failed" {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "failed";

  const operator = (data.operator as string) || defaultOperator;
  const rawThreshold = Number(data.threshold);
  const threshold = Number.isFinite(rawThreshold) ? rawThreshold : defaultThreshold;

  switch (operator) {
    case "<=": return ratio <= threshold ? "true" : "false";
    case "<": return ratio < threshold ? "true" : "false";
    case ">=": return ratio >= threshold ? "true" : "false";
    case ">": return ratio > threshold ? "true" : "false";
    default: return "failed";
  }
}

export function evaluateFaceRatioBranch(data: Record<string, unknown>, ratio: unknown): "true" | "false" | "failed" {
  return evaluateRatioBranch(data, ratio, FACE_RATIO_DEFAULT_OPERATOR, FACE_RATIO_DEFAULT_THRESHOLD);
}

// Turns a videoCondition node's measured width/height ratio into its branch. A square video
// (ratio exactly 1) is Portrait under the default operator ">" — Landscape requires strictly
// greater than 1.
export function evaluateOrientationBranch(data: Record<string, unknown>, ratio: unknown): "true" | "false" | "failed" {
  return evaluateRatioBranch(data, ratio, ORIENTATION_DEFAULT_OPERATOR, ORIENTATION_DEFAULT_THRESHOLD);
}

export function buildActionData(targetNode: FlowNode): ActionResult {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction" || actionType === "tiktokContentAction" || actionType === "videoAction" || actionType === "youtubeContentAction";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
  if (actionType === "xAction") {
    actionData.xEvent = targetNode.data.xEvent as string;
    actionData.channelId = targetNode.data.channelId as string;
    if (targetNode.data.messageText) actionData.messageText = targetNode.data.messageText as string;
  }
  if (actionType === "xContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "create-post";
    // The X account that acts. Absent on nodes built before the picker existed — the executor
    // then falls back to the triggering channel, which is only correct for X-triggered flows.
    actionData.channelId = targetNode.data.channelId as string;
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
    actionData.operation = (targetNode.data.operation as string) || "add-subtitle";
    actionData.targetLanguage = (targetNode.data.targetLanguage as string) || "zh";
  }
  if (actionType === "youtubeContentAction") {
    actionData.operation = (targetNode.data.operation as string) || "save-to-playlist";
    actionData.playlistId = (targetNode.data.playlistId as string) || "";
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
    processTargetNode(graph, targetNode, payload, actions, pendingWaits, nodeLogs);
  }
}

// Executes ONE node that an edge just led into. Shared by collectActions (normal traversal) and
// resumeFromNode (asynchronous branch resolution) so the two can never drift apart — they did
// once, and branch targets other than action/wait/waitForEvent were silently skipped.
function processTargetNode(
  graph: FlowGraph,
  targetNode: FlowNode,
  payload: Record<string, unknown>,
  actions: ActionResult[],
  pendingWaits: PendingWait[],
  nodeLogs: NodeLog[]
): void {
  nodeLogs.push({ nodeId: targetNode.id, direction: "enter" });

  if (targetNode.type === "action") {
    const actionData = buildActionData(targetNode);
    actions.push(actionData);
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });

    if (!actionData.hasBranches) {
      collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
    }
    return;
  }

  if (targetNode.type === "wait") {
    const duration = Number(targetNode.data.duration || 0);
    const unit = String(targetNode.data.unit || "minutes");
    if (duration > 0) {
      pendingWaits.push({ nodeId: targetNode.id, durationMs: durationToMs(duration, unit) });
    }
    // wait node: enter logged, exit will be logged when cron resumes
    return;
  }

  if (targetNode.type === "waitForEvent") {
    const awaitingEvent = targetNode.data.eventType as string;
    const duration = Number(targetNode.data.duration || 1);
    const unit = String(targetNode.data.unit || "days");
    const conditions = (targetNode.data.conditions as { field: string; operator: string; value: string }[]) || [];
    if (awaitingEvent) {
      pendingWaits.push({
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
    return;
  }

  if (targetNode.type === "condition") {
    const { field, operator, value } = targetNode.data as { field?: string; operator?: string; value?: string };
    if (!field || !operator || value === undefined || value === "") {
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
      return;
    }
    if (evaluateCondition(field, operator, String(value), payload)) {
      nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
      collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
    }
    return;
  }

  if (targetNode.type === "timeCondition") {
    pendingWaits.push({ nodeId: targetNode.id, durationMs: 0, timeCondition: true } as any);
    return;
  }

  if (targetNode.type === "userPropsCondition") {
    actions.push({ type: "userPropsCondition", nodeId: targetNode.id, conditions: targetNode.data.conditions, hasBranches: true });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }

  if (targetNode.type === "abSplit") {
    actions.push({ type: "abSplit", nodeId: targetNode.id, mode: targetNode.data.mode, percentA: targetNode.data.percentA, conditions: targetNode.data.conditions, hasBranches: true });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }

  if (targetNode.type === "webhook") {
    actions.push({ type: "webhook", nodeId: targetNode.id, hasBranches: true, url: targetNode.data.url, method: targetNode.data.method, headers: targetNode.data.headers, body: targetNode.data.body });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }

  if (targetNode.type === "videoCondition") {
    actions.push({ type: "videoCondition", nodeId: targetNode.id, operation: (targetNode.data.operation as string) || "check-face", hasBranches: true });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }

  if (targetNode.type === "youtubeCondition") {
    // conditions 留在 graph 里（executeContentActions 用 nodeId 回查），不塞进 ActionResult——
    // 与 videoCondition 把 operator/threshold 留在 graph 的做法一致：阈值改了是纯配置变更。
    actions.push({ type: "youtubeCondition", nodeId: targetNode.id, hasBranches: true });
    nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
    return;
  }
}
