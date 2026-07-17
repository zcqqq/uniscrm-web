# Flow Publish Graph Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block publishing a flow (from both the Editor and the flow list) when the graph has nodes unreachable from any trigger, and give the user a clear, actionable signal when that happens.

**Architecture:** A new dependency-free validation module (`validate-flow-graph.ts`) computes orphan node ids via BFS from trigger nodes. Both frontend entry points (`EditorPage.tsx`, `FlowsPage.tsx`) call it before hitting the publish API and block on failure. The editor additionally stores the offending node ids in the existing zustand store so `Canvas.tsx` can outline them in red.

**Tech Stack:** React, TypeScript, zustand, @xyflow/react (React Flow), vitest.

## Global Constraints

- Backend (`flow/src/index.ts` `/api/flows/:id/publish`) is explicitly out of scope — do not modify it.
- Existing published flows that are already invalid are explicitly out of scope — no migration/backfill/auto-unpublish.
- No inline CSS / raw Tailwind on standard elements (project convention) — the one exception is the `.flow-node-error` rule in `index.css`, which targets a third-party (`@xyflow/react`) DOM wrapper class, not a project component.
- Trigger node types are exactly: `xTrigger`, `cronTrigger`, `xContentTrigger` (confirmed against `flow/src/index.ts` execution entry points).

---

### Task 1: `validate-flow-graph.ts` core module + unit tests

**Files:**
- Create: `flow/frontend/lib/validate-flow-graph.ts`
- Test: `flow/tests/unit/validate-flow-graph.test.ts`

**Interfaces:**
- Produces:
  - `export const TRIGGER_NODE_TYPES: string[]` — `["xTrigger", "cronTrigger", "xContentTrigger"]`
  - `export function findOrphanNodeIds(nodes: { id: string; type?: string }[], edges: { source: string; target: string }[]): string[]`
  - `export function validateFlowGraph(nodes: { id: string; type?: string }[], edges: { source: string; target: string }[]): { valid: boolean; orphanNodeIds: string[] }`
  - Later tasks (2, 3) import `validateFlowGraph` from this file by exact name.

- [ ] **Step 1: Write the failing tests**

Create `flow/tests/unit/validate-flow-graph.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOrphanNodeIds, validateFlowGraph, TRIGGER_NODE_TYPES } from "../../frontend/lib/validate-flow-graph";

describe("TRIGGER_NODE_TYPES", () => {
  it("lists the three flow-execution entry-point node types", () => {
    expect(TRIGGER_NODE_TYPES).toEqual(["xTrigger", "cronTrigger", "xContentTrigger"]);
  });
});

describe("findOrphanNodeIds", () => {
  it("returns empty for an empty graph", () => {
    expect(findOrphanNodeIds([], [])).toEqual([]);
  });

  it("returns empty for a trigger-only graph with no other nodes", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }];
    expect(findOrphanNodeIds(nodes, [])).toEqual([]);
  });

  it("flags every non-trigger node when there is no trigger at all", () => {
    const nodes = [
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [{ source: "a1", target: "a2" }];
    expect(findOrphanNodeIds(nodes, edges).sort()).toEqual(["a1", "a2"]);
  });

  it("flags a trigger node with zero outgoing edges (the reported bug case)", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
    ];
    expect(findOrphanNodeIds(nodes, [])).toEqual(["a1"]);
  });

  it("returns empty when every non-trigger node is reachable from a trigger", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      { source: "a1", target: "a2" },
    ];
    expect(findOrphanNodeIds(nodes, edges)).toEqual([]);
  });

  it("flags a branch that is connected to the graph but not reachable from any trigger", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
      { id: "orphan1", type: "action" },
      { id: "orphan2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      // orphan1 -> orphan2 is a connected pair, but nothing points into orphan1 from a trigger
      { source: "orphan1", target: "orphan2" },
    ];
    expect(findOrphanNodeIds(nodes, edges).sort()).toEqual(["orphan1", "orphan2"]);
  });

  it("reaches nodes downstream of multiple trigger nodes", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "t2", type: "cronTrigger" },
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      { source: "t2", target: "a2" },
    ];
    expect(findOrphanNodeIds(nodes, edges)).toEqual([]);
  });
});

describe("validateFlowGraph", () => {
  it("is valid when there are no orphan nodes", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const edges = [{ source: "t1", target: "a1" }];
    expect(validateFlowGraph(nodes, edges)).toEqual({ valid: true, orphanNodeIds: [] });
  });

  it("is invalid and lists orphan ids when nodes are unreachable", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const result = validateFlowGraph(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.orphanNodeIds).toEqual(["a1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: FAIL — `Cannot find module '../../frontend/lib/validate-flow-graph'` (or similar resolution error), since the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `flow/frontend/lib/validate-flow-graph.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/lib/validate-flow-graph.ts flow/tests/unit/validate-flow-graph.test.ts
git commit -m "feat(flow): add flow graph orphan-node validation"
```

---

### Task 2: Store `errorNodeIds` + Canvas red-outline highlight

**Files:**
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/frontend/components/Canvas.tsx`
- Modify: `flow/frontend/index.css`

**Interfaces:**
- Consumes: nothing from Task 1 directly (this task only adds plumbing for the highlight; Task 3 is what calls `validateFlowGraph` and writes to `errorNodeIds`).
- Produces:
  - `FlowEditorState.errorNodeIds: string[]` (new field, default `[]`)
  - `FlowEditorState.setErrorNodeIds: (ids: string[]) => void` (new action)
  - Both consumed by Task 3.

- [ ] **Step 1: Add `errorNodeIds` state + setter to the store**

In `flow/frontend/store/flow-editor.ts`, add to the `FlowEditorState` interface (after `isDirty: boolean;` on line 21):

```ts
  errorNodeIds: string[];
```

and after `autoFillChannelIds: () => Promise<void>;` (line 39):

```ts
  setErrorNodeIds: (ids: string[]) => void;
```

In the `create<FlowEditorState>` initializer, add to the initial state (after `isDirty: false,` on line 70):

```ts
  errorNodeIds: [],
```

Add the setter implementation (anywhere among the other action implementations, e.g. right after `setSelectedNode`):

```ts
  setErrorNodeIds: (ids) => set({ errorNodeIds: ids }),
```

Clear `errorNodeIds` whenever the graph is edited, so a stale highlight never survives a fix. Update the three existing mutators:

```ts
  onNodesChange: (changes) =>
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes), isDirty: true, errorNodeIds: [] })),

  onEdgesChange: (changes) =>
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges), isDirty: true, errorNodeIds: [] })),

  onConnect: (connection) => {
    const { nodes } = get();
    const source = nodes.find((n) => n.id === connection.source);
    const target = nodes.find((n) => n.id === connection.target);
    if (!isValidConnection(source, target)) return;
    set((state) => ({
      edges: addEdge({ ...connection, id: crypto.randomUUID() }, state.edges),
      isDirty: true,
      errorNodeIds: [],
    }));
  },
```

(These replace the existing bodies of `onNodesChange`, `onEdgesChange`, and `onConnect` — same logic, `errorNodeIds: []` added to each returned/set object.)

- [ ] **Step 2: Highlight `errorNodeIds` in Canvas**

In `flow/frontend/components/Canvas.tsx`, change the destructure on line 23-24 from:

```ts
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode } =
    useFlowEditor();
```

to:

```ts
  const { nodes, edges, errorNodeIds, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode } =
    useFlowEditor();
```

Add a derived nodes array with the error class applied, right before the `return` statement (before line 71):

```ts
  const displayNodes = errorNodeIds.length === 0
    ? nodes
    : nodes.map((n) => errorNodeIds.includes(n.id) ? { ...n, className: "flow-node-error" } : n);
```

Change the `<ReactFlow nodes={nodes} ...>` prop (line 74) to:

```tsx
        nodes={displayNodes}
```

- [ ] **Step 3: Add the highlight CSS rule**

Append to `flow/frontend/index.css`:

```css

.react-flow__node.flow-node-error {
  outline: 2px solid #ef4444;
  outline-offset: 2px;
  border-radius: 8px;
}
```

- [ ] **Step 4: Type-check**

Run: `cd flow && npm run typecheck`
Expected: no new type errors.

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/store/flow-editor.ts flow/frontend/components/Canvas.tsx flow/frontend/index.css
git commit -m "feat(flow): add errorNodeIds highlight plumbing to editor store and canvas"
```

---

### Task 3: Wire validation into EditorPage Publish

**Files:**
- Modify: `flow/frontend/pages/EditorPage.tsx`

**Interfaces:**
- Consumes: `validateFlowGraph` from `flow/frontend/lib/validate-flow-graph.ts` (Task 1); `errorNodeIds` / `setErrorNodeIds` from `useFlowEditor` (Task 2); `useToast` from `shared/frontend/hooks/use-toast.ts` (existing).

- [ ] **Step 1: Import `validateFlowGraph` and `useToast`**

In `flow/frontend/pages/EditorPage.tsx`, add to the imports (after line 4's `import { useFlowEditor } from "../store/flow-editor";`):

```ts
import { validateFlowGraph } from "../lib/validate-flow-graph";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
```

- [ ] **Step 2: Call `useToast` in `EditorToolbar`**

Change the top of `EditorToolbar` (lines 19-24) from:

```ts
function EditorToolbar() {
  const { flowId, flowName, isDirty, setFlowName, markClean, toGraphJson, replaceGraph } =
    useFlowEditor();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
```

to:

```ts
function EditorToolbar() {
  const { flowId, flowName, isDirty, setFlowName, markClean, toGraphJson, replaceGraph } =
    useFlowEditor();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
```

- [ ] **Step 3: Validate before save+publish**

Replace the Publish button's `onClick` (lines 102-114):

```tsx
      <Button
        size="sm"
        onClick={async () => {
          await handleSave();
          const id = useFlowEditor.getState().flowId;
          if (id) {
            await api.flows.publish(id);
            navigate(`/flows/${id}/analytics`);
          }
        }}
      >
        Publish
      </Button>
```

with:

```tsx
      <Button
        size="sm"
        onClick={async () => {
          const { nodes, edges } = useFlowEditor.getState();
          const { valid, orphanNodeIds } = validateFlowGraph(nodes, edges);
          if (!valid) {
            toast({ title: `${orphanNodeIds.length} 个节点未连接，无法发布`, variant: "destructive" });
            useFlowEditor.getState().setErrorNodeIds(orphanNodeIds);
            return;
          }
          await handleSave();
          const id = useFlowEditor.getState().flowId;
          if (id) {
            await api.flows.publish(id);
            navigate(`/flows/${id}/analytics`);
          }
        }}
      >
        Publish
      </Button>
```

- [ ] **Step 4: Type-check**

Run: `cd flow && npm run typecheck`
Expected: no new type errors.

- [ ] **Step 5: Manual verification against dev server**

From `flow/`, run the worker backend and Vite frontend together (two terminals): `npm run dev:worker` and `npm run dev`.

In a browser:
1. Open a flow with a trigger node and one unconnected action node (or create one via a template then delete its connecting edge).
2. Click Publish. Expected: a destructive toast reading "1 个节点未连接，无法发布"; the action node gets a red outline; the page does **not** navigate to `/flows/:id/analytics`; the flow's status stays "draft" (verify via the flow list or by reloading).
3. Connect the node, click Publish again. Expected: toast does not appear, page navigates to `/flows/:id/analytics`, flow status is now "published".
4. Disconnect a node, click Publish (red outline appears), then drag any node or add an edge. Expected: the red outline clears immediately (per the `errorNodeIds: []` reset wired in Task 2).

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/pages/EditorPage.tsx
git commit -m "feat(flow): block editor Publish when the graph has orphan nodes"
```

---

### Task 4: Wire validation into FlowsPage Publish

**Files:**
- Modify: `flow/frontend/pages/FlowsPage.tsx`

**Interfaces:**
- Consumes: `validateFlowGraph` from `flow/frontend/lib/validate-flow-graph.ts` (Task 1); `useToast` from `shared/frontend/hooks/use-toast.ts` (existing); `api.flows.get` (existing, returns `{ flow: FlowDetail }` where `FlowDetail.graph_json: string`).

- [ ] **Step 1: Import `validateFlowGraph` and `useToast`**

In `flow/frontend/pages/FlowsPage.tsx`, add to the imports (after line 4's `import { api } from "../lib/api";`):

```ts
import { validateFlowGraph } from "../lib/validate-flow-graph";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
```

- [ ] **Step 2: Call `useToast` in `FlowsPage`**

In the `FlowsPage` component body, add alongside the existing `const navigate = useNavigate();` (line 54):

```ts
  const { toast } = useToast();
```

- [ ] **Step 3: Validate before publish in the list's Publish menu item**

Replace the `draft.menu` Publish entry (line 205):

```ts
                                  { label: "Publish", onClick: () => api.flows.publish(flow.id).then(() => refresh()) },
```

with:

```ts
                                  {
                                    label: "Publish",
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
                                    },
                                  },
```

- [ ] **Step 4: Type-check**

Run: `cd flow && npm run typecheck`
Expected: no new type errors.

- [ ] **Step 5: Manual verification against dev server**

With `npm run dev:worker` and `npm run dev` still running from Task 3 Step 5:

1. On the flow list page, find (or create) a draft flow with an unconnected node.
2. Click its row menu → Publish. Expected: destructive toast "N 个节点未连接，无法发布"; browser navigates to that flow's editor page; the flow's status in the list (visible after navigating back) is still "draft".
3. Fix the connection in the editor, go back to the list, click Publish on a flow that **is** fully connected. Expected: no toast, `refresh()` runs, row status flips to "Published".

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/pages/FlowsPage.tsx
git commit -m "feat(flow): block flow-list Publish when the graph has orphan nodes"
```

---

## Self-Review Notes

- **Spec coverage:** validation core (Task 1), EditorPage block+highlight+toast (Task 2+3), FlowsPage block+toast+navigate (Task 4), backend/existing-data explicitly untouched (no task modifies `flow/src/index.ts`), unit tests (Task 1), manual browser verification (Tasks 3–4 Step 5) — all spec sections covered.
- **No placeholders:** every step has literal code; manual verification steps state exact expected UI outcomes rather than "add validation".
- **Type consistency:** `validateFlowGraph(nodes, edges) -> { valid, orphanNodeIds }` and `TRIGGER_NODE_TYPES` are defined once in Task 1 and referenced with identical names/shapes in Tasks 3–4. `errorNodeIds` / `setErrorNodeIds` defined once in Task 2, consumed with identical names in Task 3.
