# Flow Engine Enhancements: event_time, Node Renames, Action Branching

## Summary

Three related improvements to the flow automation engine:

1. **event_time** — Add as default first Event Prop on all triggers
2. **Node type renames** — `eventHistory` → `waitForEvent`, `trigger` → `xTrigger`
3. **Action success/failed branches** — External API actions get green/red output handles

---

## 1. event_time as Default Event Prop

All event triggers get `event_time` (ISO timestamp string) as the first item in their Event Props list. Users can filter on it in conditions (e.g., `contains "T09"` for morning events).

**File:** `flow/frontend/config/trigger-fields.ts`

In `getChannelTypes()`, prepend a system field to every event's `contextFields`:

```typescript
const EVENT_TIME_FIELD: TriggerFieldDefinition = {
  id: "event_time",
  label: t({ en: "Event Time", zh: "事件时间" }, locale),
  dataType: "string",
  operators: STRING_OPS,
  group: "event",
};

contextFields: [
  EVENT_TIME_FIELD,
  ...m.eventProps.map((p) => propToField(p.propId, locale, "event")),
  ...m.userProps.map((p) => propToField(p.propId, locale, "user")),
]
```

The backend already passes `event_time` in the payload (set when webhook is received in link-social).

---

## 2. Node Type Renames

### 2.1 `eventHistory` → `waitForEvent`

| What | From | To |
|------|------|----|
| Node type string | `"eventHistory"` | `"waitForEvent"` |
| Component file | `EventHistoryNode.tsx` | `WaitForEventNode.tsx` |
| Inspector component | `EventHistoryInspector` | `WaitForEventInspector` |
| Node registration | `nodeTypes.eventHistory` | `nodeTypes.waitForEvent` |
| Sidebar drag type | `"eventHistory"` | `"waitForEvent"` |

### 2.2 `trigger` → `xTrigger`

| What | From | To |
|------|------|----|
| Node type string | `"trigger"` | `"xTrigger"` |
| Component file | `TriggerNode.tsx` | `XTriggerNode.tsx` |
| Inspector component | `TriggerInspector` | `XTriggerInspector` |
| Node registration | `nodeTypes.trigger` | `nodeTypes.xTrigger` |
| Sidebar drag type | `"trigger:X"` | `"xTrigger"` |
| addNode logic | `type.startsWith("trigger:")` | `type === "xTrigger"` |

### 2.3 Files to update

**Frontend:**
- `flow/frontend/nodes/index.ts` — nodeTypes map
- `flow/frontend/nodes/EventHistoryNode.tsx` → rename file to `WaitForEventNode.tsx`
- `flow/frontend/nodes/TriggerNode.tsx` → rename file to `XTriggerNode.tsx`
- `flow/frontend/components/Inspector.tsx` — component names, type checks
- `flow/frontend/components/Sidebar.tsx` — drag type
- `flow/frontend/components/Canvas.tsx` — isValidConnection logic
- `flow/frontend/store/flow-editor.ts` — addNode, isValidConnection
- `flow/frontend/config/templates.ts` — node type in template graphs
- `flow/frontend/pages/AnalyticsPage.tsx` — type checks
- `flow/frontend/pages/EditorPage.tsx` — type checks

**Backend:**
- `flow/src/engine.ts` — `executeFlow()` trigger matching, `collectActions()` node type checks, `resumeFromNode()`

### 2.4 Data Migration

Existing flows in DB have old type strings in `graph_json`. Add SQL migration:

```sql
-- Update saved flow graphs
UPDATE flows SET graph_json = REPLACE(
  REPLACE(graph_json, '"type":"eventHistory"', '"type":"waitForEvent"'),
  '"type":"trigger"', '"type":"xTrigger"'
) WHERE graph_json LIKE '%"type":"eventHistory"%' OR graph_json LIKE '%"type":"trigger"%';
```

Also update `flow_pending.node_id` references aren't affected (they reference node IDs not types).

---

## 3. Action Success/Failed Branches

### 3.1 Scope

Actions that call external APIs get two source handles:
- **success** (green) — API call succeeded
- **failed** (red) — API call failed (HTTP error, timeout, rate limit exhausted)

**Current external API actions:** `xAction`
**Future:** `tiktokAction`, etc.

Non-API actions (`addPoint`, `addToList`) remain linear (single output, no branching).

### 3.2 Frontend — ActionNode.tsx

```tsx
// External API actions get two handles
const isExternalApi = actionType === "xAction";

{isExternalApi ? (
  <>
    <Handle type="source" position={Position.Bottom} id="success"
      style={{ left: "30%" }} className="!bg-green-500 !w-3 !h-3" />
    <Handle type="source" position={Position.Bottom} id="failed"
      style={{ left: "70%" }} className="!bg-red-500 !w-3 !h-3" />
  </>
) : (
  <Handle type="source" position={Position.Bottom} className="!bg-green-500 !w-3 !h-3" />
)}
```

### 3.3 Canvas validation

Update `isValidConnection` — action nodes with external API type can be source nodes:

```typescript
const validSources = ["xTrigger", "wait", "waitForEvent", "action"];
```

Only external API action nodes will actually have source handles, so non-API actions won't create edges even though validation passes.

### 3.4 Backend — Engine Changes

**`collectActions()` behavior change:**

When encountering an external API action node:
- Do NOT immediately add to `actions[]` and continue
- Instead, add to `actions[]` WITH the nodeId, and stop traversal at that point
- The queue handler executes the action, then calls `resumeFromNode(graph, actionNodeId, payload, "success" | "failed")`

```typescript
if (targetNode.type === "action") {
  const actionType = targetNode.data.actionType as string;
  const isExternalApi = actionType === "xAction";
  const actionData: ActionResult = { type: actionType, nodeId: targetNode.id, hasBranches: isExternalApi };
  // ... populate actionData fields
  actions.push(actionData);
  
  if (!isExternalApi) {
    // Linear action — continue traversing
    collectActions(graph, targetNode.id, payload, actions, pendingWaits, nodeLogs);
  }
  // External API action — stop here, queue handler will resume after execution
}
```

**Queue handler changes:**

After executing an external API action:
```typescript
for (const action of result.actions) {
  if (action.hasBranches) {
    const success = await executeExternalAction(action, ...);
    const branch = success ? "success" : "failed";
    const continued = resumeFromNode(graph, action.nodeId, payload, branch);
    // Process continued.actions recursively
  } else {
    await executeAction(action, ...);
  }
}
```

### 3.5 What counts as "failed"

- HTTP 4xx/5xx response from external API
- Network timeout
- Rate limit exhausted after max retries (5 retries already attempted)

Rate-limited responses that still have retries available do NOT trigger "failed" — they go to flow_pending for retry as before. Only after all retries exhausted does the "failed" branch fire.

---

## Verification

1. Build flow frontend — no errors
2. Open flow editor → drag X Trigger → select event → Add condition → see "Event Time" as first option
3. Drag xAction → see green "success" and red "failed" handles at bottom
4. Connect xAction success → another action; connect failed → Wait node
5. Save flow → check graph_json has `"type":"xTrigger"` and `"type":"waitForEvent"`
6. Run engine tests — trigger matching, condition evaluation, action branching all pass
7. Data migration — existing flows updated correctly
