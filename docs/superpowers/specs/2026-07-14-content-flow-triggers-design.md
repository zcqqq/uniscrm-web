# Content-Triggered Flow Design

## Context

`flow` today is entirely user-scoped: every trigger event, condition, action, and persistence row (`flow_executions`, `flow_pending`, `rate_limits`) is keyed on a `userId` coming from X's Account Activity webhook (`link/src/webhook.ts` → `FLOW_QUEUE`). There is no path from content ingestion (`link`'s X/TikTok content pollers) into `flow` at all.

This design adds a second, parallel trigger/action domain: **content-flows**, which fire when the tenant's own connected channel ingests a new piece of content, and can react by reposting it or by AI-rewriting it for another connected channel.

## Scope: which of your two motivating scenarios this covers

- **"See my new X post → AI-rewrite → publish to TikTok"** — fully covered, this is the flagship scenario for this design.
- **"See someone else's post → repost it"** — **not covered**. The trigger source is scoped to the tenant's *own* connected-channel content (per the X/TikTok pollers, which only ingest the account's own posts/videos). The `repost` action this design adds can therefore only re-share content the tenant's own account just posted (self-boost), not discover and repost a third party's content. Watching other accounts/keywords/trends is a materially different subsystem (new search/monitoring ingestion, new channel-binding semantics) and is explicitly deferred as a separate future project, not part of this design.

## 1. `contentTrigger` node

New node type, parallel to `xTrigger`/`cronTrigger`. `data: { conditions: [{ field, operator, value }] }` — no separate event-type selector, since there is exactly one content-domain event (`content.created`).

Condition fields are **not** a new metadata definition — they come straight from `PROPS.filter(p => p.entity?.includes("content"))` (`metadata/props.ts`), the same entity-tagged registry `buildEntityColumns` already consumes for the Link Content table. This includes `channel_type`, `content_type`, `view_count`, `like_count`, etc., so e.g. "only fire for `channel_type == X`" is just a condition row like any other — no new UI concept needed beyond a `getContentTriggerFields()` analog to `flow/frontend/config/trigger-fields.ts`'s `getChannelTypes()`, sourced from `PROPS` instead of `EventMetadata_X`.

`evaluateCondition()` in `engine.ts` is already payload-shape-agnostic — it needs zero changes. Only `executeFlow()`'s trigger-node filter gains one clause:

```ts
const triggerNodes = graph.nodes.filter(
  (n) => (n.type === "xTrigger" && ...)
    || (n.type === "cronTrigger" && eventType === "cron.trigger")
    || (n.type === "contentTrigger" && eventType === "content.created")
);
```

## 2. Bridge: `link` → `FLOW_QUEUE`

`ContentService.upsertContentFromMetadata()` (`link/src/services/content.ts:140`) is the single write choke point for both the X posts poller and the TikTok content poller, and already computes `isNew`. This is where the event gets emitted — not in the pollers themselves, so both channels get it for free.

**Decision: reuse the existing `FLOW_QUEUE` binding/queue (`uniscrm-event`) — do not create a second queue.** The transport stays a single channel; only the message shape is extended to be a discriminated union (`userId` XOR `contentId`):

```ts
// flow/src/types.ts
export interface FlowQueueMessage {
  tenantId: string;
  eventType: string;
  channelId: string;
  payload: Record<string, unknown>;
  userId?: string;    // present for user-domain events
  contentId?: string; // present for content-domain events
}
```

The consumer in `flow/src/index.ts`'s `queue()` handler dispatches on which of `userId`/`contentId` is present.

`ContentService`'s constructor (`tenantDb, vectorize, ai, tenantId, pipelineContent?`) gains a 6th optional param, `flowQueue?: Queue`, wired only at the two poller call sites (`pollers/x-posts.ts:40`, `pollers/tiktok-content.ts:39`) — the other seven `new ContentService(...)` call sites (manual sync, Notion sync, routes) are untouched, since only poller-sourced content should fire content-flows (see backfill gating below).

**Backfill gating (correctness decision, not previously discussed with you — flagging explicitly for spec review):** a newly-connected channel's first poll backfills potentially hundreds of historical posts, each of which is `isNew`. If content-flow triggers fired for all of them, connecting a channel would mass-fire `aiRewritePublish`/`repost` actions against a channel's entire back-catalog on day one. `upsertContentFromMetadata` gains an `emitFlowEvent: boolean` parameter; the poller passes `false` during the backfill phase and `true` once `backfill_complete = 1` (incremental polling) — mirroring the existing `channel_poll_state.backfill_complete` flag already used for repoll gating in `poll-channel.ts`. Only genuinely new incremental content fires flows.

Emitted message shape:

```ts
{
  tenantId: String(tenantId),
  eventType: "content.created",
  contentId: id,
  channelId,
  payload: { channel_type: channelType, ...resolvedProps },
}
```

## 3. Persistence: parallel content-scoped tables

New `flow` migration adds `content_flow_pending`, `content_flow_executions` — identical shape to `flow_pending`/`flow_executions` with `content_id TEXT NOT NULL` in place of `user_id TEXT NOT NULL`. `rate_limits` is reused unchanged (already a generic `key`-string table, e.g. `x:repost:<channelId>`).

No changes to `flows`, `flow_executions`, `flow_pending`, or existing `rate_limits` rows/data. User-flows are completely unaffected.

## 4. New actions

Reuses the existing generic `action` node + `data.actionType` discriminator (`ActionNode.tsx`'s `EXTERNAL_API_ACTIONS` pattern) — no new node components, same as `xAction`/`addToList`/`changeUserProps` today.

- **`repost`** — external API, gets `success`/`failed` branches (per `flow/CLAUDE.md`'s convention for third-party-API actions). This phase calls an explicitly TODO-stubbed `link` internal endpoint (e.g. `/internal/x/repost`, returns a marked-not-implemented response) — the real X repost call is out of scope (see Non-goals).
- **`aiRewritePublish`** — external API, `success`/`failed` branches, node data includes a target `channelId` (destination channel to publish to, may differ in channel_type from the source). Same TODO-stub treatment this phase.
- **`updateContentStatus`** — internal, single branch (like `changeUserProps`). `data: { status: "published" | "ignored" | ... }`, writes `content.status` directly via `TenantDataDB`.

The real X repost API and TikTok Content Posting API integrations are **not** part of this design (see Non-goals) — the stubs exist so the flow-engine framework (trigger → condition → branch → action → log) is fully buildable and testable end-to-end without waiting on those.

## 5. Guardrail: user-only nodes in content-flows

`userPropsCondition` and `changeUserProps` both query/update the tenant `user` table by `userId` — meaningless with no user in context. **Decision: hide, don't fail at runtime.** `Sidebar.tsx`'s node palette filters out `userPropsCondition`/`changeUserProps` (and, symmetrically, `repost`/`aiRewritePublish`/`updateContentStatus`/`contentTrigger`) based on which domain the flow's root trigger node belongs to — the root trigger node type is the single source of truth for a flow's domain (a flow is either a user-flow or a content-flow, never mixed, consistent with `executeFlow`'s existing one-trigger-type-per-graph model).

## 6. Frontend: separate tab, not a merged list

Per your direction, content-flows are **not** a badge inside the existing Flows table — `FlowsPage` becomes tabbed: "User Flows" (existing behavior, default) and "Content Flows" (new).

- **Backend filter**: `GET /api/flows` gains a `domain` query param (`user` | `content`). Mirrors the existing `graph_json LIKE '%cronTrigger%'` pattern already used in the cron scheduler (`flow/src/index.ts:763`) rather than adding a schema column: `AND f.graph_json LIKE '%contentTrigger%'` for the content tab, `AND f.graph_json NOT LIKE '%contentTrigger%'` for the user tab. Applied to both the `COUNT(*)` and the paginated `SELECT`.
- **`useFlows()`** gains a `domain` param threaded through to `api.flows.list(page, domain)`.
- **New-flow seeding**: `/flows/new` gains a `?domain=content` variant (alongside the existing `?template=`) so a blank "New" from the Content Flows tab seeds a starter `contentTrigger` node instead of the default `xTrigger` seed.
- **`FLOW_TEMPLATES`** (`config/templates.ts`) gains a `domain: "user" | "content"` field (existing templates default `"user"`); at least one new content-domain template ships: `contentTrigger → action(aiRewritePublish)`, matching your flagship scenario.
- Template-card grid and table on `FlowsPage` filter by the active tab's domain.

## 7. Documentation deliverables (CLAUDE.md-mandated)

- **`flow/sequence.md`** (existing file) gets a second `mermaid sequenceDiagram` block appended for the content path — not a new file, since most participants (`FLOW_QUEUE`/`flow Worker`/`PIPELINE_FLOW_LOG`) are shared with the existing user-event diagram already in that file:

  ```
  link Worker (poller) → FLOW_QUEUE → flow Worker → content_flow_pending / stubbed action endpoint
  ```

- **`link/src/services/status.md`** (new file) documents the `content.status` state machine: `new → pending → published | ignored`, including the new edge this design adds (`updateContentStatus` action driving an automated transition). The column is literally named `status`, not `xxx_status`, so the CLAUDE.md trigger condition ("`_status`-suffixed field") doesn't strictly apply — but since flow-driven automation now writes into this state machine, documenting it is more correct than relying on the literal suffix rule.

## Testing

- Unit tests for `executeFlow`/`collectActions` with `contentTrigger` and the three new action types (mirroring existing `xTrigger`/`xAction` test coverage in `engine.ts`'s test suite).
- Unit test for `upsertContentFromMetadata`'s `emitFlowEvent` gating: backfill phase does not enqueue, incremental phase does, only for genuinely new (`isNew`) rows.
- Unit test for the `FlowQueueMessage` consumer dispatch: `contentId`-shaped messages route to `content_flow_pending`/`content_flow_executions`, `userId`-shaped messages are unaffected (regression coverage for existing user-flows).
- Frontend: `Sidebar` node-palette filtering by domain; `FlowsPage` tab-based fetch/count correctness.

## Non-goals

- Real X repost API and TikTok Content Posting API implementations (action endpoints are stubs this phase).
- Keyword/competitor/trend content monitoring ("see someone else's post" — deferred as a separate future project).
- Per-flow configurable publish-approval toggle (all actions in this design auto-execute, consistent with existing `xAction` behavior).
- Mixing user-trigger and content-trigger nodes in the same flow graph.
