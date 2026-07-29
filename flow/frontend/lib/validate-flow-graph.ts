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

export function validateFlowGraph(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): { valid: boolean; orphanNodeIds: string[]; misplacedNodeIds: string[] } {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  return {
    valid: orphanNodeIds.length === 0 && misplacedNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
  };
}
