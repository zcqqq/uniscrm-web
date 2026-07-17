# Flow Generate: Domain-Scoped Node Vocabulary — Design

**Goal:** Make `POST /api/flows/generate` (the AI flow-generation endpoint) aware of Flow Domain, so generating a content flow (e.g. "repost every post in a list") produces content-domain node types instead of the current user-flow-only vocabulary, and vice versa — driven by a single central node-type registry rather than hand-maintained, duplicated lists that go stale (as happened mid-design: a `tiktokContentAction` node type landed from a concurrent session after this design's first draft, silently invalidating an already-approved, too-narrow node list).

## Context

`flow/src/index.ts:802-858` implements `/api/flows/generate`: a single hardcoded system prompt (`FLOW_GENERATE_SYSTEM_PROMPT`) lists exactly 4 node types — `xTrigger`, `wait`, `waitForEvent`, `action` (`xAction`/`addToList`) — all from the user-flow vocabulary. This prompt is used unconditionally, regardless of which Flow Domain (see `CONTEXT.md`) the user is actually working in.

Today there is no persisted `domain` field on a flow; it's inferred in three places by checking for an `xContentTrigger` node (`Sidebar.tsx:37`, `flow/src/index.ts:552-553`, `EditorPage.tsx`'s template lookup). The generate endpoint doesn't participate in this inference at all.

**Node-type domain palette (corrected):** `Sidebar.tsx:35-96` gates each draggable node type by domain via a `visible(itemDomain)` helper called inline per item — some items pass no gate at all (visible in every domain). The true content-domain-reachable set is 5 types, not the 2 originally assumed:

| Node type | React Flow `node.type` | `data.actionType` (if applicable) | Domain | Backend-functional? |
|---|---|---|---|---|
| `xContentTrigger` | `xContentTrigger` | — | content | yes (trigger) |
| `xContentAction` | `action` | `xContentAction` | content | yes |
| `tiktokContentAction` | `action` | `tiktokContentAction` | content | yes — fully implemented (landed after this design's first draft; real `/internal/tiktok/photo-post` call, `link/src/routes-internal.ts:289`) |
| `updateContentStatus` | `action` | `updateContentStatus` | content | yes — direct D1 status write, no branches |
| `wait` | `wait` | — | both | yes |
| `timeCondition` | `timeCondition` | — | both | **no** — `data.timeFrom/timeTo/daysOfWeek` never read anywhere; always passes through immediately |
| `abSplit` | `abSplit` | — | both | **no** — branch never resolved in either domain; dead end |
| `webhook` | `webhook` | — | both | **no** — not handled at all in the content-flow executor (`executeContentActions`); HTTP call never fires for content flows |

**Critical shape fact:** `addToList`, `xAction`, `xContentAction`, `tiktokContentAction`, and `updateContentStatus` are all rendered by one generic node component with React Flow `node.type === "action"` — they're distinguished only by `data.actionType` (`flow/frontend/store/flow-editor.ts:92-147`). A validator or prompt that checks `node.type` alone cannot tell an `xContentAction` from an `xAction` — both are `type: "action"`. Any domain-scoping logic must special-case `type === "action"` and switch on `data.actionType` instead.

Confirmed supporting facts:
- `action` nodes with `actionType` in `{"xAction", "xContentAction", "tiktokContentAction"}` render `success`/`failed` source handles (`ActionNode.tsx`'s `EXTERNAL_API_ACTIONS`); `addToList`/`updateContentStatus`/`changeUserProps` do not branch.
- `xContentTrigger`'s `data` shape: `{ channelId, mode: "my_posts"|"list_posts", listId, listName, conditions }`.
- `xContentAction`'s operations come from `ContentMetadata_X` (`metadata/x-byok.ts:61-75`): `"create-post"` and `"repost-post"`.
- `/api/flows/generate` streams the raw LLM SSE response straight through to the browser (`flow/src/index.ts:905`) — it never assembles or returns the final JSON server-side. This rules out backend-side output validation (see Change 3).

## Behavior

### 1. Central node-type registry

A single new data file (location decided in the implementation plan) declares, per node-type key (the `node.type` value, or the `data.actionType` value for `action`-family nodes): which Flow Domain(s) it belongs to (`"user" | "content" | "both"`), whether the AI generate feature may produce it (`generatable`), and — only for content-domain generatable entries — the LLM-facing prompt fragment describing its `data` shape.

This registry becomes the single source of truth for two currently-duplicated, now-provably-stale-prone concerns:
- `Sidebar.tsx`'s per-item domain visibility (today: ad-hoc `visible("user")`/`visible("content")` literals scattered across ~15 JSX call sites).
- The generate feature's per-domain allow-list (used by both the content prompt builder and the output validator).

Adding a new node type in the future means adding one registry entry; Sidebar visibility and generate's allow-list both pick it up automatically. The LLM-facing prompt *text* for a new content node type still needs to be hand-authored in that entry's fragment (an inherent limit — the LLM needs prose, which can't be auto-derived from a type name) — but everything else is single-sourced.

### 2. Domain becomes an explicit request field

`EditorPage.tsx` computes `domain` from the currently-loaded graph using the same formula `Sidebar.tsx` already uses: `nodes.some(n => n.type === "xContentTrigger") ? "content" : "user"`. It sends this as a new `domain` field in the generate request body on every call.

Backend defaults to `"user"` if `domain` is missing or not exactly `"user"`/`"content"` (safe fallback matching today's only behavior).

### 3. Two system prompts — user prompt frozen, content prompt built from the registry

**User-domain prompt: byte-for-byte unchanged.** It stays the existing hardcoded constant, untouched — per explicit instruction, this task does not rebuild or refactor it, even though doing so would technically be possible.

**Content-domain prompt: assembled from the registry's content-domain generatable entries** (`xContentTrigger`, `wait`, and one grouped `action` item listing `xContentAction`/`tiktokContentAction`/`updateContentStatus` as sub-variants — mirroring the exact style the frozen user prompt already uses for its own `action` item's `xAction`/`addToList` sub-variants). Every action-family fragment states the `type: "action", data: { actionType: "...", ... }` shape explicitly, so the LLM never emits an invalid top-level `type: "xContentAction"`.

Rules section (content prompt only) explicitly forbids user-domain types, and requires the flow to start with exactly one `xContentTrigger`.

### 4. Output validation — moved to the frontend (deviation from the original plan)

**Deviation, confirmed by reading the actual route:** the endpoint proxies a raw AI SSE stream and never sees/returns the final assembled JSON server-side (`flow/src/index.ts:885-912`) — so backend-side "reject before returning" validation, as originally envisioned, isn't implementable without sacrificing the live streamed progress log. The check moves to the frontend: `shared/frontend/components/BarAiGenerate.tsx` already parses the complete JSON once the stream ends, right before calling `onResult` — that's the only point that ever holds the full parsed graph, so it's also the only practical validation point. This is output-quality validation, not a security boundary, so nothing is lost by not doing it server-side.

The check must use the `type === "action"` → `data.actionType` discriminator (see Context) — checking `node.type` alone would silently pass a cross-domain `action` node through undetected.

### 5. Sidebar refactor (isolated)

`Sidebar.tsx`'s inline `visible("user")`/`visible("content")` per-item literals are replaced with lookups into the same registry, keyed by each item's node-type/actionType. This is a mechanical, same-behavior refactor (verified by confirming each domain's visible item set is unchanged before/after) done for the DRY benefit described in Change 1 — it's independent of the generate-feature correctness and can be deferred without blocking the rest of this design if it turns out to be riskier than expected.

## Non-goals

- Fixing `timeCondition`/`abSplit`/`webhook`'s non-functional backend execution (in either domain) — separate, already-flagged issue. They are marked `generatable: false` in the registry and excluded from both prompts and both allow-lists.
- Fixing the user-domain prompt's staleness (missing `cronTrigger`/`changeUserProps`, etc.) — explicitly out of scope; the user-domain prompt is not touched at all by this task.
- Persisting a real `domain`/`flowType` column on the `flows` table — inference-based domain stays as-is; this task only adds an explicit `domain` field to the generate request contract, not to the stored flow entity.
- Any change to node execution/engine behavior for any node type — this task only touches the generation (registry + prompt + validation) and Sidebar-visibility paths.
