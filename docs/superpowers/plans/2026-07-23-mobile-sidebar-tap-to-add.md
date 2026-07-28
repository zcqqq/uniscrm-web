# Mobile Flow Editor: Single-Column Sidebar + Tap-to-Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flow editor's node palette (`Sidebar.tsx`) render as a single column below 768px, and let tapping a palette tile add that node to the canvas center on mobile — since drag-and-drop (the only way to add a node today) doesn't fire on touch devices at all.

**Architecture:** Pure CSS breakpoint change for the grid layout; a new DOM/React-free helper function computes where a tapped node should land (canvas viewport center, nudged to avoid landing exactly on an existing node); `Sidebar.tsx`'s `DraggableItem` gets a `matchMedia`-driven mobile check and, only below 768px, a click handler that reads the shared `ReactFlowInstance` (newly exposed on the zustand store) to place the new node.

**Tech Stack:** React 19, Zustand, `@xyflow/react` (React Flow) v12, Tailwind, Vitest (`@cloudflare/vitest-pool-workers` pool — no DOM/jsdom available).

## Global Constraints

- Breakpoint is 768px, matching the project's existing `md:` Tailwind convention (see `shared/frontend/Sidebar.tsx`). The JS-side check for gating the click handler uses `matchMedia("(max-width: 767.98px)")` — the same width, expressed as "just under 768px" since `max-width` is inclusive.
- Scope is `Sidebar.tsx` plus the minimum plumbing (`flow-editor.ts` store, `Canvas.tsx`) needed to make tap-to-add work. `Inspector.tsx` and the overall 3-panel (Sidebar+Canvas+Inspector) layout are explicitly out of scope for this plan.
- Desktop (≥768px) behavior is unchanged: dragging is still the only way to add a node; no click handler is attached above the breakpoint.
- New node placement: the current visible center of the canvas viewport, nudged diagonally by 40px steps if that lands within an existing node's 200×100 footprint (the same footprint `Canvas.tsx`'s dagre Arrange logic already uses), so the new node never lands exactly on top of another.
- No React component-test infrastructure exists in this repo (`flow/vitest.config.ts` runs on `@cloudflare/vitest-pool-workers`, i.e. `workerd`, not `jsdom`) and none is added by this plan. Business logic that can be expressed as a plain function (no `@xyflow/react` import, following the existing `frontend/lib/validate-flow-graph.ts` pattern) gets real unit tests; CSS/interaction-wiring changes are verified manually via `npm run dev` + Chrome DevTools device mode, per the design spec (`docs/superpowers/specs/2026-07-23-mobile-sidebar-tap-to-add-design.md`).
- Known risk, not solved by this plan: tooltip-wrapped elements sometimes need two taps on touch browsers (first tap opens the hover state). `DraggableItem` is wrapped in `Tooltip`/`TooltipTrigger`. Task 3's manual verification step explicitly checks for this and must not be skipped.

---

### Task 1: Sidebar single-column layout below 768px

**Files:**
- Modify: `flow/frontend/components/Sidebar.tsx:188` (Triggers grid), `:191` (Actions grid), `:194` (Flow Control grid)

**Interfaces:**
- Consumes: nothing new — pure Tailwind class change.
- Produces: nothing consumed by later tasks — purely visual, independent of Task 2/3.

- [ ] **Step 1: Change the three item grids from a fixed 2-column grid to 1-column below 768px, 2-column at/above it**

In `flow/frontend/components/Sidebar.tsx`, the `return` block currently reads:

```tsx
  return (
    <TooltipProvider>
      <aside className="w-60 border-r border-border bg-background p-4 overflow-y-auto">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Triggers</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByOrder(triggerItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
        <div className="grid grid-cols-2 gap-2 mb-6">{sortByOrder(actionItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
        <div className="grid grid-cols-2 gap-2">{sortByOrder(flowControlItems, sidebarOrder)}</div>
      </aside>
    </TooltipProvider>
  );
```

Change all three `grid grid-cols-2 gap-2` (two of them also have ` mb-6`) to `grid grid-cols-1 md:grid-cols-2 gap-2`:

```tsx
  return (
    <TooltipProvider>
      <aside className="w-60 border-r border-border bg-background p-4 overflow-y-auto">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Triggers</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">{sortByOrder(triggerItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">{sortByOrder(actionItems, sidebarOrder)}</div>

        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">{sortByOrder(flowControlItems, sidebarOrder)}</div>
      </aside>
    </TooltipProvider>
  );
```

- [ ] **Step 2: Verify manually (no component-test infra in this repo — see Global Constraints)**

Run: `cd flow && npm run dev`

Open the editor page (`/flows/new` or any existing flow) in Chrome, open DevTools device toolbar (Cmd+Shift+M), and check:
- At a width below 768px (e.g. 390px, iPhone 12 Pro preset): each of Triggers / Actions / Flow Control renders its tiles in a single column, full width.
- At a width at/above 768px: unchanged 2-column grid (compare against the current deployed dev site if unsure).

- [ ] **Step 3: Commit**

```bash
git add flow/frontend/components/Sidebar.tsx
git commit -m "feat(flow): single-column sidebar palette below 768px"
```

---

### Task 2: `computeAddPosition` pure helper + unit tests

**Files:**
- Create: `flow/frontend/lib/compute-add-position.ts`
- Test: `flow/tests/unit/compute-add-position.test.ts`

**Interfaces:**
- Consumes: nothing — pure function, no imports from `@xyflow/react` or the store (same convention as `frontend/lib/validate-flow-graph.ts`, which the test file's existing pattern is copied from).
- Produces: `computeAddPosition(desired: { x: number; y: number }, existingNodes: { position: { x: number; y: number } }[]): { x: number; y: number }` — consumed by Task 3's `Sidebar.tsx` click handler.

- [ ] **Step 1: Write the failing tests**

Create `flow/tests/unit/compute-add-position.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeAddPosition } from "../../frontend/lib/compute-add-position";

describe("computeAddPosition", () => {
  it("returns the desired position unchanged when there are no existing nodes", () => {
    expect(computeAddPosition({ x: 100, y: 100 }, [])).toEqual({ x: 100, y: 100 });
  });

  it("returns the desired position unchanged when an existing node is far away", () => {
    const existing = [{ position: { x: 1000, y: 1000 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 100, y: 100 });
  });

  it("nudges diagonally until clear when an existing node sits exactly at the desired position", () => {
    // desired=(100,100) coincides with the node, so dy clears the 100px threshold (the binding
    // constraint, since NODE_HEIGHT 100 < NODE_WIDTH 200) after 3 nudges: dy = 0, 40, 80, 120 —
    // the first value >= 100 is at nudge 3, landing on (220, 220).
    const existing = [{ position: { x: 100, y: 100 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 220, y: 220 });
  });

  it("nudges diagonally until clear when an existing node is within the footprint but off-center", () => {
    // dy starts at 35 (65 -> 100), then |65-140|=75 (still <100), then |65-180|=115 (clears) —
    // 2 nudges, landing on (180, 180).
    const existing = [{ position: { x: 100, y: 65 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 180, y: 180 });
  });

  it("does not nudge when an existing node is just outside the 200x100 footprint", () => {
    const existing = [{ position: { x: 300, y: 100 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 100, y: 100 });
  });

  it("keeps nudging past multiple nodes placed diagonally in its path", () => {
    // Each node in turn keeps the position colliding for longer than a single node would:
    // node at (100,100) stops blocking once dy>=100 (nudge 3), but by then the position has
    // reached (220,220), which collides with the node at (140,140) (dy=80) — and that in turn
    // hands off to the node at (180,180) once (220,220)'s dy clears it too. Final clear point
    // is (300,300), reached after 5 nudges.
    const existing = [
      { position: { x: 100, y: 100 } },
      { position: { x: 140, y: 140 } },
      { position: { x: 180, y: 180 } },
    ];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 300, y: 300 });
  });

  it("stops after 20 nudges even if still colliding, instead of looping forever", () => {
    const existing = Array.from({ length: 30 }, (_, i) => ({
      position: { x: 100 + i * 40, y: 100 + i * 40 },
    }));
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 900, y: 900 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/compute-add-position.test.ts`
Expected: FAIL — `Cannot find module '../../frontend/lib/compute-add-position'`

- [ ] **Step 3: Write the minimal implementation**

Create `flow/frontend/lib/compute-add-position.ts`:

```ts
// Same node footprint Canvas.tsx's dagre Arrange logic uses (g.setNode(n.id, { width: 200, height: 100 })),
// reused here so a tapped-to-add node doesn't land exactly on top of an existing one.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 100;
const NUDGE = 40;
const MAX_NUDGES = 20;

interface PositionedNode {
  position: { x: number; y: number };
}

function collidesWithAny(pos: { x: number; y: number }, nodes: PositionedNode[]): boolean {
  return nodes.some(
    (n) => Math.abs(n.position.x - pos.x) < NODE_WIDTH && Math.abs(n.position.y - pos.y) < NODE_HEIGHT
  );
}

export function computeAddPosition(
  desired: { x: number; y: number },
  existingNodes: PositionedNode[]
): { x: number; y: number } {
  let pos = { ...desired };
  let nudges = 0;
  while (collidesWithAny(pos, existingNodes) && nudges < MAX_NUDGES) {
    pos = { x: pos.x + NUDGE, y: pos.y + NUDGE };
    nudges++;
  }
  return pos;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/compute-add-position.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/lib/compute-add-position.ts flow/tests/unit/compute-add-position.test.ts
git commit -m "feat(flow): add computeAddPosition helper for tap-to-add node placement"
```

---

### Task 3: Wire mobile tap-to-add end-to-end

**Files:**
- Modify: `flow/frontend/store/flow-editor.ts:1-11` (imports), `:15-47` (interface), `:73-83` (initial state), `:207` (near `setErrorNodeIds`)
- Modify: `flow/frontend/components/Canvas.tsx:83`
- Modify: `flow/frontend/components/Sidebar.tsx:1-36` (imports + `DraggableItem`)

**Interfaces:**
- Consumes: `computeAddPosition` from Task 2 (`flow/frontend/lib/compute-add-position.ts`).
- Produces: `useFlowEditor` state field `reactFlowInstance: ReactFlowInstance | null` and action `setReactFlowInstance(instance: ReactFlowInstance | null): void` — not consumed by any later task in this plan, but is the durable interface this feature adds to the store.

- [ ] **Step 1: Add `reactFlowInstance` to the store**

In `flow/frontend/store/flow-editor.ts`, the `@xyflow/react` import currently reads:

```ts
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
```

Add `type ReactFlowInstance`:

```ts
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
```

In the `FlowEditorState` interface, add the field right after `errorNodeIds: string[];`:

```ts
  errorNodeIds: string[];
  // Set once by Canvas.tsx's onInit. Lets Sidebar.tsx compute canvas-viewport-relative
  // positions (e.g. "center of what's currently visible") for tap-to-add, without Canvas
  // having to expose a dedicated action for every future caller.
  reactFlowInstance: ReactFlowInstance | null;
```

And add the setter right after `setErrorNodeIds: (ids: string[]) => void;`:

```ts
  setErrorNodeIds: (ids: string[]) => void;
  setReactFlowInstance: (instance: ReactFlowInstance | null) => void;
```

In the store body, add the initial value right after `errorNodeIds: [],`:

```ts
  errorNodeIds: [],
  reactFlowInstance: null,
```

And add the action right after `setErrorNodeIds: (ids) => set({ errorNodeIds: ids }),`:

```ts
  setErrorNodeIds: (ids) => set({ errorNodeIds: ids }),
  setReactFlowInstance: (instance) => set({ reactFlowInstance: instance }),
```

- [ ] **Step 2: Type-check the store change in isolation**

Run: `cd flow && npm run typecheck`
Expected: no new errors (this step only added a field + setter; nothing consumes them yet, so this confirms the store edit alone is valid before wiring `Canvas.tsx`/`Sidebar.tsx`).

- [ ] **Step 3: Wire `Canvas.tsx`'s `onInit` to populate the store field**

In `flow/frontend/components/Canvas.tsx`, this line:

```tsx
        onInit={(instance) => { reactFlowRef.current = instance; }}
```

becomes:

```tsx
        onInit={(instance) => {
          reactFlowRef.current = instance;
          useFlowEditor.getState().setReactFlowInstance(instance);
        }}
```

- [ ] **Step 4: Add mobile detection + tap-to-add to `Sidebar.tsx`**

In `flow/frontend/components/Sidebar.tsx`, the imports currently read:

```tsx
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { NODE_TYPE_REGISTRY, USER_FLOW_SIDEBAR_ORDER, CONTENT_FLOW_SIDEBAR_ORDER, type FlowDomain } from "../../nodeTypeRegistry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
```

Change to:

```tsx
import { useEffect, useState } from "react";
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { NODE_TYPE_REGISTRY, USER_FLOW_SIDEBAR_ORDER, CONTENT_FLOW_SIDEBAR_ORDER, type FlowDomain } from "../../nodeTypeRegistry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../../../shared/frontend/ui/tooltip";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { computeAddPosition } from "../lib/compute-add-position";
```

The `DraggableItem` component currently reads:

```tsx
function DraggableItem({ type, label, description, color, icon }: DraggableItemProps) {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/reactflow-type", type);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          draggable
          onDragStart={onDragStart}
          className={`flex flex-col items-center gap-1 p-2 rounded-lg border cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow text-center ${color}`}
        >
          <span className="text-lg leading-none">{icon}</span>
          <span className="text-xs font-medium text-foreground leading-tight">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
```

Replace the whole function (leaving `DraggableItemProps` above it untouched) with:

```tsx
// Only 767px-and-below gets a click handler at all — desktop keeps drag-only, matching the
// md: 768px breakpoint the grid layout switches on (see Sidebar's grid className below).
const MOBILE_QUERY = "(max-width: 767.98px)";

function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function DraggableItem({ type, label, description, color, icon }: DraggableItemProps) {
  const addNode = useFlowEditor((s) => s.addNode);
  const isMobile = useIsMobileViewport();
  const { toast } = useToast();

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/reactflow-type", type);
    e.dataTransfer.effectAllowed = "move";
  };

  const onClick = () => {
    if (!isMobile) return;
    const { reactFlowInstance, nodes } = useFlowEditor.getState();
    const wrapper = document.querySelector(".react-flow");
    if (!reactFlowInstance || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const center = reactFlowInstance.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const position = computeAddPosition(center, nodes);
    const added = addNode(type, position);
    if (!added) {
      toast({ title: "一个流程只能有一个触发节点", variant: "destructive" });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          draggable
          onDragStart={onDragStart}
          onClick={onClick}
          className={`flex flex-col items-center gap-1 p-2 rounded-lg border cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow text-center ${color}`}
        >
          <span className="text-lg leading-none">{icon}</span>
          <span className="text-xs font-medium text-foreground leading-tight">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
```

Note this touches only the shared `DraggableItem` definition — none of the ~15 call sites elsewhere in `Sidebar.tsx` need to change, since they all already pass `type`, which `onClick` closes over.

- [ ] **Step 5: Type-check**

Run: `cd flow && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full unit test suite (confirm no regression)**

Run: `cd flow && npm test`
Expected: all tests pass, including Task 2's `compute-add-position.test.ts`.

- [ ] **Step 7: Verify manually in the browser**

Run: `cd flow && npm run dev`

In Chrome DevTools device mode (Cmd+Shift+M), at a width below 768px (e.g. 390px):
- Open a flow (or start a new one), tap a non-trigger palette tile (e.g. "Wait"). Confirm: the node appears at the visible center of the canvas, in a single tap (not requiring two taps — this is the tooltip double-tap risk flagged in Global Constraints; if it takes two taps, stop and report back before proceeding, don't silently ship it).
- Tap another tile of the same type again. Confirm: the second node appears near the first but not exactly overlapping it (the diagonal nudge from Task 2).
- If the flow has no trigger yet, tap a trigger tile (e.g. an X channel trigger). Confirm: it's added normally.
- With a trigger already present, tap another trigger tile. Confirm: a toast reading "一个流程只能有一个触发节点" appears and no second trigger is added.
- Resize back to ≥768px width. Confirm: clicking a tile does nothing (drag-and-drop is still required, exactly like before this change).

- [ ] **Step 8: Commit**

```bash
git add flow/frontend/store/flow-editor.ts flow/frontend/components/Canvas.tsx flow/frontend/components/Sidebar.tsx
git commit -m "feat(flow): tap-to-add nodes from the sidebar on mobile"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (single-column layout) → Task 1. Section 2 (tap-to-add, viewport-center placement, collision offset, desktop-unchanged) → Tasks 2 + 3. Section 3 (trigger-already-exists toast) → Task 3 Step 4 (`onClick`) + Step 7 (manual verification). "Known risk" (tooltip double-tap) → Task 3 Step 7 explicitly checks for it. Testing section → Task 2 (unit tests) + Task 1/3 (manual verification, explained why no component tests exist).
- **Placeholder scan:** none found — every step has literal code or an exact command with expected output.
- **Type consistency:** `computeAddPosition(desired, existingNodes)` signature is identical between Task 2's implementation/tests and Task 3's call site (`computeAddPosition(center, nodes)` — `nodes` from the store is structurally `{ position: { x, y } }[]`, matching `PositionedNode[]`). `setReactFlowInstance` name and signature match between the interface addition and the store body addition in Task 3 Step 1, and the call site in Task 3 Step 3.
