# Flow Generate: Domain-Scoped Node Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/flows/generate` produce content-domain node types when generating a content flow (5 real types: `xContentTrigger`, `wait`, and `action` nodes with `actionType` `xContentAction`/`tiktokContentAction`/`updateContentStatus`), instead of today's always-user-domain vocabulary — driven by one central node-type registry, with a validation safety net that rejects any cross-domain node before it reaches the canvas.

**Architecture:** A new pure data module `flow/nodeTypeRegistry.ts` (module root, importable by both the Worker backend `flow/src/*` and the Vite frontend `flow/frontend/*` via plain relative imports — the two are separate bundles but share one `tsconfig.json`/npm package, so no cross-package boundary is crossed) declares, per node-type/actionType key: its Flow Domain (`"user"|"content"|"both"`), whether the AI generate feature may produce it, and — for content-domain generatable entries only — its LLM prompt fragment. The user-domain system prompt stays the existing hardcoded constant, completely untouched. The content-domain prompt is assembled from the registry at request time. Because `/api/flows/generate` streams the raw LLM token stream straight through (`flow/src/index.ts:905`, no server-side buffering of the final JSON), the "reject cross-domain nodes" validation lives in the shared `AiGenerateBar` component instead of the backend — it already parses the complete JSON client-side once the stream ends, before calling `onResult`.

**Tech Stack:** Hono (Cloudflare Worker), Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), React, `@cloudflare/vitest-pool-workers`, Vitest.

## Global Constraints

- The existing user-domain system prompt text must remain byte-for-byte unchanged — it is not rebuilt from the registry, by explicit instruction.
- `domain` defaults to `"user"` server-side if missing or not exactly `"user"`/`"content"`.
- No new column on the `flows` table — domain stays inference-only; this task only adds an explicit `domain` field to the generate request contract.
- No change to any node type's actual execution/engine behavior — this plan only touches the registry, prompt-building, validation, and Sidebar-visibility paths.
- `timeCondition`, `abSplit`, `webhook` are non-functional in every domain today (confirmed by reading `engine.ts`/`index.ts`) and must be marked `generatable: false` in the registry — never surfaced in either prompt or allow-list.
- **`action`-family discriminator:** `addToList`, `xAction`, `xContentAction`, `tiktokContentAction`, `updateContentStatus` all have React Flow `node.type === "action"`, distinguished only by `data.actionType`. Every place that inspects a node's "effective type" (registry lookups, the validator, the content prompt's rules text) must check `data.actionType` when `node.type === "action"`, never `node.type` alone.

---

### Task 1: Central node-type registry

**Files:**
- Create: `flow/nodeTypeRegistry.ts`
- Create: `flow/tests/unit/node-type-registry.test.ts`
- Modify: `flow/tsconfig.json` (add the new root-level file to `include`)

**Interfaces:**
- Produces: `export type FlowDomain = "user" | "content"`; `export interface NodeTypeConfig { reactFlowType: string; domain: FlowDomain | "both"; generatable: boolean; promptFragment?: string }`; `export const NODE_TYPE_REGISTRY: Record<string, NodeTypeConfig>` (keyed by `node.type` for non-action entries, or `data.actionType` for `action`-family entries); `export function generatableKeysForDomain(domain: FlowDomain): string[]`. All consumed by Tasks 2, 3, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/node-type-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY, generatableKeysForDomain } from "../../nodeTypeRegistry";

describe("NODE_TYPE_REGISTRY", () => {
  it("tags every known node type/actionType with a domain", () => {
    const expectedKeys = [
      "xTrigger", "cronTrigger", "xContentTrigger", "waitForEvent", "wait",
      "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps",
      "addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus",
    ];
    for (const key of expectedKeys) {
      expect(NODE_TYPE_REGISTRY[key], `missing registry entry for "${key}"`).toBeDefined();
    }
  });

  it("marks the three non-functional node types as not generatable", () => {
    expect(NODE_TYPE_REGISTRY.timeCondition.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.abSplit.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.webhook.generatable).toBe(false);
  });

  it("tags the action-family entries with reactFlowType 'action'", () => {
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"]) {
      expect(NODE_TYPE_REGISTRY[key].reactFlowType).toBe("action");
    }
  });
});

describe("generatableKeysForDomain", () => {
  it("user domain: exactly the 4 types/actionTypes the frozen user prompt documents today", () => {
    expect(generatableKeysForDomain("user").sort()).toEqual(
      ["addToList", "wait", "waitForEvent", "xAction", "xTrigger"].sort()
    );
  });

  it("content domain: exactly the 5 real, functional content types", () => {
    expect(generatableKeysForDomain("content").sort()).toEqual(
      ["tiktokContentAction", "updateContentStatus", "wait", "xContentAction", "xContentTrigger"].sort()
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts`
Expected: FAIL — `Cannot find module '../../nodeTypeRegistry'`

- [ ] **Step 3: Write the implementation**

Create `flow/nodeTypeRegistry.ts`:

```ts
export type FlowDomain = "user" | "content";

export interface NodeTypeConfig {
  /** The React Flow `node.type` this entry corresponds to ("action" for every actionType variant). */
  reactFlowType: string;
  domain: FlowDomain | "both";
  /** Whether the AI generate feature may produce this node type/actionType. */
  generatable: boolean;
  /**
   * LLM-facing documentation fragment, used only by the content-domain prompt builder
   * (the user-domain prompt is a frozen constant and does not read from this registry).
   * Non-action entries: the full item body ("type - description\n   data: {...}\n   - notes").
   * Action-family entries: a "For X actions: ..." sub-bullet (grouped under one numbered
   * "action" item by the prompt builder, matching how the frozen user prompt groups
   * xAction/addToList under its own item 4).
   */
  promptFragment?: string;
}

export const NODE_TYPE_REGISTRY: Record<string, NodeTypeConfig> = {
  // --- user-domain triggers/flow-control/actions ---
  xTrigger: { reactFlowType: "xTrigger", domain: "user", generatable: true },
  cronTrigger: { reactFlowType: "cronTrigger", domain: "user", generatable: false },
  waitForEvent: { reactFlowType: "waitForEvent", domain: "user", generatable: true },
  userPropsCondition: { reactFlowType: "userPropsCondition", domain: "user", generatable: false },
  changeUserProps: { reactFlowType: "changeUserProps", domain: "user", generatable: false },
  addToList: { reactFlowType: "action", domain: "user", generatable: true },
  xAction: { reactFlowType: "action", domain: "user", generatable: true },

  // --- content-domain triggers/actions ---
  xContentTrigger: {
    reactFlowType: "xContentTrigger",
    domain: "content",
    generatable: true,
    promptFragment: `xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: "my_posts"|"list_posts", listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "my_posts": triggers on the channel's own posts. mode "list_posts": triggers on posts from a specific X List (leave listId/listName blank).`,
  },
  xContentAction: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    // Leading 3-space indent on the first line matches the frozen user-domain prompt's
    // own "   For X actions: ..." / "   For list actions: ..." sub-variant style under
    // its item 4 — these fragments are concatenated directly under a numbered "action" item.
    promptFragment: `   For content actions: data: { actionType: "xContentAction", operation: "create-post"|"repost-post", channelId: "", prompt: "", provider: "default" }
   - operation "create-post": generates and publishes a new post (channelId = target account, left blank for the user to pick; prompt = free-text instructions for AI generation, left blank for the user to fill in).
   - operation "repost-post": reposts the triggering content via the triggering channel's own account — needs no additional fields; leave channelId/prompt/provider at these defaults.`,
  },
  tiktokContentAction: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    promptFragment: `   For TikTok photo-post actions: data: { actionType: "tiktokContentAction", channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - Generates images and a caption from the triggering content and posts as a TikTok draft. Leave all fields at these defaults for the user to configure via the Inspector.`,
  },
  updateContentStatus: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    promptFragment: `   For status-update actions: data: { actionType: "updateContentStatus", status: "" }
   - status must be set by the user afterward via the Inspector to "published" or "ignored" — leave it blank ("") here. No branching.`,
  },

  // --- shared across both domains ---
  wait: {
    reactFlowType: "wait",
    domain: "both",
    generatable: true,
    promptFragment: `wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }`,
  },
  timeCondition: { reactFlowType: "timeCondition", domain: "both", generatable: false },
  abSplit: { reactFlowType: "abSplit", domain: "both", generatable: false },
  webhook: { reactFlowType: "webhook", domain: "both", generatable: false },
};

export function generatableKeysForDomain(domain: FlowDomain): string[] {
  return Object.entries(NODE_TYPE_REGISTRY)
    .filter(([, cfg]) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both"))
    .map(([key]) => key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/node-type-registry.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 4 passed (4)`

- [ ] **Step 5: Add the new file to the TypeScript project**

In `flow/tsconfig.json`, change:

```json
  "include": ["src/**/*", "frontend/**/*"],
```

to:

```json
  "include": ["src/**/*", "frontend/**/*", "nodeTypeRegistry.ts"],
```

- [ ] **Step 6: Run the full flow test suite and type-check**

Run: `cd flow && npx vitest run && npx tsc --noEmit -p .`
Expected: all existing tests still pass, plus the 4 new ones; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/tests/unit/node-type-registry.test.ts flow/tsconfig.json
git commit -m "feat(flow): add central node-type-to-domain registry"
```

---

### Task 2: Content-domain system prompt built from the registry

**Files:**
- Create: `flow/src/generate-prompt.ts`
- Create: `flow/tests/unit/generate-prompt.test.ts`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY` (Task 1).
- Produces: `export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string` — consumed by `flow/src/index.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/generate-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFlowGenerateSystemPrompt } from "../../src/generate-prompt";

const EXISTING_USER_PROMPT = `You are a workflow graph generator for a social CRM.

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

describe("buildFlowGenerateSystemPrompt", () => {
  it("user domain: byte-for-byte identical to today's prompt (frozen, not rebuilt from the registry)", () => {
    expect(buildFlowGenerateSystemPrompt("user")).toBe(EXISTING_USER_PROMPT);
  });

  it("content domain: documents all 5 functional content node types via the type:\"action\" convention", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("xContentTrigger - triggers when new content arrives");
    expect(prompt).toContain('actionType: "xContentAction"');
    expect(prompt).toContain('actionType: "tiktokContentAction"');
    expect(prompt).toContain('actionType: "updateContentStatus"');
    expect(prompt).toContain("wait - delay execution");
    expect(prompt).toContain("Flow must start with exactly one xContentTrigger node");
  });

  it("content domain: forbids user-domain types and never documents their data shape", () => {
    const prompt = buildFlowGenerateSystemPrompt("content");
    expect(prompt).toContain("Do NOT use xTrigger, waitForEvent");
    // The rules text is allowed to name addToList/xAction in a "do NOT use" sentence
    // (that's helpful, explicit LLM guidance) — what must never appear is their actual
    // data-shape declaration, which would let the LLM construct one.
    expect(prompt).not.toContain('actionType: "addToList"');
    expect(prompt).not.toContain('actionType: "xAction"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: FAIL — `Cannot find module '../../src/generate-prompt'`

- [ ] **Step 3: Write the implementation**

Create `flow/src/generate-prompt.ts`:

```ts
import { NODE_TYPE_REGISTRY, type FlowDomain } from "../nodeTypeRegistry";

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

function buildContentDomainPrompt(): string {
  const trigger = NODE_TYPE_REGISTRY.xContentTrigger.promptFragment;
  const wait = NODE_TYPE_REGISTRY.wait.promptFragment;
  const actionFragments = ["xContentAction", "tiktokContentAction", "updateContentStatus"]
    .map((key) => NODE_TYPE_REGISTRY[key].promptFragment)
    .join("\n");

  return `You are a workflow graph generator for a social CRM.

Available node types:
1. ${trigger}

2. ${wait}

3. action - perform an action
${actionFragments}

Rules:
- Each node needs: id (UUID format like "a1b2c3d4-..."), type, position: {x:0,y:0}, data
- Edges: { id: string, source: nodeId, target: nodeId, sourceHandle?: string }
- Only use xContentTrigger, wait, and action (with actionType "xContentAction", "tiktokContentAction", or "updateContentStatus") node types. Do NOT use xTrigger, waitForEvent, or an action with actionType "xAction"/"addToList" — those belong to a different flow domain.
- action nodes with actionType "xContentAction" or "tiktokContentAction" have sourceHandle "success" or "failed" for branching
- Flow must start with exactly one xContentTrigger node
- Generate UUIDs for all ids (8-4-4-4-12 format)

Think step by step about what nodes and connections are needed. Your thinking is shown to the user as a progress log.
End your response with ONLY the JSON object on a new line: {"nodes":[...],"edges":[...]}`;
}

export function buildFlowGenerateSystemPrompt(domain: FlowDomain): string {
  return domain === "content" ? buildContentDomainPrompt() : USER_DOMAIN_PROMPT;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/generate-prompt.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 3 passed (3)`

- [ ] **Step 5: Run the full flow test suite and type-check**

Run: `cd flow && npx vitest run && npx tsc --noEmit -p .`
Expected: all tests pass; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add flow/src/generate-prompt.ts flow/tests/unit/generate-prompt.test.ts
git commit -m "feat(flow): build content-domain generate prompt from the node-type registry"
```

---

### Task 3: Wire `domain` into the `/api/flows/generate` route

**Files:**
- Modify: `flow/src/index.ts:856-912` (remove the old `FLOW_GENERATE_SYSTEM_PROMPT` constant; import and use `generate-prompt.ts`; read `domain` from the request body)

**Interfaces:**
- Consumes: `buildFlowGenerateSystemPrompt`, `FlowDomain` (Task 2).
- Produces: nothing further downstream in the backend — this is the route-wiring task.

- [ ] **Step 1: Verify the frozen prompt constant matches byte-for-byte before deleting it**

Task 2's test asserts `buildFlowGenerateSystemPrompt("user")` against a retyped copy of the prompt — which only proves two retyped copies agree with each other, not that either matches the real original. Before deleting the original constant, get an actual diff against it:

Run: `git show HEAD:flow/src/index.ts | sed -n '856,883p' > /tmp/original-prompt.txt`

Then compare `/tmp/original-prompt.txt` against the `USER_DOMAIN_PROMPT` constant in `flow/src/generate-prompt.ts` (Task 2) — they must be identical except for the enclosing `const FLOW_GENERATE_SYSTEM_PROMPT = ` / `const USER_DOMAIN_PROMPT = ` declaration syntax. If anything differs, fix `generate-prompt.ts` now, not the constant you're about to delete.

- [ ] **Step 2: Wire the new module into the route**

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

(Only the destructure gaining `domain`, the new `flowDomain` const, and swapping the system prompt's `content` value change inside the handler — the stream call shape, error handling, and headers are unchanged.)

- [ ] **Step 3: Run the full flow test suite and type-check**

Run: `cd flow && npx vitest run && npx tsc --noEmit -p .`
Expected: all tests pass (no existing test references `FLOW_GENERATE_SYSTEM_PROMPT` or this route directly); no new type errors.

- [ ] **Step 4: Commit**

```bash
git add flow/src/index.ts
git commit -m "feat(flow): read domain from /api/flows/generate request body"
```

---

### Task 4: Cross-domain node-type validation (shared frontend)

**Files:**
- Create: `shared/frontend/lib/validate-generated-graph.ts`
- Create: `flow/tests/unit/validate-generated-graph.test.ts` (`flow` is `AiGenerateBar`'s only current caller, so its suite covers this shared file — matching the existing precedent of `analytics/tests/unit/*.test.ts` testing files under `shared/frontend/`)
- Modify: `shared/frontend/components/BarAiGenerate.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (deliberately self-contained — see Global Constraints on the `action`/`actionType` discriminator, reimplemented locally here rather than imported, so `shared/` has no dependency on the `flow`-specific registry).
- Produces: `export function findInvalidNodeType(nodes: unknown, allowedKeys: string[]): string | null` — returns the first node's effective type (its `data.actionType` when `node.type === "action"`, otherwise its `node.type`) that isn't in `allowedKeys`, or `null` if every node is allowed. Consumed by `BarAiGenerate.tsx` in this task. `AiGenerateBarProps` gains `extraBody?: Record<string, unknown>` and `allowedNodeTypes?: string[]`, consumed by `EditorPage.tsx` in Task 5.

- [ ] **Step 1: Write the failing test**

Create `flow/tests/unit/validate-generated-graph.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findInvalidNodeType } from "../../../shared/frontend/lib/validate-generated-graph";

describe("findInvalidNodeType", () => {
  it("returns null when every node's effective type is in the allowed set", () => {
    const nodes = [
      { type: "xContentTrigger" },
      { type: "action", data: { actionType: "xContentAction" } },
    ];
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBeNull();
  });

  it("returns the first disallowed top-level type found", () => {
    const nodes = [{ type: "xContentTrigger" }, { type: "wait" }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger"])).toBe("wait");
  });

  it("uses data.actionType (not node.type) as the effective type for action nodes", () => {
    const nodes = [
      { type: "xContentTrigger" },
      { type: "action", data: { actionType: "xAction" } },
    ];
    // "xAction" is a user-domain actionType — must be rejected even though the allowed
    // set contains the generic "action" React Flow type is never itself checked.
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBe("xAction");
  });

  it("returns null when nodes is not an array", () => {
    expect(findInvalidNodeType(undefined, ["xContentTrigger"])).toBeNull();
    expect(findInvalidNodeType(null, ["xContentTrigger"])).toBeNull();
  });

  it("flags an action node with a missing actionType", () => {
    const nodes = [{ type: "action", data: {} }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger"])).toBe("action");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/validate-generated-graph.test.ts`
Expected: FAIL — `Cannot find module '../../../shared/frontend/lib/validate-generated-graph'`

- [ ] **Step 3: Write the implementation**

Create `shared/frontend/lib/validate-generated-graph.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/validate-generated-graph.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 5 passed (5)`

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

- [ ] **Step 6: Run the full flow test suite and type-check**

Run: `cd flow && npx vitest run && npx tsc --noEmit -p .`
Expected: all tests pass, plus the 5 new ones; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add shared/frontend/lib/validate-generated-graph.ts flow/tests/unit/validate-generated-graph.test.ts shared/frontend/components/BarAiGenerate.tsx
git commit -m "feat(shared): reject cross-domain node types from AI-generated flow graphs"
```

---

### Task 5: Wire domain through the editor toolbar

**Files:**
- Modify: `flow/frontend/pages/EditorPage.tsx:83-93` (the `<AiGenerateBar>` usage inside `EditorToolbar`)

**Interfaces:**
- Consumes: `AiGenerateBarProps.extraBody`/`allowedNodeTypes` (Task 4), `generatableKeysForDomain` (Task 1).
- Produces: nothing further downstream — leaf wiring task.

No new automated test: this is a prop-wiring change inside a component with no existing test coverage or test infrastructure in this codebase (no jsdom/React Testing Library setup anywhere). Verified manually per Step 3.

- [ ] **Step 1: Compute domain and pass it through**

In `flow/frontend/pages/EditorPage.tsx`, add the import at the top:

```ts
import { generatableKeysForDomain, type FlowDomain } from "../../nodeTypeRegistry";
```

Inside `EditorToolbar` (the function starting at line 18), replace:

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

with:

```tsx
      <AiGenerateBar
        endpoint="/api/flows/generate"
        context={(() => { const { nodes, edges } = useFlowEditor.getState(); return { nodes, edges }; })()}
        extraBody={{
          domain: (useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user") satisfies FlowDomain,
        }}
        allowedNodeTypes={generatableKeysForDomain(
          useFlowEditor.getState().nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user"
        )}
        placeholder="Describe your flow..."
        onResult={(graph) => {
          if (Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
            replaceGraph(graph.nodes, graph.edges);
            setTimeout(() => document.querySelector<HTMLButtonElement>("[data-arrange]")?.click(), 100);
          }
        }}
      />
```

(This mirrors `Sidebar.tsx:37`'s exact domain-inference formula, computed twice inline — once for `extraBody`, once for `allowedNodeTypes` — matching this component's existing style of inline `useFlowEditor.getState()` reads rather than introducing a new local variable pattern not used elsewhere in this file.)

- [ ] **Step 2: Type-check**

Run: `cd flow && npx tsc --noEmit -p .`
Expected: no new errors introduced.

- [ ] **Step 3: Manual browser verification**

Start the dev server (project's usual local `wrangler dev`/Vite flow) and in a browser:
1. Open the Content Flows tab, create a new content flow (an `xContentTrigger` node is auto-seeded per existing `?domain=content` behavior).
2. Generate: `repost every post in a list`. Confirm the result contains an `xContentTrigger` node (mode `list_posts`) connected to an `action` node with `data.actionType: "xContentAction"`, `operation: "repost-post"` — check via the Inspector's Operation dropdown (should show "Repost") and the trigger's Mode dropdown.
3. Generate again on the same content flow: `mark this post as published after reposting`. Confirm it produces (or extends the graph with) an `updateContentStatus` action node.
4. Switch to the User Flows tab, create a new user flow, and generate: `mute anyone who unfollows me`. Confirm it still produces `xTrigger`/`action` (`xAction`) nodes as before — no regression.
5. Open the browser Network tab and confirm the `POST /api/flows/generate` request body includes `"domain":"content"` or `"domain":"user"` matching the active tab.
6. Try to provoke the validator: on the Content Flows tab, generate something oddly phrased enough that the LLM might reach for a user-domain node (e.g. `unfollow anyone who reposts this`) — if it does produce a disallowed type, confirm the bar shows the `[Generated an invalid node type ...]` message instead of silently applying a broken graph. (This step may not always trigger depending on what the LLM actually returns — it's a best-effort manual check, not a hard requirement, since the model's output isn't deterministic.)

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/pages/EditorPage.tsx
git commit -m "feat(flow): pass flow domain and allowed node types to the AI generate bar"
```

---

### Task 6: Sidebar refactor — registry-driven visibility (isolated)

**Files:**
- Modify: `flow/frontend/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `NODE_TYPE_REGISTRY` (Task 1).
- Produces: nothing downstream — isolated, deferrable task with no dependency from Tasks 2-5.

This task is independent of the generate feature's correctness (Tasks 1-5 are already complete and shippable without it) — it exists purely to eliminate the now-duplicated domain-visibility logic between `Sidebar.tsx`'s inline literals and the registry. If manual verification (Step 2) turns up any behavior difference, this task can be reverted/deferred without affecting Tasks 1-5.

- [ ] **Step 1: Replace inline `visible()` literals with registry lookups**

In `flow/frontend/components/Sidebar.tsx`, replace:

```tsx
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";

type Domain = "user" | "content" | "both";
```

with:

```tsx
import { useFlowEditor } from "../store/flow-editor";
import { CHANNEL_TYPES } from "../config/trigger-fields";
import { NODE_TYPE_REGISTRY, type FlowDomain } from "../../nodeTypeRegistry";
```

Replace:

```tsx
export default function Sidebar() {
  const nodes = useFlowEditor((s) => s.nodes);
  const domain: Domain = nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user";
  const visible = (itemDomain: Domain) => itemDomain === "both" || itemDomain === domain;
```

with:

```tsx
export default function Sidebar() {
  const nodes = useFlowEditor((s) => s.nodes);
  const domain: FlowDomain = nodes.some((n) => n.type === "xContentTrigger") ? "content" : "user";
  const visible = (nodeTypeKey: string) => {
    const cfg = NODE_TYPE_REGISTRY[nodeTypeKey];
    return !cfg || cfg.domain === "both" || cfg.domain === domain;
  };
```

Then update every `visible(...)` call site to pass the item's own node-type/actionType key instead of a literal domain string, and remove the gate entirely from items that had none (since `wait`/`timeCondition`/`abSplit`/`webhook` are registered as `domain: "both"`, wrapping them in `visible(...)` is a no-op that keeps the code uniform — every draggable item goes through the same check):

```tsx
        {visible("xTrigger") && CHANNEL_TYPES.map((ct) => (
          <DraggableItem
            key={ct.channelType}
            type="xTrigger"
            label={`${ct.label} Trigger`}
            description={`${ct.events.length} events`}
            color="border-primary/30 bg-primary/5"
            icon={ct.icon}
          />
        ))}
        {visible("cronTrigger") && (
          <DraggableItem type="cronTrigger" label="Cron Trigger" description="Trigger on a schedule" color="border-primary/30 bg-primary/5" icon="⏰" />
        )}
        {visible("xContentTrigger") && (
          <DraggableItem type="xContentTrigger" label="X Content Trigger" description="Trigger on new X content" color="border-primary/30 bg-primary/5" icon="𝕏" />
        )}
      </div>

      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Flow Control</h3>
      <div className="space-y-2 mb-6">
        {visible("waitForEvent") && (
          <DraggableItem type="waitForEvent" label="Wait for Event" description="Check if event has occurred" color="border-secondary bg-secondary/30" icon="🔍" />
        )}
        {visible("wait") && (
          <DraggableItem type="wait" label="Wait" description="Delay for a specified duration" color="border-secondary bg-secondary/30" icon="⏳" />
        )}
        {visible("timeCondition") && (
          <DraggableItem type="timeCondition" label="Time Condition" description="Gate by time-of-day / day-of-week" color="border-secondary bg-secondary/30" icon="🕐" />
        )}
        {visible("userPropsCondition") && (
          <DraggableItem type="userPropsCondition" label="User Props" description="Branch by user properties" color="border-secondary bg-secondary/30" icon="👤" />
        )}
        {visible("abSplit") && (
          <DraggableItem type="abSplit" label="A/B Split" description="Split traffic by % or condition" color="border-secondary bg-secondary/30" icon="⚡" />
        )}
      </div>

      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Actions</h3>
      <div className="space-y-2">
        {visible("addToList") && (
          <DraggableItem type="addToList" label="Add to List" description="Add user to a profile list" color="border-accent bg-accent/50" icon="📋" />
        )}
        {visible("xAction") && (
          <DraggableItem type="xAction" label="X Action" description="Follow or unfollow user on X" color="border-accent bg-accent/50" icon="𝕏" />
        )}
        {visible("webhook") && (
          <DraggableItem type="webhook" label="Webhook" description="Send HTTP request" color="border-accent bg-accent/50" icon="🔗" />
        )}
        {visible("changeUserProps") && (
          <DraggableItem type="changeUserProps" label="Change User Props" description="Update user properties" color="border-accent bg-accent/50" icon="✏️" />
        )}
        {visible("xContentAction") && (
          <DraggableItem type="xContentAction" label="X Content Action" description="Generate (or post as-is) and publish to another channel" color="border-accent bg-accent/50" icon="✨" />
        )}
        {visible("tiktokContentAction") && (
          <DraggableItem type="tiktokContentAction" label="TikTok Photo Post" description="Generate images + caption and send to TikTok as a draft" color="border-accent bg-accent/50" icon="📸" />
        )}
        {visible("updateContentStatus") && (
          <DraggableItem type="updateContentStatus" label="Update Content Status" description="Set this content's status" color="border-accent bg-accent/50" icon="🏷️" />
        )}
      </div>
```

(The `DraggableItem` component itself, its props, and the surrounding `<aside>`/`<h3>` structure are unchanged — only the `visible(...)` call sites and their argument change.)

- [ ] **Step 2: Manual before/after equivalence check**

In a browser, before committing: open the User Flows tab's Sidebar and list every visible draggable item; open the Content Flows tab's Sidebar and list every visible draggable item. Confirm both lists are byte-identical to what they were before this task's edit (same items, same order, same labels) — this task must be a pure refactor with zero visible behavior change.

- [ ] **Step 3: Type-check**

Run: `cd flow && npx tsc --noEmit -p .`
Expected: no new errors introduced.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/components/Sidebar.tsx
git commit -m "refactor(flow): drive Sidebar node-type visibility from the central registry"
```

---

## Self-Review Notes

- **Spec coverage:** Change 1 (registry) → Task 1. Change 2 (explicit `domain` field) → Task 5 (frontend send) + Task 3 (backend read/default). Change 3 (two prompts, user frozen/content from registry) → Task 2. Change 4 (validation, moved to frontend, `action`/`actionType`-aware) → Task 4. Change 5 (Sidebar refactor) → Task 6.
- **Placeholder scan:** no TBD/TODO; all steps carry complete, runnable code.
- **Type consistency:** `FlowDomain` is defined once in `flow/nodeTypeRegistry.ts` (Task 1) and imported by `flow/src/generate-prompt.ts` (Task 2/3) and `flow/frontend/pages/EditorPage.tsx`/`Sidebar.tsx` (Tasks 5/6) — a single definition, not a re-declared literal union, correcting the previous draft's unnecessary duplication. `findInvalidNodeType`'s `action`/`actionType` handling (Task 4) is intentionally a second, independent implementation of the same discriminator logic that lives in the registry's conceptual model (Task 1) — not imported, because `shared/` must not depend on the `flow`-specific registry; this duplication is small (4 lines), stable, and called out explicitly in Task 4's file header comment.
- **Corrected from the first draft:** the original plan scoped the content prompt/allow-list to just `xContentTrigger`/`xContentAction` and assumed `xContentAction` was its own top-level `node.type` — both wrong. This version reflects the verified 5-type palette and the `type: "action"` + `data.actionType` discriminator throughout.
