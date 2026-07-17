// A generated node's "effective type" is its data.actionType when node.type is the
// generic "action" wrapper (addToList/xAction/xContentAction/tiktokContentAction/
// updateContentStatus all share node.type === "action"), otherwise node.type itself.
// This file intentionally does not import flow/nodeTypeRegistry.ts — shared/ has no
// dependency on any specific module; callers pass in the allowed-keys list instead.
function effectiveType(node: { type?: unknown; data?: { actionType?: unknown } }): string {
  if (node?.type === "action") {
    return typeof node.data?.actionType === "string" ? node.data.actionType : "action";
  }
  return typeof node?.type === "string" ? node.type : String(node?.type);
}

export function findInvalidNodeType(nodes: unknown, allowedKeys: string[]): string | null {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    const key = effectiveType(n as { type?: unknown; data?: { actionType?: unknown } });
    if (!allowedKeys.includes(key)) return key;
  }
  return null;
}
