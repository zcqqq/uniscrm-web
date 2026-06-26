# Flow Engine Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add event_time to all triggers, rename node types for consistency, and add success/failed branching to external API actions.

**Architecture:** Three independent changes applied in sequence: (1) metadata-level event_time prop, (2) string renames across frontend + backend + DB migration, (3) action branching with engine execution changes.

**Tech Stack:** TypeScript, React Flow, Hono, Cloudflare D1, Workers Queue

## Global Constraints

- All node type strings must match between frontend (nodes, store, sidebar, inspector, canvas, templates) and backend (engine.ts, queue handler)
- DB migration must handle existing `graph_json` data
- Build must pass: `cd flow && npx vite build`
- Engine tests: `npx tsx /tmp/test-engine.mjs`

---

### Task 1: Add event_time as Default Event Prop

**Files:**
- Modify: `flow/frontend/config/trigger-fields.ts`
- Test: manual — open flow editor, add trigger, add condition, verify "Event Time" is first in list

**Interfaces:**
- Produces: `EVENT_TIME_FIELD` constant prepended to every event's `contextFields`

- [ ] **Step 1: Add EVENT_TIME_FIELD to trigger-fields.ts**

In `getChannelTypes()`, prepend the system field before eventProps:

```typescript
export function getChannelTypes(locale: Locale = "en"): ChannelTypeDefinition[] {
  const eventTimeField: TriggerFieldDefinition = {
    id: "event_time",
    label: t({ en: "Event Time", zh: "事件时间" }, locale),
    dataType: "string",
    operators: STRING_OPS,
    group: "event",
  };

  const xEvents = METADATA_X
    .filter((m) => m.flowType === "trigger")
    .map((m) => ({
      eventType: m.eventType,
      label: t(m.label, locale),
      description: m.description ? t(m.description, locale) : "",
      contextFields: [
        eventTimeField,
        ...m.eventProps.map((p) => propToField(p.propId, locale, "event")),
        ...m.userProps.map((p) => propToField(p.propId, locale, "user")),
      ].filter(Boolean) as TriggerFieldDefinition[],
    }));

  return [{ channelType: "X", label: "X", icon: "𝕏", events: xEvents }];
}
```

- [ ] **Step 2: Build and verify**

```bash
cd flow && npx vite build
```

Expected: Build passes, no errors.

- [ ] **Step 3: Commit**

```bash
git add flow/frontend/config/trigger-fields.ts
git commit -m "feat(flow): add event_time as first Event Prop on all triggers"
```

---

### Task 2: Rename Node Types (Frontend)

**Files:**
- Rename: `flow/frontend/nodes/TriggerNode.tsx` → `flow/frontend/nodes/XTriggerNode.tsx`
- Rename: `flow/frontend/nodes/EventHistoryNode.tsx` → `flow/frontend/nodes/WaitForEventNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/components/Canvas.tsx`
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/config/templates.ts`
- Modify: `flow/frontend/pages/AnalyticsPage.tsx`
- Modify: `flow/frontend/pages/EditorPage.tsx`

**Interfaces:**
- Produces: Node type `"xTrigger"` replaces `"trigger"`, `"waitForEvent"` replaces `"eventHistory"` everywhere in frontend

- [ ] **Step 1: Rename node component files**

```bash
cd flow/frontend/nodes
mv TriggerNode.tsx XTriggerNode.tsx
mv EventHistoryNode.tsx WaitForEventNode.tsx
```

- [ ] **Step 2: Update nodes/index.ts**

```typescript
import XTriggerNode from "./XTriggerNode";
import ActionNode from "./ActionNode";
import WaitNode from "./WaitNode";
import WaitForEventNode from "./WaitForEventNode";

export const nodeTypes = {
  xTrigger: XTriggerNode,
  action: ActionNode,
  wait: WaitNode,
  waitForEvent: WaitForEventNode,
};
```

- [ ] **Step 3: Update flow-editor.ts**

Replace `isValidConnection`:
```typescript
function isValidConnection(source: Node | undefined, target: Node | undefined): boolean {
  if (!source || !target) return false;
  const targetType = target.type;
  const sourceType = source.type;
  if (targetType === "xTrigger") return false;
  const validTargets = ["action", "wait", "waitForEvent"];
  const validSources = ["xTrigger", "wait", "waitForEvent", "action"];
  if (validSources.includes(sourceType!) && validTargets.includes(targetType!)) return true;
  return false;
}
```

Update `addNode`:
```typescript
addNode: (type, position) => {
  let nodeType: string;
  let data: Record<string, unknown>;

  if (type === "xTrigger") {
    nodeType = "xTrigger";
    data = { channelType: "X", eventType: "", channelId: "" };
  } else if (type === "wait") {
    nodeType = "wait";
    data = { duration: 0, unit: "minutes" };
  } else if (type === "waitForEvent") {
    nodeType = "waitForEvent";
    data = { eventType: "", channelId: "", duration: 1, unit: "days", conditions: [] };
  } else if (ACTION_TYPES.includes(type)) {
    nodeType = "action";
    if (type === "addToList") {
      data = { actionType: type, listId: "", listName: "" };
    } else if (type === "xAction") {
      data = { actionType: type, xEvent: "", channelId: "" };
    } else {
      return;
    }
  } else {
    return;
  }
  // ... rest unchanged
```

- [ ] **Step 4: Update Sidebar.tsx**

Change trigger drag type from `trigger:${ct.channelType}` to direct type name:
```typescript
<DraggableItem
  key={ct.channelType}
  type="xTrigger"
  label={ct.label}
  description={`${ct.events.length} events`}
  color="border-purple-200 bg-purple-50/50"
  icon={ct.icon}
/>
```

Change `"eventHistory"` to `"waitForEvent"`:
```typescript
<DraggableItem
  type="waitForEvent"
  label="Wait for Event"
  description="Check if event has occurred"
  color="border-indigo-200 bg-indigo-50/50"
  icon="🔍"
/>
```

- [ ] **Step 5: Update Canvas.tsx isValidConnection**

```typescript
const isValidConnection = useCallback(
  (connection: Edge | Connection) => {
    const source = nodes.find((n) => n.id === connection.source);
    const target = nodes.find((n) => n.id === connection.target);
    if (!source || !target) return false;
    if (target.type === "xTrigger") return false;
    const validTargets = ["action", "wait", "waitForEvent"];
    const validSources = ["xTrigger", "wait", "waitForEvent", "action"];
    if (validSources.includes(source.type!) && validTargets.includes(target.type!)) return true;
    return false;
  },
  [nodes]
);
```

- [ ] **Step 6: Update Inspector.tsx**

Rename components:
- `TriggerInspector` → `XTriggerInspector`
- `EventHistoryInspector` → `WaitForEventInspector`

Update type checks in the `Inspector` component:
```typescript
{node.type === "xTrigger" && (
  <XTriggerInspector nodeId={node.id} data={node.data as Record<string, any>} />
)}
{node.type === "waitForEvent" && (
  <WaitForEventInspector nodeId={node.id} data={node.data as Record<string, any>} />
)}
```

- [ ] **Step 7: Update templates.ts**

Replace `"trigger"` → `"xTrigger"` and `"eventHistory"` → `"waitForEvent"` in template node types.

- [ ] **Step 8: Update AnalyticsPage.tsx and EditorPage.tsx**

Replace all `"trigger"` type checks with `"xTrigger"` and `"eventHistory"` with `"waitForEvent"`.

- [ ] **Step 9: Build and verify**

```bash
cd flow && npx vite build
```

Expected: Build passes.

- [ ] **Step 10: Commit**

```bash
git add -A flow/frontend/
git commit -m "refactor(flow): rename trigger→xTrigger, eventHistory→waitForEvent in frontend"
```

---

### Task 3: Rename Node Types (Backend Engine + DB Migration)

**Files:**
- Modify: `flow/src/engine.ts`
- Create: `web/migrations/0022_rename_flow_node_types.sql`

**Interfaces:**
- Consumes: Frontend now emits `"xTrigger"` and `"waitForEvent"` in graph_json
- Produces: Engine matches on new type strings; DB migration updates existing rows

- [ ] **Step 1: Update engine.ts — executeFlow trigger matching**

```typescript
const triggerNodes = graph.nodes.filter(
  (n) => n.type === "xTrigger" && (n.data.eventType === eventType || n.data.triggerType === eventType)
);
```

- [ ] **Step 2: Update engine.ts — collectActions node type checks**

Replace `targetNode.type === "eventHistory"` with `targetNode.type === "waitForEvent"` (around line 269).

- [ ] **Step 3: Create DB migration**

File: `web/migrations/0022_rename_flow_node_types.sql`

```sql
UPDATE flows SET graph_json = REPLACE(
  REPLACE(graph_json, '"type":"eventHistory"', '"type":"waitForEvent"'),
  '"type":"trigger"', '"type":"xTrigger"'
) WHERE graph_json LIKE '%"type":"eventHistory"%' OR graph_json LIKE '%"type":"trigger"%';
```

- [ ] **Step 4: Run migration**

```bash
npx wrangler d1 migrations apply uniscrm-db-dev --env dev --config web/wrangler.toml --remote
```

- [ ] **Step 5: Run engine tests**

```bash
npx tsx /tmp/test-engine.mjs
```

Update the test file to use `"xTrigger"` instead of `"trigger"` in test graph nodes.

- [ ] **Step 6: Commit**

```bash
git add flow/src/engine.ts web/migrations/0022_rename_flow_node_types.sql
git commit -m "refactor(flow): rename node types in engine + DB migration"
```

---

### Task 4: Action Success/Failed Branches (Frontend)

**Files:**
- Modify: `flow/frontend/nodes/ActionNode.tsx` — add source handles
- Modify: `flow/frontend/store/flow-editor.ts` — validation already updated in Task 2

**Interfaces:**
- Produces: xAction nodes render with `id="success"` and `id="failed"` source handles

- [ ] **Step 1: Update ActionNode.tsx**

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";

const EXTERNAL_API_ACTIONS = ["xAction"];

export default function ActionNode({ data, selected }: NodeProps) {
  const actionType = data.actionType as string;
  const isExternalApi = EXTERNAL_API_ACTIONS.includes(actionType);

  let label: string;
  let description: string;
  let icon: string;

  if (actionType === "addToList") {
    const listName = data.listName as string;
    label = "Add to List";
    description = listName || "Select a list...";
    icon = "📋";
  } else if (actionType === "xAction") {
    const xEvent = data.xEvent as string;
    label = "X Action";
    description = xEvent === "follow-user" ? "Follow User"
      : xEvent === "unfollow-user" ? "Unfollow User"
      : xEvent === "create-dm" ? "Direct Message"
      : xEvent === "mute-user" ? "Mute User"
      : "Select action...";
    icon = "𝕏";
  } else {
    label = "Action";
    description = "Unknown action";
    icon = "⚡";
  }

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[160px] ${
        selected ? "border-blue-500 shadow-md" : "border-green-300"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-green-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{icon}</span>
        <span className="font-semibold text-sm text-green-700">{label}</span>
      </div>
      <p className={`text-xs ${data.listName || data.xEvent ? "text-gray-500" : "text-gray-400 italic"}`}>
        {description}
      </p>
      {isExternalApi && (
        <div className="flex justify-between mt-2 text-[10px] text-gray-500 px-1">
          <span className="text-green-600">Success</span>
          <span className="text-red-500">Failed</span>
        </div>
      )}
      {isExternalApi ? (
        <>
          <Handle type="source" position={Position.Bottom} id="success"
            className="!bg-green-500 !w-2.5 !h-2.5" style={{ left: "30%" }} />
          <Handle type="source" position={Position.Bottom} id="failed"
            className="!bg-red-400 !w-2.5 !h-2.5" style={{ left: "70%" }} />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!bg-green-500 !w-3 !h-3" />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build and verify**

```bash
cd flow && npx vite build
```

- [ ] **Step 3: Commit**

```bash
git add flow/frontend/nodes/ActionNode.tsx
git commit -m "feat(flow): add success/failed handles to external API action nodes"
```

---

### Task 5: Action Success/Failed Branches (Backend Engine)

**Files:**
- Modify: `flow/src/engine.ts` — collectActions stops at external API actions
- Modify: `flow/src/index.ts` — queue handler resumes from action branch

**Interfaces:**
- Consumes: ActionResult now includes `nodeId` and `hasBranches` fields
- Produces: Queue handler calls `resumeFromNode(graph, nodeId, payload, "success"|"failed")` after executing external API actions

- [ ] **Step 1: Update collectActions in engine.ts**

Replace the action handling block:

```typescript
if (targetNode.type === "action") {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  if (actionType === "addToList") actionData.listId = targetNode.data.listId as string;
  if (actionType === "xAction") {
    actionData.xEvent = targetNode.data.xEvent as string;
    actionData.channelId = targetNode.data.channelId as string;
    if (targetNode.data.messageText) actionData.messageText = targetNode.data.messageText as string;
  }
  actions.push(actionData);
  nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });

  if (!isExternalApi) {
    // Linear action — continue traversing downstream nodes
    collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
  }
  // External API action — stop here; queue handler resumes after execution
  continue;
}
```

- [ ] **Step 2: Update queue handler in index.ts**

In the section where `executeActions` is called (around line 430-450), change to handle branching:

```typescript
// After getting result from executeFlow
const { actions, pendingWaits, nodeLogs } = result;
emitNodeLogs(nodeLogs, flow.id, userId, tenantId, env);

// Separate branching vs linear actions
const linearActions = actions.filter((a) => !a.hasBranches);
const branchingActions = actions.filter((a) => a.hasBranches);

// Execute linear actions immediately
if (linearActions.length > 0) {
  const execResult = await executeActions(linearActions, userId, String(tenantId), env, payload);
  // Handle rate-limited retries as before
  for (const rl of execResult.rateLimited) {
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, retry_action, retry_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
    ).bind(crypto.randomUUID(), flow.id, "", userId, tenantId, JSON.stringify(payload), rl.retryAt, JSON.stringify(rl.action)).run();
  }
}

// Execute branching actions and follow branches
for (const action of branchingActions) {
  let success = false;
  try {
    const execResult = await executeActions([action], userId, String(tenantId), env, payload);
    success = execResult.rateLimited.length === 0;
    if (!success) {
      // Rate limited — store for retry, don't fire "failed" branch yet
      for (const rl of execResult.rateLimited) {
        await env.FLOW_DB.prepare(
          `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, retry_action, retry_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
        ).bind(crypto.randomUUID(), flow.id, action.nodeId as string, userId, tenantId, JSON.stringify(payload), rl.retryAt, JSON.stringify(rl.action)).run();
      }
      continue; // Skip branching — will be resolved on retry
    }
  } catch {
    success = false;
  }

  // Resume from the action node's success or failed branch
  const branch = success ? "success" : "failed";
  const continued = resumeFromNode(graph, action.nodeId as string, payload, branch);
  emitNodeLogs(continued.nodeLogs, flow.id, userId, tenantId, env);

  // Execute any downstream actions from the branch
  if (continued.actions.length > 0) {
    await executeActions(continued.actions.filter((a) => !a.hasBranches), userId, String(tenantId), env, payload);
  }
  // Store any downstream pending waits
  for (const pw of continued.pendingWaits) {
    await env.FLOW_DB.prepare(
      `INSERT INTO flow_pending (id, flow_id, node_id, user_id, tenant_id, payload, execute_at, awaiting_event, conditions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      crypto.randomUUID(), flow.id, pw.nodeId, userId, tenantId,
      JSON.stringify(payload),
      new Date(Date.now() + pw.durationMs).toISOString(),
      pw.awaitingEvent || "", pw.conditions ? JSON.stringify(pw.conditions) : ""
    ).run();
  }
}
```

- [ ] **Step 3: Update retry handler for failed branch**

In the cron handler section that processes retries (around line 530-560), when max retries (5) exhausted, fire the "failed" branch:

```typescript
if (pending.retry_count >= 5) {
  // Max retries exhausted — fire "failed" branch
  const graph = JSON.parse(flow.graph_json) as FlowGraph;
  const continued = resumeFromNode(graph, pending.node_id, JSON.parse(pending.payload), "failed");
  emitNodeLogs(continued.nodeLogs, flow.id, pending.user_id, pending.tenant_id, env);
  if (continued.actions.length > 0) {
    await executeActions(continued.actions.filter((a) => !a.hasBranches), pending.user_id, String(pending.tenant_id), env, JSON.parse(pending.payload));
  }
  // Delete the pending entry
  await env.FLOW_DB.prepare("DELETE FROM flow_pending WHERE id = ?").bind(pending.id).run();
  continue;
}
```

- [ ] **Step 4: Build backend**

```bash
cd flow && npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add flow/src/engine.ts flow/src/index.ts
git commit -m "feat(flow): action success/failed branching in engine + queue handler"
```

---

### Task 6: Deploy and E2E Verify

**Files:**
- No code changes — deployment and verification only

- [ ] **Step 1: Deploy flow worker**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
npx wrangler deploy --env dev --config flow/wrangler.toml
```

- [ ] **Step 2: Run DB migration**

```bash
npx wrangler d1 migrations apply uniscrm-db-dev --env dev --config web/wrangler.toml --remote
```

- [ ] **Step 3: Verify in browser**

1. Open `https://flow-dev.uni-scrm.com/`
2. Create new flow → drag X Trigger → select "Follow" event → Add condition → verify "Event Time" is first option
3. Drag X Action → verify green "Success" and red "Failed" handles visible at bottom
4. Connect X Action "success" handle → Add to List; "failed" handle → Wait node
5. Save flow → verify `graph_json` uses `"type":"xTrigger"` and `"type":"waitForEvent"`

- [ ] **Step 4: Verify engine tests pass**

Update test file to use `"xTrigger"` node type, then:
```bash
npx tsx /tmp/test-engine.mjs
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "deploy(flow): flow engine enhancements - event_time, renames, action branches"
```
