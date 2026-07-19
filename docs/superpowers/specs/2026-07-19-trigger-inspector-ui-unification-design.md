# Trigger Inspector UI Unification Design

**Goal:** Give `xTrigger`, `xContentTrigger`, and `youtubeContentTrigger` — the three "channel trigger" node types — a consistent Inspector layout: **Event → Account → (event-specific field) → Conditions**, with the Conditions section labeled "Event Props" or "Content Props" to match the terminology `SelectPropsValue` already uses internally. Also fixes a real gap found while designing this: `xTrigger`'s Account selection is currently never enforced at runtime.

**Not in scope (deferred to a separate spec):** YouTube multi-account OAuth support. This spec keeps YouTube as the single-connection-per-tenant model it is today; its new Account dropdown will simply always show one pre-selected option until that follow-up work ships.

## Current state (facts gathered before designing)

- `XTriggerInspector` (`flow/frontend/components/Inspector.tsx:157`) already has the target Event → Account → Conditions order. Its Account `<Select>` defaults to `""` ("All accounts"), and critically, `flow/src/engine.ts`'s trigger-matching (`executeFlow`, line 166) never checks `n.data.channelId` for `xTrigger` at all — only `eventType`. The dropdown is cosmetic today.
- `XContentTriggerInspector` (line 235) has no Event dropdown — `own:get-posts` exists in `ContentMetadata_X` but isn't `flowType: "trigger"` (poll-only; comment in `nodeTypeRegistry.ts:82` confirms it "feeds content ingestion but never fires a content flow"), so `get-list-posts` is the only content-flow-triggering mode. Order today is Account → List → Conditions.
- `YouTubeContentTriggerInspector` (line 315) has no Account dropdown at all — YouTube is architecturally single-connection per tenant (`link/src/routes-channels.ts:360`: "Generic simple OAuth channel (single-connection, connect/disconnect only)"). Order today is Subscription → Conditions. `metadata/youtube.ts`'s single entry now has `label: {"en": "Subscription Videos", "zh": "订阅的视频"}` (added directly by the user during design).
- `ConditionsEditor` (`Inspector.tsx:80`) renders a hardcoded "Conditions" header for every caller, including `WaitForEventInspector` (a flow-control node, not a channel trigger — explicitly out of scope, keeps "Conditions").
- `shared/frontend/components/SelectPropsValue.tsx` already groups the field picker's own dropdown by `"Event Props"` / `"User Props"` / `"Content Props"` (lines 133/155/177) — this spec's renamed section headers reuse that exact terminology rather than inventing new copy.
- The data needed to enforce `xTrigger`'s channelId is already flowing: `link/src/webhook.ts` sends `channelId` as a top-level field on every `FLOW_QUEUE.send(...)` call for follow/unfollow/DM/chat events. `flow/src/index.ts`'s queue consumer (`queue()`, ~line 1093, the `userId` branch) destructures `channelId` off the message but never merges it into the `payload` object passed to `executeFlow` — unlike the `contentId` branch (line 1037-1041), which already builds a `matchPayload` with `channel_id: channelId` merged in.

## Changes

### 1. `flow/src/engine.ts` — enforce `channelId` for `xTrigger`

Line 166's trigger filter gains a channelId check, mirroring the existing `xContentTrigger`/`youtubeContentTrigger` clauses:

```ts
(n) => (n.type === "xTrigger"
        && (n.data.eventType === eventType || n.data.triggerType === eventType)
        && n.data.channelId === payload.channel_id)
  || ...
```

No fallback for empty `channelId`. This is a **hard cutover**: any already-published flow with `channelId === ""` (today's "All accounts") will stop matching entirely once this deploys, until someone opens and re-saves it with a real channel picked. Confirmed acceptable — dev-only data today, no migration script.

### 2. `flow/src/index.ts` — merge `channel_id` into the match payload

In the `queue()` handler's `userId` branch (~line 1093), build a `matchPayload` the same way the `contentId` branch already does, and pass that instead of the raw `payload`:

```ts
const matchPayload = { ...payload, channel_id: channelId };
const result = executeFlow(graph, eventType, matchPayload);
```

`payload` (unmodified) continues to be what's stored in `flow_pending`/passed to `executeActions` — only the value passed to `executeFlow` changes, matching how the content-domain branch already separates "what's matched against" from "what's stored/acted on."

### 3. `XTriggerInspector` — mandatory single-channel Account

- Remove the `<option value="">All accounts</option>` entry entirely.
- When `channels.length === 1`, auto-select it: if `channelId` is unset once the channel list loads, call `updateNodeData(nodeId, { channelId: channels[0].id })`.
- When `channels.length === 0`, keep today's "No accounts linked" message (nothing to select).
- When `channels.length >= 2`, the dropdown requires an explicit pick — starts unselected (no reasonable default among multiple).

### 4. `XContentTriggerInspector` — add Event dropdown, auto-select Account

New Event `<Select>` above the existing Account dropdown:

```tsx
<Label className="text-xs block mb-1">Event</Label>
<Select value={CONTENT_X_TRIGGER_MODE_LIST_POSTS} disabled className="w-full text-sm">
  <option value={CONTENT_X_TRIGGER_MODE_LIST_POSTS}>List Posts</option>
</Select>
```

Since there is exactly one option today, it's rendered pre-selected (auto-select-when-singular, per the same rule applied to Account). No `data.mode` write is needed on mount — `data.mode` already defaults to `CONTENT_X_TRIGGER_MODE_LIST_POSTS` elsewhere (`flow-editor.ts`'s `addNode` default). The dropdown is disabled rather than removed, so the slot is visually present and ready for a second option later (own:get-posts is explicitly not being enabled as a trigger in this spec).

Account dropdown: same auto-select-when-1 behavior as `XTriggerInspector` — when `channels.length === 1` and `channelId` is unset, auto-select it (still keeps `mode`/`listId`/`listName` reset behavior it already has on manual change).

List dropdown: unchanged, stays keyed off the selected Event (currently only "List Posts" needs it). This is the "event-specific field" — if a second Event option is ever added, this slot is looked up by `eventType`/mode rather than assumed to always be "List."

Conditions header → "Content Props".

### 5. `YouTubeContentTriggerInspector` — add Event and Account dropdowns

Event dropdown: same disabled/pre-selected pattern as #4, single option sourced from `ContentMetadata_YouTube`'s new `label` field:

```tsx
<Label className="text-xs block mb-1">Event</Label>
<Select value="watch:get-videos" disabled className="w-full text-sm">
  <option value="watch:get-videos">{localizeLabel(YOUTUBE_TRIGGER_META.label!, "en")}</option>
</Select>
```

Account dropdown: real `<Select>`, single pre-selected option showing the connected account's email. Requires extending `link/src/routes-channels.ts`'s `GET /youtube/subscriptions` response to also include `email` (same `config` object already parsed there — just add the field, no new query):

```ts
return c.json({
  connected: true,
  accountChannelId: accountRow.id,
  email: config.email,
  subscriptions: config.subscriptions || [],
});
```

`flow/src/index.ts`'s `/api/channels/youtube/subscriptions` proxy is a pure pass-through — no change needed there. Inspector renders:

```tsx
<Label className="text-xs block mb-1">Account</Label>
<Select value={state.accountChannelId || ""} disabled className="w-full text-sm">
  <option value={state.accountChannelId || ""}>{state.email}</option>
</Select>
```

Subscription dropdown: unchanged — the event-specific field for "Subscription Videos", keyed the same way List is for X.

Conditions header → "Content Props".

Both new dropdowns render disabled today since there is truly only ever one possible value (this is architectural, not incidental — see "Not in scope" above). When YouTube multi-account ships as a follow-up, the Account `<Select>` here becomes the one that gets enabled with real options; no other part of this design needs to change.

### 6. `ConditionsEditor` — parameterized header

Add a `label` prop, defaulting to `"Conditions"`:

```ts
function ConditionsEditor({ conditions, fields, onChange, label = "Conditions" }: { ...; label?: string }) {
  ...
  <Label className="text-xs">{label}</Label>
  ...
}
```

Callers: `XTriggerInspector` passes `"Event Props"`; `XContentTriggerInspector` and `YouTubeContentTriggerInspector` pass `"Content Props"`; `WaitForEventInspector` passes nothing (keeps default `"Conditions"`).

## Out of scope

- YouTube multi-account OAuth support (separate spec, ships later; this spec's YouTube Account dropdown is single-option by design until then).
- Enabling `own:get-posts` as a real second trigger mode for `xContentTrigger` (stays poll-only/ingestion-only).
- Renaming `WaitForEventInspector`'s "Conditions" header (out of the three named node types' scope).

## Testing

- `flow/tests/unit/engine.test.ts`: extend `xTrigger` matching tests to cover the new `channelId` check — a node with a specific `channelId` must not match a payload with a different (or missing) `channel_id`, and must match when they agree. Verify via genuine revert-and-restore of the new clause (per this project's existing test-quality bar), not just asserting the happy path.
- `flow/tests/unit/` (queue consumer, wherever the `userId` branch is currently covered): assert `channel_id` is present in the payload passed to `executeFlow` for user-domain messages.
- No frontend component test infrastructure exists in this repo (`flow/frontend` has zero `.test.tsx` files) — Inspector changes are verified via `deploy:dev` + Chrome browser walkthrough per this project's CLAUDE.md UI rule, covering: xTrigger with 0/1/2+ accounts, xContentTrigger's new Event slot + Account auto-select, YouTubeContentTriggerInspector's new Event/Account dropdowns, and all three Conditions headers.
