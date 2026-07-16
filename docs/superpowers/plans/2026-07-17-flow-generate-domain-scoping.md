# Flow Generate: Domain-Scoped Node Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/flows/generate` produce content-domain node types (`xContentTrigger`/`xContentAction`) when generating a content flow, instead of today's always-user-domain vocabulary, with a validation safety net that rejects any cross-domain node before it reaches the canvas.

**Architecture:** A new pure module `flow/src/generate-prompt.ts` builds the LLM system prompt as a function of `domain: "user"|"content"`, keeping the existing (unmodified) user-domain prompt text and adding a new content-domain variant. The frontend computes `domain` the same way `Sidebar.tsx` already does (`nodes.some(n => n.type === "xContentTrigger")`) and sends it as a new `domain` field in the generate request body. Because `/api/flows/generate` streams the raw LLM token stream straight through to the browser (`flow/src/index.ts:905`, no server-side buffering of the final JSON), the "reject cross-domain nodes" safety net cannot live on the backend as originally scoped in the design doc — it moves to the shared `AiGenerateBar` component, which already parses the complete JSON client-side once the stream ends, before calling `onResult`. A new pure helper `shared/frontend/lib/validate-generated-graph.ts` implements the check so it stays unit-testable without pulling in React/jsdom (which this codebase has no test infra for).

**Tech Stack:** Hono (Cloudflare Worker), Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), React, `@cloudflare/vitest-pool-workers`, Vitest.

## Global Constraints

- The existing user-domain system prompt text must remain byte-for-byte unchanged (spec: out of scope to fix its staleness).
- `domain` defaults to `"user"` server-side if missing or not exactly `"user"`/`"content"` (spec: safe fallback matching today's only behavior).
- No new column on the `flows` table — domain stays inference-only, this task only adds an explicit `domain` field to the generate request/response contract (spec non-goal).
- No change to `xContentTrigger`/`xContentAction`'s actual node behavior, Inspector, or engine execution (spec non-goal) — this plan only touches the generation (prompt + validation) path.
- **Deviation from the design doc, confirmed by reading the actual route (`flow/src/index.ts:885-912`) and the shared component (`shared/frontend/components/BarAiGenerate.tsx`):** the design doc's "Change 3" says backend validates before returning; the real endpoint proxies a raw AI SSE stream and never assembles/returns the final JSON itself, so backend validation isn't possible without sacrificing the live streamed progress log. Validation moves to the frontend (`BarAiGenerate.tsx`, right before it calls `onResult`), which already does the JSON extraction/parsing. This plan implements the validation there instead.

---

### Task 1: Domain-aware system prompt (backend)

**Files:**
- Create: `flow/src/generate-prompt.ts`
- Create: `flow/tests/unit/generate-prompt.test.ts`
- Modify: `flow/src/index.ts:856-912` (remove the `FLOW_GENERATE_SYSTEM_PROMPT` constant, import and use the new module, read `domain` from the request body)

**Interfaces:**
- Produces: `export type FlowDomain = "user" | "content"`, `export const FLOW_GENERATE_ALLOWED_NODE_TYPES: Record<FlowDomain, string[]>`, `export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string` — all consumed by `flow/src/index.ts`'s `/api/flows/generate` route in this same task.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/generate-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFlowGenerateSystemPrompt, FLOW_GENERATE_ALLOWED_NODE_TYPES } from "../../src/generate-prompt";

describe("buildFlowGenerateSystemPrompt", () => {
  it("user domain: matches today's exact prompt text, unchanged", () => {
    const expected = `You are a workflow graph generator for a social CRM.

Available node types:
1. xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: "follow.followed" (someone follows you), "follow.follow" (you follow someone), "follow.unfollowed" (someone unfollows you), "follow.unfollow" (you unfollow someone), "dm.received", "post.create", "like.create"

2. wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }

3. waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }

4. action - perform an action
   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: "follow-user", "unfollow-user", "create-dm", "mute-user"
   For list actions: data: { actionType: "addToList", listId: "", listName: "" }

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- Flow must start with exactly one xTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
    expect(buildFlowGenerateSystemPrompt("user")).toBe(expected);
  });

  it("content domain: lists only xContentTrigger and xContentAction, and forbids user-domain types", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("xContentTrigger");
    expect(prompt).toContain("xContentAction");
    expect(prompt).toContain('"my_posts"|"list_posts"');
    expect(prompt).toContain('"create-post"|"repost-post"');
    expect(prompt).toContain("Flow must start with exactly one xContentTrigger node");
    expect(prompt).toContain("Do NOT use xTrigger, wait, waitForEvent, action");
    expect(prompt).not.toContain("addToList");
  });

  it("FLOW_GENERATE_ALLOWED_NODE_TYPES lists the exact node types per domain", () => {
    expect(FLOW_GENERATE_ALLOWED_NODE_TYPES.user).toEqual(["xTrigger", "wait", "waitForEvent", "action"]);
    expect(FLOW_GENERATE_ALLOWED_NODE_TYPES.content).toEqual(["xContentTrigger", "xContentAction"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: FAIL — `Cannot find module '../../src/generate-prompt'`

- [ ] **Step 3: Write the implementation**

Create `flow/src/generate-prompt.ts`:

```ts
export type FlowDomain = "user" | "content";

export const FLOW_GENERATE_ALLOWED_NODE_TYPES: Record<FlowDomain, string[]> = {
  user: ["xTrigger", "wait", "waitForEvent", "action"],
  content: ["xContentTrigger", "xContentAction"],
};

const USER_DOMAIN_PROMPT = `You are a workflow graph generator for a social CRM.

Available node types:
1. xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: "follow.followed" (someone follows you), "follow.follow" (you follow someone), "follow.unfollowed" (someone unfollows you), "follow.unfollow" (you unfollow someone), "dm.received", "post.create", "like.create"

2. wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }

3. waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }

4. action - perform an action
   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: "follow-user", "unfollow-user", "create-dm", "mute-user"
   For list actions: data: { actionType: "addToList", listId: "", listName: "" }

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- xAction nodes have sourceHandle "success" or "failed" for branching
- waitForEvent nodes have sourceHandle "yes" or "no"
- Flow must start with exactly one xTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;

const CONTENT_DOMAIN_PROMPT = `You are a workflow graph generator for a social CRM.

Available node types:
1. xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: "my_posts"|"list_posts", listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "my_posts": triggers on the channel's own posts. mode "list_posts": triggers on posts from a specific X List (leave listId/listName blank).

2. xContentAction - perform an action on X content
   data: { actionType: "xContentAction", operation: "create-post"|"repost-post", channelId: "", prompt: "", provider: "default" }
   - operation "create-post": generates and publishes a new post (channelId = target account, left blank for the user to pick; prompt = free-text instructions for AI generation, left blank for the user to fill in).
   - operation "repost-post": reposts the triggering content via the triggering channel's own account — needs no additional fields; leave channelId/prompt/provider at these defaults.

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- Only use xContentTrigger and xContentAction node types. Do NOT use xTrigger, wait, waitForEvent, action, or any other node type — those belong to a different flow domain.
- xContentAction nodes have sourceHandle "success" or "failed" for branching
- Flow must start with exactly one xContentTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;

export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string {
  return domain === "content" ? CONTENT_DOMAIN_PROMPT : USER_DOMAIN_PROMPT;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 3 passed (3)`

- [ ] **Step 5: Wire the new module into the route**

In `flow/src/index.ts`, add near the top (with the other relative imports):

```ts
import { buildFlowGenerateSystemPrompt, type FlowDomain } from "./generate-prompt";
```

Delete the entire `const FLOW_GENERATE_SYSTEM_PROMPT = \`...\`;` block (currently `flow/src/index.ts:856-883`).

Replace the route handler (currently `flow/src/index.ts:885-912`) with:

```ts
app.post("/api/flows/generate", async (c) => {
  const { prompt, currentContext, currentGraph, domain } = await c.req.json<{
    prompt: string;
    currentContext?: any;
    currentGraph?: any;
    domain?: string;
  }>();
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const flowDomain: FlowDomain = domain === "content" ? "content" : "user";
  const ctx = currentContext || currentGraph;
  const hasContext = ctx && (Array.isArray(ctx.nodes) ? ctx.nodes.length > 0 : Object.keys(ctx).length > 0);
  const userMessage = hasContext
    ? `Current flow: ${JSON.stringify(ctx)}\n\nUser request: ${prompt}`
    : `Create a new flow: ${prompt}`;

  try {
    const stream = await c.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
      messages: [
        { role: "system", content: buildFlowGenerateSystemPrompt(flowDomain) },
        { role: "user", content: userMessage },
      ],
      max_tokens: 2048,
      stream: true,
    });

    return new Response(stream as ReadableStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    console.error(JSON.stringify({ event: "flow_generate_error", error: String(e) }));
    return c.json({ error: "Generation failed" }, 500);
  }
});
```

(Only two lines actually change inside the handler: the destructure gains `domain`, a new `flowDomain` const is computed, and the system prompt's `content` value switches from the old constant to `buildFlowGenerateSystemPrompt(flowDomain)`. Everything else — the stream call shape, error handling, headers — is unchanged.)

- [ ] **Step 6: Run the full flow test suite to check for regressions**

Run: `cd flow && npx vitest run`
Expected: all test files pass, same count as before this task plus the 3 new tests (no existing test references `FLOW_GENERATE_SYSTEM_PROMPT` or the `/api/flows/generate` route, so no other test should be affected).

- [ ] **Step 7: Type-check**

Run: `cd flow && npx tsc --noEmit -p .`
Expected: no new errors introduced (pre-existing `shared/frontend/ui/*` "@types/react" errors, if any, are unrelated and already present before this task).

- [ ] **Step 8: Commit**

```bash
git add flow/src/generate-prompt.ts flow/tests/unit/generate-prompt.test.ts flow/src/index.ts
git commit -m "feat(flow): domain-aware system prompt for /api/flows/generate"
```

---

### Task 2: Cross-domain node-type validation (shared frontend)

**Files:**
- Create: `shared/frontend/lib/validate-generated-graph.ts`
- Create: `flow/tests/unit/validate-generated-graph.test.ts` (this module has no consumer-independent test runner — `flow` is `AiGenerateBar`'s only current caller, so its suite covers this shared file, matching the existing precedent of `analytics/tests/unit/*.test.ts` testing files under `shared/frontend/`)
- Modify: `shared/frontend/components/BarAiGenerate.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function findInvalidNodeType(nodes: unknown, allowedNodeTypes: string[]): string | null` — returns the first node `type` not present in `allowedNodeTypes`, or `null` if every node's `type` is allowed (or `nodes` isn't an array). Consumed by `BarAiGenerate.tsx` in this task, and by `EditorPage.tsx` in Task 3 (which supplies `allowedNodeTypes`, not this function directly).
- `AiGenerateBarProps` gains two new optional fields, consumed by `EditorPage.tsx` in Task 3: `extraBody?: Record<string, unknown>` (merged into the POST body) and `allowedNodeTypes?: string[]` (passed straight through to `findInvalidNodeType`).

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/validate-generated-graph.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findInvalidNodeType } from "../../../shared/frontend/lib/validate-generated-graph";

describe("findInvalidNodeType", () => {
  it("returns null when every node's type is in the allowed set", () => {
    const nodes = [{ type: "xContentTrigger" }, { type: "xContentAction" }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBeNull();
  });

  it("returns the first disallowed type found", () => {
    const nodes = [{ type: "xContentTrigger" }, { type: "wait" }, { type: "xContentAction" }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBe("wait");
  });

  it("returns null when nodes is not an array", () => {
    expect(findInvalidNodeType(undefined, ["xContentTrigger"])).toBeNull();
    expect(findInvalidNodeType(null, ["xContentTrigger"])).toBeNull();
  });

  it("returns a stringified placeholder when a node has a missing/non-string type", () => {
    const nodes = [{ type: "xContentTrigger" }, {}];
    expect(findInvalidNodeType(nodes, ["xContentTrigger"])).toBe("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/validate-generated-graph.test.ts`
Expected: FAIL — `Cannot find module '../../../shared/frontend/lib/validate-generated-graph'`

- [ ] **Step 3: Write the implementation**

Create `shared/frontend/lib/validate-generated-graph.ts`:

```ts
export function findInvalidNodeType(nodes: unknown, allowedNodeTypes: string[]): string | null {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    const type = (n as { type?: unknown })?.type;
    if (typeof type !== "string" || !allowedNodeTypes.includes(type)) {
      return typeof type === "string" ? type : String(type);
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/validate-generated-graph.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 4 passed (4)`

- [ ] **Step 5: Wire validation into `BarAiGenerate.tsx`**

In `shared/frontend/components/BarAiGenerate.tsx`, add the import at the top:

```ts
import { findInvalidNodeType } from "../lib/validate-generated-graph";
```

Change the `AiGenerateBarProps` interface (currently lines 3-8) to:

```ts
interface AiGenerateBarProps {
  endpoint: string;
  context?: any;
  placeholder?: string;
  onResult: (json: any) => void;
  extraBody?: Record<string, unknown>;
  allowedNodeTypes?: string[];
}
```

Change the component signature (currently line 10) to:

```ts
export default function AiGenerateBar({ endpoint, context, placeholder = "Describe...", onResult, extraBody, allowedNodeTypes }: AiGenerateBarProps) {
```

Change the fetch body (currently line 30, `body: JSON.stringify({ prompt: input, currentContext: context }),`) to:

```ts
        body: JSON.stringify({ prompt: input, currentContext: context, ...extraBody }),
```

Change the JSON-parse success block (currently lines 70-75):

```ts
          try {
            const parsed = JSON.parse(jsonStr);
            onResult(parsed);
          } catch {
            setLog(full + "\n\n[Failed to parse JSON from response]");
          }
```

to:

```ts
          try {
            const parsed = JSON.parse(jsonStr);
            const invalidType = allowedNodeTypes ? findInvalidNodeType(parsed.nodes, allowedNodeTypes) : null;
            if (invalidType !== null) {
              setLog(full + `\n\n[Generated an invalid node type "${invalidType}" for this flow — please try again]`);
              return;
            }
            onResult(parsed);
          } catch {
            setLog(full + "\n\n[Failed to parse JSON from response]");
          }
```

- [ ] **Step 6: Run the full flow test suite to check for regressions**

Run: `cd flow && npx vitest run`
Expected: all test files pass, same count as before this task plus the 4 new tests.

- [ ] **Step 7: Type-check**

Run: `cd flow && npx tsc --noEmit -p .`
Expected: no new errors introduced.

- [ ] **Step 8: Commit**

```bash
git add shared/frontend/lib/validate-generated-graph.ts flow/tests/unit/validate-generated-graph.test.ts shared/frontend/components/BarAiGenerate.tsx
git commit -m "feat(shared): reject cross-domain node types from AI-generated flow graphs"
```

---

### Task 3: Wire domain through the editor toolbar (frontend)

**Files:**
- Modify: `flow/frontend/pages/EditorPage.tsx:83-93` (the `<AiGenerateBar>` usage inside `EditorToolbar`)

**Interfaces:**
- Consumes: `AiGenerateBarProps.extraBody`/`allowedNodeTypes` (Task 2).
- Produces: nothing further downstream — this is the leaf wiring task.

No new automated test for this task: it's a 6-line prop-wiring change inside a component that has no existing test coverage or test infrastructure (this codebase has no jsdom/React Testing Library setup anywhere — confirmed by searching all modules' `package.json`/test directories). Verify manually per Step 3 below instead, per this project's practice of browser-testing UI changes.

- [ ] **Step 1: Compute domain and the allowed-type list**

In `flow/frontend/pages/EditorPage.tsx`, inside `EditorToolbar` (the function starting at line 18), replace the existing inline `context` IIFE with a named computation. Change:

```tsx
      <AiGenerateBar
        endpoint="/api/flows/generate"
        context={(() => { const { nodes, edges } = useFlowEditor.getState(); return { nodes, edges }; })()}
        placeholder="Describe your flow..."
        onResult={(graph) => {
          if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
            replaceGraph(graph.nodes, graph.edges);
            setTimeout(() => document.querySelector<HTMLButtonElement>("[data-arrange]")?.click(), 100);
          }
        }}
      />
```

to:

```tsx
      <AiGenerateBar
        endpoint="/api/flows/generate"
        context={{ nodes: useFlowEditor.getState().nodes, edges: useFlowEditor.getState().edges }}
        extraBody={{ domain: useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user" }}
        allowedNodeTypes={
          useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger")
            ? ["xContentTrigger", "xContentAction"]
            : ["xTrigger", "wait", "waitForEvent", "action"]
        }
        placeholder="Describe your flow..."
        onResult={(graph) => {
          if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
            replaceGraph(graph.nodes, graph.edges);
            setTimeout(() => document.querySelector<HTMLButtonElement>("[data-arrange]")?.click(), 100);
          }
        }}
      />
```

(This mirrors `Sidebar.tsx:37`'s exact domain-inference formula. The allowed-type arrays are the frontend-side literal copy of `FLOW_GENERATE_ALLOWED_NODE_TYPES` from Task 1's `flow/src/generate-prompt.ts` — duplicated rather than shared because the backend Worker bundle and the frontend Vite bundle are separate builds with no shared runtime package between them; two 2-4-item string arrays are not worth introducing one for.)

- [ ] **Step 2: Type-check**

Run: `cd flow && npx tsc --noEmit -p .`
Expected: no new errors introduced.

- [ ] **Step 3: Manual browser verification**

Start the dev server (`cd flow && wrangler dev --env dev` or the project's usual local dev flow) and in a browser:
1. Open the Content Flows tab, create a new content flow (so an `xContentTrigger` node is already on the canvas per the existing `?domain=content` auto-seed behavior).
2. Use the "Describe your flow..." bar to generate: `repost every post in a list`.
3. Confirm the generated graph contains an `xContentTrigger` node (mode `list_posts`) connected to an `xContentAction` node with `operation: "repost-post"` — inspect via the Inspector panel's Operation dropdown (should show "Repost") and the trigger's Mode dropdown (should show "list_posts" / "特定列表").
4. Switch to the User Flows tab, create a new user flow, and generate a simple flow (e.g. `mute anyone who unfollows me`). Confirm it still produces `xTrigger`/`action` nodes as before (no regression).
5. Open the browser console/network tab and confirm the `POST /api/flows/generate` request body includes `"domain":"content"` or `"domain":"user"` matching the active tab.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/pages/EditorPage.tsx
git commit -m "feat(flow): pass flow domain and allowed node types to the AI generate bar"
```

---

## Self-Review Notes

- **Spec coverage:** Change 1 (explicit `domain` field) → Task 3 (frontend send) + Task 1 (backend read/default). Change 2 (two system prompts) → Task 1. Change 3 (reject cross-domain output) → Task 2, relocated from backend to frontend per the Global Constraints deviation note (confirmed necessary by reading the actual streaming route). `CONTEXT.md`'s "Flow Domain" term is already written and committed (prior to this plan) — no task needed for it.
- **Placeholder scan:** no TBD/TODO; all steps carry complete, runnable code.
- **Type consistency:** `FlowDomain` (Task 1, backend-only type) and the frontend's inline `"content"|"user"` ternary (Task 3) are intentionally two separate literal unions in two separate bundles — not a naming inconsistency, per the "no shared package" call above. `findInvalidNodeType`'s signature (Task 2) is used identically in Task 2's own wiring; Task 3 never calls it directly (only supplies `allowedNodeTypes`), so no signature drift risk there.
