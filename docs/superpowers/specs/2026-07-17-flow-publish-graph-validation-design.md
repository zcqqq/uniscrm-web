# Flow Publish Graph Validation

## Problem

`https://flow-dev.uni-scrm.com/flows/:id/analytics` can be reached (i.e. the flow can be
published) even when the flow's nodes have no connecting edges at all. Neither the backend
publish endpoint nor either frontend "Publish" entry point checks graph connectivity:

- Backend `POST /api/flows/:id/publish` (`flow/src/index.ts:739`) unconditionally sets
  `status = 'published'`.
- `EditorPage.tsx` Publish button (`flow/frontend/pages/EditorPage.tsx:102-114`) calls
  `handleSave()` then `api.flows.publish(id)` directly.
- `FlowsPage.tsx` list-row Publish menu item (`flow/frontend/pages/FlowsPage.tsx:205`) calls
  `api.flows.publish(flow.id)` directly.

Result: a flow with disconnected nodes (e.g. a trigger with no outgoing edge, or an action node
nobody points to) publishes successfully and silently does nothing useful at runtime.

## Scope decisions (confirmed)

- **Validation rule**: full reachability. Every non-trigger node must be reachable, following
  directed edges, from at least one trigger node. A trigger node type is one of `xTrigger`,
  `cronTrigger`, `xContentTrigger` (the node-execution entry points; confirmed against
  `flow/src/index.ts` — these are the only types matched as flow entry points, e.g. line 1100's
  `cronTrigger` filter). This single rule also catches the reported case (trigger with zero
  outgoing edges) without a separate check.
- **Enforcement location**: frontend only. `EditorPage.tsx` and `FlowsPage.tsx` block the
  Publish action locally. The backend `/api/flows/:id/publish` endpoint is **not** changed —
  acknowledged risk: a direct API call bypasses validation. Accepted because the flow frontend
  is currently the only client.
- **UX on invalid graph**:
  - EditorPage: block save+publish, show a destructive toast with the orphan node count, and
    highlight the offending nodes with a red border on the canvas. Highlight clears
    automatically the next time the user edits the graph.
  - FlowsPage: block publish, show a destructive toast, navigate the user to the flow's editor
    page so they can fix it there.
- **Existing invalid published flows**: no backfill, no retroactive unpublish. They keep running
  as-is; the new check only applies the next time someone re-publishes.

## Design

### `flow/frontend/lib/validate-flow-graph.ts` (new)

```ts
export const TRIGGER_NODE_TYPES = ["xTrigger", "cronTrigger", "xContentTrigger"];

export function findOrphanNodeIds(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): string[];

export function validateFlowGraph(
  nodes: { id: string; type?: string }[],
  edges: { source: string; target: string }[]
): { valid: boolean; orphanNodeIds: string[] };
```

Algorithm: build an adjacency map from `edges` (`source -> target[]`), BFS outward starting from
every node whose `type` is in `TRIGGER_NODE_TYPES`, collect visited ids. Any node whose `type` is
not a trigger type and whose id was not visited is an orphan. A graph with zero trigger nodes
correctly flags every other node as orphan (nothing is reachable). A graph with only trigger
node(s) and nothing else is valid (there's nothing to be unreachable).

This is a plain, dependency-free module — no React, no store, no API — so it is trivially unit
testable and reusable from both pages.

### `EditorPage.tsx`

Publish button handler, before `handleSave()`:

```ts
const { nodes, edges } = useFlowEditor.getState();
const { valid, orphanNodeIds } = validateFlowGraph(nodes, edges);
if (!valid) {
  toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
  useFlowEditor.getState().setErrorNodeIds(orphanNodeIds);
  return;
}
```

If valid, proceed exactly as today (save, publish, navigate to analytics).

Store changes (`flow-editor.ts`):
- New state field `errorNodeIds: string[]` (default `[]`) and setter `setErrorNodeIds`.
- Reset `errorNodeIds: []` at the top of `onNodesChange`, `onEdgesChange`, and `onConnect` so any
  edit clears a stale highlight.

`Canvas.tsx`: read `errorNodeIds` from the store; when building the `nodes` array passed to
`<ReactFlow>`, set `className: "flow-node-error"` on nodes whose id is in `errorNodeIds` (React
Flow applies a node's `className` to its `.react-flow__node` wrapper regardless of the custom
node component's own rendering, so no per-node-component changes are needed).

`index.css`: add

```css
.react-flow__node.flow-node-error {
  outline: 2px solid var(--destructive, #ef4444);
  outline-offset: 2px;
  border-radius: 8px;
}
```

(Targeting the React Flow wrapper's global CSS class from the module stylesheet — not inline
style / raw Tailwind on a standard element — since the wrapper is owned by the `@xyflow/react`
library, not a project component.)

### `FlowsPage.tsx`

Publish menu item handler, replacing the current one-line `onClick`:

```ts
onClick: async () => {
  const { flow: detail } = await api.flows.get(flow.id);
  const graph = JSON.parse(detail.graph_json || '{"nodes":[],"edges":[]}');
  const { valid, orphanNodeIds } = validateFlowGraph(graph.nodes || [], graph.edges || []);
  if (!valid) {
    toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
    navigate(`/flows/${flow.id}`);
    return;
  }
  await api.flows.publish(flow.id);
  refresh();
}
```

(The list endpoint's `FlowSummary` has no `nodes`/`edges`, so an extra `GET` is required — this
mirrors how Editor already has the full graph loaded.)

### Not in scope

- No backend validation change.
- No auto-highlight-on-arrival when FlowsPage navigates to the editor after a failed publish
  (user re-clicks Publish there to see the highlight) — avoids adding cross-page state passing
  for a minor UX nicety that wasn't requested.
- No migration/backfill for already-published flows with orphan nodes.

## Testing

- `flow/tests/unit/validate-flow-graph.test.ts` (new): unit tests for `findOrphanNodeIds` /
  `validateFlowGraph` covering: no trigger nodes, multiple trigger nodes, a disconnected branch
  hanging off a valid chain, an empty graph, a trigger-only graph (valid), a fully connected
  multi-branch graph (valid).
- EditorPage/FlowsPage integration verified manually against the local `wrangler` dev server in
  a browser (per project's `coding agent` CLAUDE.md rule): trigger the invalid-publish path from
  both entry points and confirm the toast + highlight / navigate behavior.
