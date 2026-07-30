export const TRIGGER_NODE_TYPES = ["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger"];

export function findOrphanNodeIds(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }

  const reached = new Set<string>();
  const queue = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? "")).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const nextId of adjacency.get(id) ?? []) {
      if (!reached.has(nextId)) queue.push(nextId);
    }
  }

  return nodes
    .filter((n) => !TRIGGER_NODE_TYPES.includes(n.type ?? "") && !reached.has(n.id))
    .map((n) => n.id);
}

// youtubeCondition 复查的是"触发这条流程的那个 YouTube 视频"，所以它只在唯一 trigger 是
// youtubeContentTrigger 的流程里有意义。
// 判的是"trigger 集合恰好等于一个 youtubeContentTrigger"，而不是"图里存在一个
// youtubeContentTrigger"：单 trigger 只由 addNode 保证（flow-editor.ts:113），
// replaceGraph（AI 生成 / 模板载入）不校验，同时含 youtubeContentTrigger 和 xContentTrigger
// 的图确实存在，那时 X 触发的那次运行会把 X post id 喂给 videos.list。
export function findMisplacedYouTubeConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const triggers = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? ""));
  const onlyYouTubeTrigger = triggers.length === 1 && triggers[0].type === "youtubeContentTrigger";
  if (onlyYouTubeTrigger) return [];
  return nodes.filter((n) => n.type === "youtubeCondition").map((n) => n.id);
}

// 条件为空的 youtubeCondition 是个"只烧配额的空操作"：evaluateCondition 那套「全部通过
// 才算通过」的语义下，空数组的 every() 恒为 true，节点永远走 true 分支——却仍然为每一条
// 内容打一次 videos.list，而 YOUTUBE_API_KEY 是全平台共享的 10000 units/天免费配额。
// 用户几乎不可能是故意这么配的（ConditionsEditor 的 "+ Add" 就会先插一个空行），发布前挡住。
export function findEmptyYouTubeConditionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "youtubeCondition")
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}

// 与运行时对"有几条条件"的判断保持一致，否则会出现「发布拦不住但运行时当没条件」或反之。
// - 非数组一律算 0：executeContentActions 的 Array.isArray 守卫（index.ts）会把手改坏的
//   或 AI 生成的畸形值降级成"没有条件"，运行时行为与空数组完全相同。
// - field 为空的半成品行算 0 条：evaluateCondition 与 resolveYouTubeCondition 都显式跳过
//   `!c.field` 的条目，所以只有空行的节点在运行时同样恒为 true。
function countUsableConditions(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter(
    (c) => c && typeof c === "object" && String((c as { field?: unknown }).field ?? "") !== ""
  ).length;
}

export function validateFlowGraph(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[],
  edges: { source: string; target: string }[]
): {
  valid: boolean;
  orphanNodeIds: string[];
  misplacedNodeIds: string[];
  emptyConditionNodeIds: string[];
} {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  const emptyConditionNodeIds = findEmptyYouTubeConditionIds(nodes);
  return {
    valid:
      orphanNodeIds.length === 0 &&
      misplacedNodeIds.length === 0 &&
      emptyConditionNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
    emptyConditionNodeIds,
  };
}
