# Channel Brand Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every ad hoc emoji/Unicode "icon" that stands in for X, TikTok, or YouTube (across the `flow` and `link` modules) with the channel's real brand mark, pulled from one shared source.

**Architecture:** One new/moved set of brand-icon React components lives in `shared/frontend/ui/icons.tsx` (the codebase's existing "common to all modules" location). Both `flow` and `link` frontends import from there instead of each maintaining their own copy or falling back to emoji. No new build tooling, no new test framework — the two tasks with real branching logic (a type change and a mapping function) get TDD unit tests using the existing `flow` vitest-pool-workers setup (already proven able to import `.tsx` component files); the remaining tasks are pure JSX/prop swaps verified by `tsc --noEmit` per task and one final live-browser pass across both modules' dev deployments.

**Tech Stack:** React (Vite), TypeScript, Radix UI (`@radix-ui/react-tooltip`), lucide-react, Vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- New/moved icon components live in `shared/frontend/ui/icons.tsx`, named `XIcon` / `TikTokIcon` / `YouTubeIcon` (the `*Icon` suffix convention already used throughout this codebase), each `({ className = "w-4 h-4" }: { className?: string }) => JSX.Element`.
- `YouTubeIcon` is monochrome (single `<path>`, `fill="currentColor"`), matching `XIcon`/`TikTokIcon`'s style — not YouTube's two-tone red/white official palette. Path data: `M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z` (viewBox `0 0 24 24`, sourced from Simple Icons' official YouTube glyph).
- Non-channel node icons (addToList 📋, webhook 🔗, cron ⏰, changeUserProps ✏️, waitForEvent 🔍, wait ⏳, timeCondition 🕐, userPropsCondition 👤, abSplit ⚡, videoCondition 👁️) are out of scope — do not touch them.
- Every icon touched inside `flow/frontend/nodes/*.tsx` (the canvas node components) gets wrapped in `Tooltip`/`TooltipTrigger`/`TooltipContent` (`shared/frontend/ui/tooltip`) showing the channel/action name as plain text.
- `Sidebar.tsx`'s items already have tooltips via `DraggableItem`'s existing `Tooltip` wrapper — no change needed there beyond the icon prop itself.

---

### Task 1: Add `TikTokIcon` and `YouTubeIcon` to `shared/frontend/ui/icons.tsx`

**Files:**
- Modify: `shared/frontend/ui/icons.tsx`

**Interfaces:**
- Produces: `XIcon` (unchanged, already exists), `TikTokIcon`, `YouTubeIcon` — all `({ className = "w-4 h-4" }: { className?: string }) => JSX.Element`, exported from `shared/frontend/ui/icons.tsx`.

This is a pure presentational addition (two new SVG-returning components, no branching logic) — no TDD cycle applies. Verified by `tsc --noEmit`; `TikTokIcon` and `YouTubeIcon` get a referential-identity check in Task 6's test (the first task that actually branches on which icon to use), the same way Task 2's test checks `XIcon`.

- [ ] **Step 1: Read the current file**

`shared/frontend/ui/icons.tsx` currently contains only:

```tsx
export function XIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
```

- [ ] **Step 2: Append `TikTokIcon` and `YouTubeIcon`**

Add to the end of `shared/frontend/ui/icons.tsx` (leave the existing `XIcon` untouched):

```tsx

export function TikTokIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-label="TikTok">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .54.04.79.1V9.4a6.33 6.33 0 00-.79-.05A6.34 6.34 0 003.15 15.7 6.34 6.34 0 009.49 22a6.34 6.34 0 006.34-6.34V9.04a8.16 8.16 0 004.77 1.52V7.11a4.85 4.85 0 01-1.01-.42z" />
    </svg>
  );
}

export function YouTubeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-label="YouTube">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}
```

- [ ] **Step 3: Type-check**

Run (from repo root): `cd flow && npx tsc --noEmit`
Expected: no new errors (this file isn't imported anywhere yet in this task, so nothing should change).

- [ ] **Step 4: Commit**

```bash
git add shared/frontend/ui/icons.tsx
git commit -m "feat(shared): add TikTokIcon and YouTubeIcon brand components"
```

---

### Task 2: `ChannelTypeDefinition.icon` becomes a component

**Files:**
- Modify: `flow/frontend/config/trigger-fields.ts`
- Test: `flow/tests/unit/channel-types.test.ts`

**Interfaces:**
- Consumes: `XIcon` from `shared/frontend/ui/icons.tsx` (Task 1).
- Produces: `ChannelTypeDefinition.icon: React.ComponentType<{ className?: string }>` (was `string`). `CHANNEL_TYPES` and `getChannelTypes()` keep their existing names/signatures — only the `icon` field's type and value change.

- [ ] **Step 1: Write the failing test**

Add to `flow/tests/unit/channel-types.test.ts` (new `it` inside the existing `describe("CHANNEL_TYPES", ...)` block):

```ts
import { XIcon } from "../../../shared/frontend/ui/icons";
```

(add this import at the top of the file, alongside the existing imports)

```ts
  it("gives the X channel type the shared XIcon brand component, not a string glyph", () => {
    const x = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!;
    expect(x.icon).toBe(XIcon);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/channel-types.test.ts`
Expected: FAIL — `x.icon` is currently the string `"𝕏"`, not the `XIcon` function, so `toBe(XIcon)` fails.

- [ ] **Step 3: Update `trigger-fields.ts`**

In `flow/frontend/config/trigger-fields.ts`, add the import near the top (after the existing imports):

```ts
import { XIcon } from "../../../shared/frontend/ui/icons";
```

Change the `ChannelTypeDefinition` interface's `icon` field (currently `icon: string;`):

```ts
export interface ChannelTypeDefinition {
  channelType: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  events: EventDefinition[];
  /** flowType:"action" entries for this channel — mirrors `events`, which is flowType:"trigger". */
  actions: EventDefinition[];
}
```

Change the X entry inside `getChannelTypes()` (currently `icon: "𝕏",`):

```ts
  return [
    {
      channelType: "X",
      label: "X",
      icon: XIcon,
      events: xEvents,
      actions: xActions,
    },
  ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/channel-types.test.ts`
Expected: PASS (3/3 — the 2 existing tests plus the new one).

- [ ] **Step 5: Type-check the whole module**

Run: `cd flow && npx tsc --noEmit`
Expected: errors in `XTriggerNode.tsx` and `Sidebar.tsx` (both still treat `ct.icon`/`ctDef.icon` as a string) — these are exactly the files Tasks 3 and 5 fix. Confirm the errors are only in those two files, nowhere else.

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/config/trigger-fields.ts flow/tests/unit/channel-types.test.ts
git commit -m "feat(flow): ChannelTypeDefinition.icon is a component, not a string"
```

---

### Task 3: Channel trigger nodes — real icons + tooltips

**Files:**
- Modify: `flow/frontend/nodes/XTriggerNode.tsx`
- Modify: `flow/frontend/nodes/XContentTriggerNode.tsx`
- Modify: `flow/frontend/nodes/YouTubeContentTriggerNode.tsx`
- Modify: `flow/frontend/pages/EditorPage.tsx`

**Interfaces:**
- Consumes: `XIcon`, `YouTubeIcon` (Task 1); `ChannelTypeDefinition.icon` as a component (Task 2).
- Produces: a `TooltipProvider` ancestor wrapping the canvas in `EditorPage.tsx`, which Task 4's `ActionNode.tsx` also relies on.

This task is a pure JSX/prop swap (no branching logic) — no TDD cycle. Verified by `tsc --noEmit` per step and the final live-browser pass (Task 8).

- [ ] **Step 1: Add `TooltipProvider` around the editor's canvas**

Canvas nodes (React Flow) render as siblings of `Sidebar`, not descendants of `Sidebar`'s own local `TooltipProvider` — so a `Tooltip` inside a node component has no ancestor `TooltipProvider` today and will not work. Add one wrapping the whole editor.

In `flow/frontend/pages/EditorPage.tsx`, add this import alongside the existing ones:

```tsx
import { TooltipProvider } from "../../../shared/frontend/ui/tooltip";
```

Change the return statement (currently):

```tsx
  return (
    <ReactFlowProvider>
      <div className="h-screen flex flex-col">
        <EditorToolbar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <Canvas />
          <Inspector />
        </div>
      </div>
    </ReactFlowProvider>
  );
```

to:

```tsx
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <div className="h-screen flex flex-col">
          <EditorToolbar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <Canvas />
            <Inspector />
          </div>
        </div>
      </ReactFlowProvider>
    </TooltipProvider>
  );
```

(Nesting this new outer `TooltipProvider` around `Sidebar`'s own inner one is safe — Radix tooltip providers nest without conflict.)

- [ ] **Step 2: `XTriggerNode.tsx` — render `ctDef.icon` as a component, add tooltip**

Current file:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";

export default function TriggerNode({ data, selected }: NodeProps) {
  const channelType = data.channelType as string | undefined;
  const eventType = data.eventType as string | undefined;
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const title = ctDef ? `${ctDef.label} Trigger` : "Trigger";
  const subtitle = evDef?.label || "Select event...";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">{ctDef?.icon || "⚡"}</span>
        <div>
          <span className="font-semibold text-sm text-purple-700">{title}</span>
          {eventType && (
            <p className="text-xs text-gray-500">{subtitle}</p>
          )}
          {!eventType && (
            <p className="text-xs text-gray-400 italic">Not configured</p>
          )}
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
```

Replace it with:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import AnalyticsBadges from "./AnalyticsBadges";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";

export default function TriggerNode({ data, selected }: NodeProps) {
  const channelType = data.channelType as string | undefined;
  const eventType = data.eventType as string | undefined;
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  const title = ctDef ? `${ctDef.label} Trigger` : "Trigger";
  const subtitle = evDef?.label || "Select event...";
  const Icon = ctDef?.icon;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        {Icon ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span><Icon className="w-4 h-4" /></span>
            </TooltipTrigger>
            <TooltipContent>{ctDef.label}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-lg">⚡</span>
        )}
        <div>
          <span className="font-semibold text-sm text-purple-700">{title}</span>
          {eventType && (
            <p className="text-xs text-gray-500">{subtitle}</p>
          )}
          {!eventType && (
            <p className="text-xs text-gray-400 italic">Not configured</p>
          )}
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
```

- [ ] **Step 3: `XContentTriggerNode.tsx` — swap `𝕏` for `XIcon`, add tooltip**

Current file:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY, CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../../nodeTypeRegistry";

export default function XContentTriggerNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const mode = data.mode as string;
  const subtitle = mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
    ? `List: ${(data.listName as string) || "(not selected)"}`
    : "My own posts";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-purple-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">𝕏</span>
        <div>
          <span className="font-semibold text-sm text-purple-700">{NODE_TYPE_REGISTRY.xContentTrigger.label}</span>
          <p className="text-xs text-gray-500">{subtitle}</p>
          {condCount > 0 && (
            <p className="text-xs text-purple-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}
```

Replace the import block and the icon `<span>` line:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY, CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../../nodeTypeRegistry";
import { XIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
```

```tsx
        <Tooltip>
          <TooltipTrigger asChild>
            <span><XIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>X</TooltipContent>
        </Tooltip>
```

(replacing `<span className="text-lg">𝕏</span>`; everything else in the file is unchanged)

- [ ] **Step 4: `YouTubeContentTriggerNode.tsx` — swap `▶️` for `YouTubeIcon`, add tooltip**

Current file:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

export default function YouTubeContentTriggerNode({ data, selected }: NodeProps) {
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;
  const channelName = (data.subscriptionChannelName as string) || "(no subscription selected)";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-red-300"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-lg">▶️</span>
        <div>
          <span className="font-semibold text-sm text-red-700">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</span>
          <p className="text-xs text-gray-500">{channelName}</p>
          {condCount > 0 && (
            <p className="text-xs text-red-500">{condCount} condition{condCount > 1 ? "s" : ""}</p>
          )}
        </div>
      </div>
      <AnalyticsBadges analytics={data._analytics as any} />
      <Handle type="source" position={Position.Right} className="!bg-red-500 !w-3 !h-3" />
    </div>
  );
}
```

Replace the import block and the icon `<span>` line:

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
```

```tsx
        <Tooltip>
          <TooltipTrigger asChild>
            <span><YouTubeIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>YouTube</TooltipContent>
        </Tooltip>
```

(replacing `<span className="text-lg">▶️</span>`; everything else in the file is unchanged)

- [ ] **Step 5: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: the two errors from Task 2 Step 5 (`XTriggerNode.tsx`, and any remaining in `Sidebar.tsx`) — confirm `XTriggerNode.tsx` no longer errors; `Sidebar.tsx` still does (fixed in Task 5).

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/nodes/XTriggerNode.tsx flow/frontend/nodes/XContentTriggerNode.tsx flow/frontend/nodes/YouTubeContentTriggerNode.tsx flow/frontend/pages/EditorPage.tsx
git commit -m "feat(flow): channel trigger nodes use real brand icons + tooltips"
```

---

### Task 4: `ActionNode.tsx` — real icons + tooltips for X/TikTok actions

**Files:**
- Modify: `flow/frontend/nodes/ActionNode.tsx`

**Interfaces:**
- Consumes: `XIcon`, `TikTokIcon` (Task 1); the `TooltipProvider` added to `EditorPage.tsx` (Task 3).

Pure JSX/prop swap — no TDD cycle. Verified by `tsc --noEmit` and the final live-browser pass (Task 8).

- [ ] **Step 1: Read the current file**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { t as localizeLabel } from "../../../metadata/locale";

const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction", "tiktokContentAction", "videoAction"];
const X_ACTION_COUNT = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions.length;
const CONTENT_X_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");

export default function ActionNode({ data, selected }: NodeProps) {
  const actionType = data.actionType as string;
  const isExternalApi = EXTERNAL_API_ACTIONS.includes(actionType);

  let label: string;
  let description: string | undefined;
  let icon: string;
  let isConfigured: boolean;

  if (actionType === "addToList") {
    const listName = data.listName as string;
    label = NODE_TYPE_REGISTRY.addToList.label!;
    description = listName || "Select a list...";
    icon = "📋";
    isConfigured = !!listName;
  } else if (actionType === "xAction") {
    const xEvent = data.xEvent as string;
    label = NODE_TYPE_REGISTRY.xAction.label!;
    description = xEvent === "follow-user" ? "Follow User"
      : xEvent === "unfollow-user" ? "Unfollow User"
      : xEvent === "create-dm" ? "Direct Message"
      : xEvent === "mute-user" ? "Mute User"
      : `${X_ACTION_COUNT} actions`;
    icon = "𝕏";
    isConfigured = !!xEvent;
  } else if (actionType === "xContentAction") {
    const operation = (data.operation as string) || "create-post";
    const selectedOperation = CONTENT_X_ACTION_OPERATIONS.find((op) => op.sourceContentType === operation);
    label = NODE_TYPE_REGISTRY.xContentAction.label!;
    description = selectedOperation?.label ? localizeLabel(selectedOperation.label, "en") : undefined;
    icon = "✨";
    isConfigured = !!selectedOperation;
  } else if (actionType === "tiktokContentAction") {
    const channelId = data.channelId as string;
    label = NODE_TYPE_REGISTRY.tiktokContentAction.label!;
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = "📸";
    isConfigured = !!channelId;
  } else if (actionType === "videoAction") {
    label = NODE_TYPE_REGISTRY.videoAction.label!;
    description = NODE_TYPE_REGISTRY.videoAction.description;
    icon = "🎬";
    isConfigured = true;
  } else {
    label = "Action";
    description = "Unknown action";
    icon = "⚡";
    isConfigured = false;
  }

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-green-300"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
      {description && (
        <p className={`text-xs ${isConfigured ? "text-gray-500" : "text-gray-400 italic"}`}>
          {description}
        </p>
      )}
      <AnalyticsBadges analytics={data._analytics as any} />
      {isExternalApi && (
        <>
          <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "35%", transform: "translateY(-50%)" }}>Success</span>
          <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "65%", transform: "translateY(-50%)" }}>Failed</span>
        </>
      )}
      {isExternalApi ? (
        <>
          <Handle type="source" position={Position.Right} id="success"
            className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "35%" }} />
          <Handle type="source" position={Position.Right} id="failed"
            className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "65%" }} />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className="!bg-green-500 !w-3 !h-3" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Change `icon`'s type to a component, and each branch's assignment**

Add imports:

```tsx
import { XIcon, TikTokIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
```

Change `let icon: string;` to `let icon: React.ComponentType<{ className?: string }> | string;` (stays a union — `addToList`/`videoAction` keep their emoji, `xAction`/`xContentAction`/`tiktokContentAction` become components):

```tsx
  let icon: React.ComponentType<{ className?: string }> | string;
```

Change the three affected branches' `icon =` lines:

```tsx
    icon = XIcon; // was "𝕏" (xAction branch)
```
```tsx
    icon = XIcon; // was "✨" (xContentAction branch)
```
```tsx
    icon = TikTokIcon; // was "📸" (tiktokContentAction branch)
```

(`addToList`'s `icon = "📋"`, `videoAction`'s `icon = "🎬"`, and the fallback `icon = "⚡"` are unchanged.)

- [ ] **Step 3: Render `icon` as either a component or an emoji string, wrapped in a tooltip**

JSX requires a capitalized variable to be treated as a component — the lowercase `icon` variable would be parsed as a literal DOM tag if used directly as `<icon .../>`. Add one line right before the `return` statement to alias it:

```tsx
  const IconComponent = typeof icon === "string" ? null : icon;
```

Replace:

```tsx
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
```

with:

```tsx
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              {IconComponent ? <IconComponent className="w-4 h-4" /> : <span className="text-lg">{icon as string}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
```

- [ ] **Step 4: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: no errors in `ActionNode.tsx`.

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/nodes/ActionNode.tsx
git commit -m "feat(flow): X/TikTok action nodes use real brand icons + tooltips"
```

---

### Task 5: `Sidebar.tsx` — real icons in the drag palette

**Files:**
- Modify: `flow/frontend/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `XIcon`, `TikTokIcon`, `YouTubeIcon` (Task 1); `ChannelTypeDefinition.icon` as a component (Task 2).
- Produces: `DraggableItemProps.icon: React.ReactNode` (was `string`) — later tasks don't depend on this, but any future sidebar item must pass a `ReactNode` (plain string emoji still works, since strings are valid `ReactNode`s).

Pure JSX/prop swap — no TDD cycle. Verified by `tsc --noEmit` and the final live-browser pass (Task 8).

- [ ] **Step 1: Widen `DraggableItemProps.icon`**

In `flow/frontend/components/Sidebar.tsx`, change:

```tsx
interface DraggableItemProps {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: string;
}
```

to:

```tsx
interface DraggableItemProps {
  type: string;
  label: string;
  description: string;
  color: string;
  icon: React.ReactNode;
}
```

(The `DraggableItem` function body itself — `<span className="text-lg leading-none">{icon}</span>` — needs no change; a `ReactNode` renders the same way a `string` did.)

- [ ] **Step 2: Add the icon imports**

Add near the top of the file, alongside the existing imports:

```tsx
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
```

- [ ] **Step 3: Switch the six affected call sites**

The `xTrigger` loop — change:

```tsx
          <DraggableItem
            key={ct.channelType}
            type="xTrigger"
            label={`${ct.label} Trigger`}
            description={`${ct.events.length} triggers`}
            color="border-primary/30 bg-primary/5"
            icon={ct.icon}
          />
```

to:

```tsx
          <DraggableItem
            key={ct.channelType}
            type="xTrigger"
            label={`${ct.label} Trigger`}
            description={`${ct.events.length} triggers`}
            color="border-primary/30 bg-primary/5"
            icon={<ct.icon className="w-4 h-4" />}
          />
```

The five single-line items — change each `icon="..."` string to the matching component:

```tsx
      el: <DraggableItem key="xContentTrigger" type="xContentTrigger" label={NODE_TYPE_REGISTRY.xContentTrigger.label!} description={NODE_TYPE_REGISTRY.xContentTrigger.description!} color="border-primary/30 bg-primary/5" icon={<XIcon className="w-4 h-4" />} />,
```
```tsx
      el: <DraggableItem key="youtubeContentTrigger" type="youtubeContentTrigger" label={NODE_TYPE_REGISTRY.youtubeContentTrigger.label!} description={NODE_TYPE_REGISTRY.youtubeContentTrigger.description!} color="border-primary/30 bg-primary/5" icon={<YouTubeIcon className="w-4 h-4" />} />,
```
```tsx
      el: <DraggableItem key="xAction" type="xAction" label={NODE_TYPE_REGISTRY.xAction.label!} description={NODE_TYPE_REGISTRY.xAction.description!} color="border-accent bg-accent/50" icon={<XIcon className="w-4 h-4" />} />,
```
```tsx
      el: <DraggableItem key="xContentAction" type="xContentAction" label={NODE_TYPE_REGISTRY.xContentAction.label!} description={NODE_TYPE_REGISTRY.xContentAction.description!} color="border-accent bg-accent/50" icon={<XIcon className="w-4 h-4" />} />,
```
```tsx
      el: <DraggableItem key="tiktokContentAction" type="tiktokContentAction" label={NODE_TYPE_REGISTRY.tiktokContentAction.label!} description={NODE_TYPE_REGISTRY.tiktokContentAction.description!} color="border-accent bg-accent/50" icon={<TikTokIcon className="w-4 h-4" />} />,
```

(Match each line by its `key="..."` — only the trailing `icon="..."`/`icon={ct.icon}` attribute changes on each; everything else on the line is unchanged.)

- [ ] **Step 4: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: zero errors across the whole `flow` module (this was the last of the two files flagged back in Task 2 Step 5).

- [ ] **Step 5: Commit**

```bash
git add flow/frontend/components/Sidebar.tsx
git commit -m "feat(flow): sidebar drag palette uses real brand icons"
```

---

### Task 6: `FlowsPage.tsx` — fix the flows-list node-type badges

**Files:**
- Modify: `flow/frontend/pages/FlowsPage.tsx`
- Test: `flow/tests/unit/flows-page-node-icon.test.tsx` (new)

**Interfaces:**
- Consumes: `XIcon` (already imported here), `TikTokIcon`, `YouTubeIcon` (Task 1); `Clapperboard` from `lucide-react`.
- Produces: `getNodeIcon` becomes exported (was module-local) so it's unit-testable; signature unchanged: `(type: string, data: Record<string, unknown>) => React.ComponentType<{ className?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/flows-page-node-icon.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { getNodeIcon } from "../../frontend/pages/FlowsPage";
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";

describe("getNodeIcon", () => {
  it("maps xContentTrigger to XIcon, not a generic document icon", () => {
    expect(getNodeIcon("xContentTrigger", {})).toBe(XIcon);
  });

  it("maps youtubeContentTrigger to YouTubeIcon", () => {
    expect(getNodeIcon("youtubeContentTrigger", {})).toBe(YouTubeIcon);
  });

  it("maps xContentAction to XIcon, not a generic document icon", () => {
    expect(getNodeIcon("action", { actionType: "xContentAction" })).toBe(XIcon);
  });

  it("maps tiktokContentAction to TikTokIcon, not a generic document icon", () => {
    expect(getNodeIcon("action", { actionType: "tiktokContentAction" })).toBe(TikTokIcon);
  });

  it("does not mislabel videoAction with the X icon", () => {
    expect(getNodeIcon("action", { actionType: "videoAction" })).not.toBe(XIcon);
  });

  it("still maps xAction (the only remaining action default) to XIcon", () => {
    expect(getNodeIcon("action", { actionType: "xAction" })).toBe(XIcon);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/flows-page-node-icon.test.tsx`
Expected: FAIL — `getNodeIcon` isn't exported yet (import error), and even once exported, the first four assertions fail against today's `FileTextIcon`/missing-case/`XIcon` mappings.

- [ ] **Step 3: Update `FlowsPage.tsx`**

Add to the existing lucide-react import line (currently `import { Pencil as EditIcon, Search as SearchIcon, Clock as ClockIcon, List as ListIcon, FileText as FileTextIcon } from "lucide-react";`):

```tsx
import { Pencil as EditIcon, Search as SearchIcon, Clock as ClockIcon, List as ListIcon, FileText as FileTextIcon, Clapperboard as ClapperboardIcon } from "lucide-react";
```

Replace the existing `XIcon`-only import line:

```tsx
import { XIcon } from "../../../shared/frontend/ui/icons";
```

with:

```tsx
import { XIcon, TikTokIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
```

Replace `getNodeIcon` (currently):

```ts
function getNodeIcon(type: string, data: Record<string, unknown>) {
  if (type === "xTrigger") return XIcon;
  if (type === "xContentTrigger") return FileTextIcon;
  if (type === "waitForEvent") return SearchIcon;
  if (type === "wait") return ClockIcon;
  if (type === "action") {
    const at = data.actionType as string;
    if (at === "addToList") return ListIcon;
    if (at === "xContentAction") return FileTextIcon;
    if (at === "tiktokContentAction") return FileTextIcon;
    return XIcon;
  }
  return ClockIcon;
}
```

with:

```ts
export function getNodeIcon(type: string, data: Record<string, unknown>) {
  if (type === "xTrigger") return XIcon;
  if (type === "xContentTrigger") return XIcon;
  if (type === "youtubeContentTrigger") return YouTubeIcon;
  if (type === "waitForEvent") return SearchIcon;
  if (type === "wait") return ClockIcon;
  if (type === "action") {
    const at = data.actionType as string;
    if (at === "addToList") return ListIcon;
    if (at === "xContentAction") return XIcon;
    if (at === "tiktokContentAction") return TikTokIcon;
    if (at === "videoAction") return ClapperboardIcon;
    return XIcon;
  }
  return ClockIcon;
}
```

(`FileTextIcon` is now unused in this file — remove it from the lucide-react import line rather than leaving a dead import: `import { Pencil as EditIcon, Search as SearchIcon, Clock as ClockIcon, List as ListIcon, Clapperboard as ClapperboardIcon } from "lucide-react";`)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/flows-page-node-icon.test.tsx`
Expected: PASS (6/6).

- [ ] **Step 5: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add flow/frontend/pages/FlowsPage.tsx flow/tests/unit/flows-page-node-icon.test.tsx
git commit -m "feat(flow): flows-list badges use real brand icons, fix videoAction mislabel"
```

---

### Task 7: `link` module — consolidate onto the shared icons

**Files:**
- Modify: `link/frontend/lib/channelLogos.tsx`
- Modify: `link/frontend/lib/channelRegistry.tsx`
- Modify: `link/frontend/components/SocialChannels.tsx`

**Interfaces:**
- Consumes: `XIcon`, `TikTokIcon`, `YouTubeIcon` (Task 1).

Pure import/JSX swap — no TDD cycle. Verified by `tsc --noEmit` and the final live-browser pass (Task 8).

- [ ] **Step 1: Remove the duplicated logos from `channelLogos.tsx`**

Current file:

```tsx
// Shared brand SVG logos for channel cards. Keep one icon per channel here so
// both the bespoke X cards and the generic simple-channel registry can reuse them.
import { FolderOpen } from "lucide-react";

export function XLogo() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor" aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

export function TikTokLogo() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor" aria-label="TikTok">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .54.04.79.1V9.4a6.33 6.33 0 00-.79-.05A6.34 6.34 0 003.15 15.7 6.34 6.34 0 009.49 22a6.34 6.34 0 006.34-6.34V9.04a8.16 8.16 0 004.77 1.52V7.11a4.85 4.85 0 01-1.01-.42z"/>
    </svg>
  );
}

export function NotionLogo() {
  ...
}

export function LocalLogo() {
  return <FolderOpen className="w-8 h-8" strokeWidth={1.75} aria-label="Local files" />;
}
```

Delete the `XLogo` and `TikTokLogo` functions entirely (keep `NotionLogo` and `LocalLogo` untouched — they're only used within `link`). Update the file's header comment:

```tsx
// Shared brand SVG logos for channel cards that don't have a shared/frontend
// equivalent (X/TikTok/YouTube live in shared/frontend/ui/icons.tsx instead,
// since flow needs them too).
import { FolderOpen } from "lucide-react";

export function NotionLogo() {
  ...
}

export function LocalLogo() {
  return <FolderOpen className="w-8 h-8" strokeWidth={1.75} aria-label="Local files" />;
}
```

- [ ] **Step 2: `channelRegistry.tsx` — import `TikTokIcon` from shared**

Change:

```ts
import { TikTokLogo } from "./channelLogos";
```

to:

```ts
import { TikTokIcon } from "../../../shared/frontend/ui/icons";
```

Change the one call site (currently `logo: <TikTokLogo />,`) to:

```ts
    logo: <TikTokIcon className="w-8 h-8" />,
```

- [ ] **Step 3: `SocialChannels.tsx` — import `XIcon`/`YouTubeIcon` from shared**

Change:

```tsx
import { XLogo } from "../lib/channelLogos";
```

to:

```tsx
import { XIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
```

Change all 3 `<XLogo />` call sites to `<XIcon className="w-8 h-8" />`.

Change the `YouTubeAccountCard`'s logo prop (currently):

```tsx
      logo={<span className="text-2xl leading-none">▶️</span>}
```

to:

```tsx
      logo={<YouTubeIcon className="w-8 h-8" />}
```

- [ ] **Step 4: Type-check**

Run: `cd link && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add link/frontend/lib/channelLogos.tsx link/frontend/lib/channelRegistry.tsx link/frontend/components/SocialChannels.tsx
git commit -m "feat(link): consolidate X/TikTok/YouTube icons onto shared/frontend"
```

---

### Task 8: Deploy to dev and verify live in-browser

**Files:** none (deployment + manual verification only)

**Interfaces:** none — this is the final task, depends on all of Tasks 1–7.

- [ ] **Step 1: Deploy both modules to dev**

```bash
cd flow && npm run deploy:dev
cd ../link && npm run deploy:dev
```

Expected: both deploys succeed with no build errors.

- [ ] **Step 2: Verify the `link` module's YouTube channel card**

Navigate to `https://link-dev.uni-scrm.com` (channels page). Confirm:
- The YouTube card shows the real play-button brand mark, not `▶️`.
- The X and TikTok cards still show their brand marks (now sourced from `shared`, should look identical to before).

- [ ] **Step 3: Verify the `flow` module's sidebar**

Open `https://flow-dev.uni-scrm.com`, create or open a User Flow. In the sidebar, confirm:
- "X Trigger" shows the real X logo (not `𝕏`).
- "X Action" shows the real X logo (not `𝕏`).
- Hovering each shows a tooltip (pre-existing `DraggableItem` behavior, unaffected by this change — just confirming it still works).

Open or create a Content Flow. In the sidebar, confirm:
- "X Content Trigger" shows the real X logo.
- "YouTube Content Trigger" shows the real YouTube logo (not `▶️`).
- "X Action" (content) shows the real X logo (not `✨`).
- "TikTok Action" shows the real TikTok logo (not `📸`).

- [ ] **Step 4: Verify canvas nodes and tooltips**

Drag an X Trigger, X Content Trigger, YouTube Content Trigger, X Action, X Content Action (X Action in content domain), and TikTok Action node onto the canvas. Confirm each renders its real brand icon, and hovering the icon shows a tooltip with the channel/action name (e.g. "X", "YouTube", "TikTok"). Confirm non-channel nodes (e.g. Add to List, Webhook) are visually unchanged.

- [ ] **Step 5: Verify the flows list page**

Navigate to the flows list. Confirm a flow containing `xContentTrigger`/`xContentAction`/`tiktokContentAction`/`youtubeContentTrigger`/`videoAction` nodes shows the correct distinct icon for each in its row badges (no more generic document icon, no more `videoAction` mislabeled as X).

- [ ] **Step 6: Report results**

If all checks pass, this plan is complete. If anything looks wrong, note exactly which surface/node type and revisit the relevant task above rather than patching ad hoc.
