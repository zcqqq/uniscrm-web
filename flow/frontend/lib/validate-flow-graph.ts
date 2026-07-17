export const TRIGGER_NODE_TYPES = ["xTrigger", "cronTrigger", "xContentTrigger"];

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

export function validateFlowGraph(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): { valid: boolean; orphanNodeIds: string[] } {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  return { valid: orphanNodeIds.length === 0, orphanNodeIds };
}
