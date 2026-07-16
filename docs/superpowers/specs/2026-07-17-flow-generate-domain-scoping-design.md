# Flow Generate: Domain-Scoped Node Vocabulary — Design

**Goal:** Make `POST /api/flows/generate` (the AI flow-generation endpoint) aware of Flow Domain, so generating a content flow (e.g. "repost every post in a list") produces `xContentTrigger`/`xContentAction` nodes instead of the current user-flow-only vocabulary, and vice versa.

## Context

`flow/src/index.ts:802-858` implements `/api/flows/generate`: a single hardcoded system prompt (`FLOW_GENERATE_SYSTEM_PROMPT`) lists exactly 4 node types — `xTrigger`, `wait`, `waitForEvent`, `action` (`xAction`/`addToList`) — all from the user-flow vocabulary. This prompt is used unconditionally, regardless of which Flow Domain (see `CONTEXT.md`) the user is actually working in.

Today there is no persisted `domain` field on a flow; it's inferred in three places by checking for an `xContentTrigger` node (`Sidebar.tsx:37`, `flow/src/index.ts:552-553`, `EditorPage.tsx`'s template lookup). The generate endpoint doesn't participate in this inference at all — it never receives or derives a domain value, so a user generating on the Content Flows tab silently gets a graph built from user-flow node types the LLM has no reason to avoid.

Confirmed supporting facts:
- `xContentAction` renders `success`/`failed` source handles identically to `xAction` (`ActionNode.tsx:70-72`, both in `EXTERNAL_API_ACTIONS`).
- `xContentTrigger`'s `data` shape: `{ channelId, mode: "my_posts"|"list_posts", listId, listName, conditions }` (`store/flow-editor.ts:137`, `Inspector.tsx:230-327`).
- `xContentAction`'s operations come from `ContentMetadata_X` (`metadata/x-byok.ts:61-75`): `"create-post"` (needs `channelId`/`prompt`/`provider`) and `"repost-post"` (no additional fields — account/tweet id come from trigger context, per the recently-shipped Repost-operation design).
- The six newer user-flow node types (`cronTrigger`, `timeCondition`, `userPropsCondition`, `abSplit`, `webhook`, `changeUserProps`) exist in the editor but are not in today's generate prompt; `userPropsCondition`/`abSplit`/`timeCondition` are backend-non-functional (branches never resume). **Out of scope for this task** — the user-flow prompt is left untouched.

## Behavior

### 1. Domain becomes an explicit request field

`EditorPage.tsx` computes `domain` from the currently-loaded graph using the exact same formula as `Sidebar.tsx`: `nodes.some(n => n.type === "xContentTrigger") ? "content" : "user"`. It passes this as a new `domain` field on every `api.flows.generate(prompt, currentGraph, domain)` call — not just for brand-new flows. `api.flows.generate`'s signature and the `POST /api/flows/generate` body both gain `domain: "user" | "content"`.

Backend defaults to `"user"` if `domain` is missing or not one of the two valid values (safe fallback matching today's only behavior).

### 2. Two system prompts, shared "Rules" section

Refactor `FLOW_GENERATE_SYSTEM_PROMPT` into a function of `domain` that composes:
- A shared preamble + JSON-shape rules (id format, `position`, edge shape) — unchanged text, extracted once.
- A domain-specific "Available node types" block.
- A domain-specific "flow must start with exactly one X" rule.

**User-domain block: unchanged** — exactly today's 4-node-type text, byte-for-byte (out of scope to fix its staleness).

**Content-domain block (new):**
```
1. xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: "my_posts"|"list_posts", listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation, same as addToList's listId/listName today.
   - mode "my_posts": triggers on the channel's own posts. mode "list_posts": triggers on posts from a specific X List (leave listId/listName blank).

2. xContentAction - perform an action on X content
   data: { actionType: "xContentAction", operation: "create-post"|"repost-post", channelId: "", prompt: "", provider: "default" }
   - operation "create-post": generates and publishes a new post (channelId = target account, left blank for the user to pick; prompt = free-text instructions for AI generation, left blank for the user to fill in).
   - operation "repost-post": reposts the triggering content via the triggering channel's own account — needs no additional fields; leave channelId/prompt/provider at these defaults.
   - Has sourceHandle "success" or "failed" for branching, same as other external-API actions.

Rules:
- Only use xContentTrigger and xContentAction node types. Do NOT use xTrigger, wait, waitForEvent, action, or any other node type — those belong to a different flow domain.
- Flow must start with exactly one xContentTrigger node.
```

### 3. Output validation

After parsing the LLM's JSON response, before returning it to the frontend: filter the generated `nodes` array by `type` against the allowed set for the request's `domain` (`{"xContentTrigger","xContentAction"}` for content, `{"xTrigger","wait","waitForEvent","action"}` for user). If any node's `type` falls outside the allowed set, reject the whole generation — return an error response rather than silently forwarding a cross-domain graph. This mirrors the project's "data accuracy > stability > features" priority (`CLAUDE.md`): a wrong-but-plausible-looking generated graph is worse than a clear failure the user can retry.

## Non-goals

- Fixing the user-domain prompt's staleness (missing `cronTrigger`/`webhook`/`changeUserProps`) or the three non-functional node types (`userPropsCondition`/`abSplit`/`timeCondition`) — separate, already-flagged issue.
- Persisting a real `domain`/`flowType` column on the `flows` table — inference-based domain stays as-is; this task only adds an explicit `domain` field to the generate request/response contract, not to the stored flow entity.
- Any change to `xContentTrigger`/`xContentAction`'s actual node behavior, Inspector, or engine execution — this task only touches the generation (LLM prompt + validation) path.
