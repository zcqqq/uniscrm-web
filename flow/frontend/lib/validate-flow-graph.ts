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

// youtubeCondition 复查的是"触发这条流程的那个 YouTube 视频"，所以它只在 YouTube Trigger
// 开的流程里有意义。addNode 保证每个 flow 至多一个 trigger（flow-editor.ts），因此这里
// 判断唯一那个 trigger 的类型即可，不需要遍历上游可达性。
export function findMisplacedYouTubeConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const hasYouTubeTrigger = nodes.some((n) => n.type === "youtubeContentTrigger");
  if (hasYouTubeTrigger) return [];
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
