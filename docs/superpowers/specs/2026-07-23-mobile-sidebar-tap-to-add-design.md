# Mobile Flow Editor: Single-Column Sidebar + Tap-to-Add

## Context

The flow editor (`flow/frontend/pages/EditorPage.tsx`) lays out `Sidebar` (node palette, 240px) + `Canvas` (flex-1) + `Inspector` (288px) side by side. This is desktop-only today:

- `Sidebar.tsx` renders its three sections (Triggers / Actions / Flow Control) as `grid-cols-2` tiles.
- Adding a node to the canvas is HTML5 `draggable`/`dataTransfer` drag-and-drop (`Sidebar.tsx` `DraggableItem` + `Canvas.tsx` `onDrop`). HTML5 drag does not fire on touch devices at all, so on a phone, dragging a node from the palette onto the canvas currently does nothing.

**Scope for this change:** only `Sidebar.tsx`'s internal layout and node-adding interaction. The overall 3-panel layout (Sidebar + Canvas + Inspector all fixed-width, side by side) and `Inspector.tsx` are explicitly out of scope for this round — they don't fit a phone viewport either, but that's a separate future task.

## Breakpoint

Reuse the project's existing mobile breakpoint convention: Tailwind `md:` (768px), same as `shared/frontend/Sidebar.tsx` (the app-wide nav sidebar)'s mobile handling.

## 1. Layout: single column below 768px

In `Sidebar.tsx`, the three item grids change from `grid grid-cols-2 gap-2` to `grid grid-cols-1 md:grid-cols-2 gap-2`, for all three sections (Triggers, Actions, Flow Control).

**Correction (2026-07-24):** the first pass of this change kept the `<aside>` panel at its desktop width (`w-60`, 240px) and let the single column stretch each tile to fill it — full-width tiles, same panel width. That was a misreading of the intent: the panel itself should narrow to roughly one tile's width, with tiles keeping their natural (unstretched) size, so mobile gains canvas space rather than losing it to a wide palette. Fixed by also making the `<aside>`'s width responsive: `w-32 md:w-60` (128px below 768px, unchanged 240px at/above it). `grid-cols-1` on a narrower container naturally yields node-sized tiles — no tile-level styling changed, only the two container widths (`aside`, and the grid columns already described above).

## 2. Interaction: tap-to-add (mobile only)

- **Trigger condition:** `window.innerWidth < 768`, tracked via `matchMedia('(max-width: 767.98px)')` with a change listener (so rotating/resizing updates it), not touch-capability detection. This keeps the interactive behavior aligned with the exact same width the CSS breakpoint uses — a touch-capable device with a wide window still behaves like desktop.
- **Desktop unchanged:** no click handler is attached to the tile above 768px — drag-and-drop remains the only way to add a node. This avoids accidental adds from a stray click on desktop, where clicking a palette tile currently has no effect.
- **Placement:** the new node is placed at the current visible center of the canvas viewport:
  1. `flow-editor.ts` store gains a `reactFlowInstance: ReactFlowInstance | null` field, set by `Canvas.tsx`'s existing `onInit` callback (today the instance is a local `useRef` inside `Canvas.tsx`, invisible to `Sidebar.tsx`).
  2. On tap, read the `.react-flow` DOM element's `getBoundingClientRect()` center, convert to flow coordinates via `reactFlowInstance.screenToFlowPosition(...)`.
  3. If that position is too close to an existing node — reusing the 200×100 node footprint already used by the Arrange/dagre logic in `Canvas.tsx` as the collision threshold — offset diagonally (e.g. `+40, +40`, repeated if still colliding) so the new node doesn't land exactly on top of another one.
  4. Steps 2–3 are implemented as a plain, DOM/React-free function in the store (e.g. `computeAddPosition(center, existingNodes)`) so it can be unit tested the same way `frontend/lib/validate-flow-graph.ts` is tested today, independent of any component-testing infrastructure.
- **Trigger-node-already-exists case:** unchanged — `addNode` already returns `false` when a second trigger node would be added; both the drag path (`Canvas.tsx` `onDrop`) and the new tap path show the existing toast, "一个流程只能有一个触发节点."

## Known risk (not solved by this change, flagged for verification)

Tooltip-wrapped elements often need two taps on touch browsers (first tap opens the hover/tooltip state, second tap actually fires the click). `DraggableItem` is wrapped in `Tooltip`/`TooltipTrigger`. This is a real risk that must be checked during manual verification (real phone or Chrome device-mode); if tap requires two taps to register, switch to an `onTouchEnd` handler or adjust event handling — do not silently ship a "double-tap to add" experience.

## Testing

- Unit test (in `flow/tests/unit/`, plain vitest, no DOM): the viewport-center + collision-offset function described above.
- No React component test infrastructure exists in this repo (the current `vitest.config.ts` runs on the `@cloudflare/vitest-pool-workers` pool — `workerd`, not `jsdom`) and none is being added for this small change. The click/CSS-breakpoint behavior itself is verified manually: `wrangler dev` (or equivalent local frontend dev server) + Chrome device-mode / a real phone, confirming:
  - Sidebar renders single-column below 768px, 2-column at/above it.
  - Tapping a tile below 768px adds the node at the visible canvas center (single tap, not double).
  - Desktop click on a tile still does nothing; drag-and-drop still works.
  - Tapping a trigger tile when a trigger node already exists shows the existing "one trigger per flow" toast instead of adding a second one.
