# Trigger Inspector UI Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `xTrigger`, `xContentTrigger`, and `youtubeContentTrigger` a consistent Inspector layout — Event → Account → (event-specific field) → Conditions — and fix `xTrigger`'s `channelId` never being enforced at runtime.

**Architecture:** Backend enforcement first (engine.ts matching + queue payload merge), then a shared `ConditionsEditor` label prop, then each of the three Inspector components gets its Event/Account fields added or made consistent, reusing the codebase's existing "auto-select the one connected account" pattern (`api.channels.listCached` + a safety-net `useEffect`, already used by `XActionInspector`).

**Tech Stack:** TypeScript, React, Cloudflare Workers, Vitest (`vitest-pool-workers` for `flow`/`link` module tests), Hono.

## Global Constraints

- Hard cutover, no fallback: after this ships, any published flow with an `xTrigger` node whose `data.channelId === ""` stops matching entirely until manually re-saved with a real channel. No migration script.
- `own:get-posts` stays poll-only — do not add `flowType: "trigger"` to it or wire it into `engine.ts` matching.
- `WaitForEventInspector`'s "Conditions" header is explicitly out of scope — do not rename it.
- YouTube stays single-account per tenant in this plan — its new Account dropdown is `disabled` with exactly one pre-selected option, not a real multi-select.
- No frontend component test infrastructure exists in this repo (`flow/frontend` has zero `.test.tsx` files) — frontend-only steps are verified via `npm run deploy:dev` + a Chrome browser walkthrough, not automated tests.
- `metadata/youtube.ts` already has `label: {"en": "Subscription Videos", "zh": "订阅的视频"}` on its one entry — added by the user before this plan; do not re-add or change it.

---

### Task 1: Enforce `channelId` matching for `xTrigger`

**Files:**
- Modify: `flow/src/engine.ts:165-176` (trigger-matching filter in `executeFlow`)
- Modify: `flow/src/index.ts:1091-1093` (`queue()` handler, `userId` branch)
- Modify: `flow/tests/unit/engine.test.ts:59-69` (existing test that must reflect the new behavior)
- Modify: `flow/tests/unit/emit-node-logs.test.ts:7` (existing fixture whose node/message `channelId` values would otherwise mismatch)
- Test: `flow/tests/unit/engine.test.ts` (new cases)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `executeFlow`'s `xTrigger` match clause now requires `n.data.channelId === payload.channel_id`; `queue()`'s `userId` branch now calls `executeFlow(graph, eventType, matchPayload)` where `matchPayload = { ...payload, channel_id: channelId }` — later tasks rely on this being true so the Inspector's mandatory Account selection actually takes effect.

- [ ] **Step 1: Update the existing xTrigger test to use a real, matching channelId**

In `flow/tests/unit/engine.test.ts`, replace the test at lines 59-69:

```ts
  it("still matches xTrigger nodes unaffected by the new xContentTrigger clause", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", {});
    expect(result.matched).toBe(true);
  });
```

with:

```ts
  it("still matches xTrigger nodes unaffected by the new xContentTrigger clause", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", { channel_id: "chan1" });
    expect(result.matched).toBe(true);
  });

  it("does not match an xTrigger node when channelId differs from the event's channel_id", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", { channel_id: "chan-other" });
    expect(result.matched).toBe(false);
  });
```

**Step 1 note:** this test currently sits inside `describe("executeFlow: xContentTrigger", ...)` — leave it there (don't move it to a new describe block); it's testing that the xContentTrigger-specific clause doesn't wrongly affect xTrigger nodes, and the new test follows the same intent.

- [ ] **Step 2: Run the tests to verify they fail (channelId not yet enforced)**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts -t "xTrigger"`
Expected: the new "does not match" test FAILS (`result.matched` is `true`, not `false`) — `engine.ts` doesn't check `channelId` for `xTrigger` yet.

- [ ] **Step 3: Add the channelId check to engine.ts**

In `flow/src/engine.ts`, replace the trigger filter (around line 165-176):

```ts
  const triggerNodes = graph.nodes.filter(
    (n) => (n.type === "xTrigger" && (n.data.eventType === eventType || n.data.triggerType === eventType))
      || (n.type === "cronTrigger" && eventType === "cron.trigger")
      || (n.type === "xContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && (n.data.mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
              ? n.data.listId === payload.list_id
              : payload.list_id === undefined || payload.list_id === null))
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && n.data.subscriptionChannelId === payload.subscription_channel_id)
  );
```

with:

```ts
  const triggerNodes = graph.nodes.filter(
    (n) => (n.type === "xTrigger" && (n.data.eventType === eventType || n.data.triggerType === eventType)
            && n.data.channelId === payload.channel_id)
      || (n.type === "cronTrigger" && eventType === "cron.trigger")
      || (n.type === "xContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && (n.data.mode === CONTENT_X_TRIGGER_MODE_LIST_POSTS
              ? n.data.listId === payload.list_id
              : payload.list_id === undefined || payload.list_id === null))
      || (n.type === "youtubeContentTrigger" && eventType === "content.created"
          && n.data.channelId === payload.channel_id
          && n.data.subscriptionChannelId === payload.subscription_channel_id)
  );
```

- [ ] **Step 4: Update the emit-node-logs.test.ts fixture to a matching channelId**

In `flow/tests/unit/emit-node-logs.test.ts`, the node's `channelId: ""` (line 7) no longer matches the queue message's `channelId: "chan-1"` (line 53) once `queue()` merges it into the match payload. Change line 7 from:

```ts
    { id: "t1", type: "xTrigger", data: { channelType: "X", eventType: "follow.followed", channelId: "", conditions: [] }, position: { x: 0, y: 0 } },
```

to:

```ts
    { id: "t1", type: "xTrigger", data: { channelType: "X", eventType: "follow.followed", channelId: "chan-1", conditions: [] }, position: { x: 0, y: 0 } },
```

- [ ] **Step 5: Merge channel_id into the match payload in index.ts**

In `flow/src/index.ts`, inside `async queue(...)`, the `userId` branch currently reads (around line 1091-1093):

```ts
        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, payload);
```

Change to:

```ts
        const matchPayload = { ...payload, channel_id: channelId };
        for (const flow of rows.results) {
          const graph: FlowGraph = JSON.parse(flow.graph_json);
          const result = executeFlow(graph, eventType, matchPayload);
```

Do not change any other use of `payload` in this branch (the `flow_pending`/`executeActions` calls further down keep using the original unmodified `payload` — only what's passed to `executeFlow` changes, matching how the `contentId` branch already separates match-time payload from stored/acted-on payload).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts tests/unit/emit-node-logs.test.ts`
Expected: all PASS, including the two xTrigger tests from Step 1.

- [ ] **Step 7: Run the full flow test suite to check for regressions**

Run: `cd flow && npx vitest run`
Expected: same pass count as before this task, plus the 1 new test (no new failures). If any other pre-existing test fails, check via `git stash` + rerun whether it fails on `main` too before treating it as a regression from this task.

- [ ] **Step 8: Commit**

```bash
cd flow && git add src/engine.ts src/index.ts tests/unit/engine.test.ts tests/unit/emit-node-logs.test.ts
git commit -m "fix: enforce channelId matching for xTrigger nodes at runtime"
```

---

### Task 2: `ConditionsEditor` gets a `label` prop

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:80-105` (`ConditionsEditor` function signature and header)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ConditionsEditor` now accepts an optional `label?: string` prop (defaults to `"Conditions"`) — Tasks 3, 5, 6 pass `"Event Props"` or `"Content Props"`.

- [ ] **Step 1: Add the `label` prop**

In `flow/frontend/components/Inspector.tsx`, change the `ConditionsEditor` function signature (currently):

```ts
function ConditionsEditor({
  conditions,
  fields,
  onChange,
}: {
  conditions: Condition[];
  fields: TriggerFieldDefinition[];
  onChange: (conditions: Condition[]) => void;
}) {
```

to:

```ts
function ConditionsEditor({
  conditions,
  fields,
  onChange,
  label = "Conditions",
}: {
  conditions: Condition[];
  fields: TriggerFieldDefinition[];
  onChange: (conditions: Condition[]) => void;
  label?: string;
}) {
```

And change the header line (currently `<Label className="text-xs">Conditions</Label>`) to:

```tsx
        <Label className="text-xs">{label}</Label>
```

- [ ] **Step 2: Verify no callers break (frontend has no test infra for this)**

Run: `cd flow && npx tsc --noEmit`
Expected: no new type errors — every existing `<ConditionsEditor conditions={...} fields={...} onChange={...} />` call omits `label`, which is fine since it's optional and defaults to `"Conditions"` (matching today's behavior exactly for `WaitForEventInspector` and anywhere else not yet updated by Tasks 3/5/6).

- [ ] **Step 3: Commit**

```bash
cd flow && git add frontend/components/Inspector.tsx
git commit -m "refactor: add optional label prop to ConditionsEditor"
```

---

### Task 3: `XTriggerInspector` — mandatory Account, "Event Props" label

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:157-232` (`XTriggerInspector`)

**Interfaces:**
- Consumes: Task 2's `ConditionsEditor` `label` prop; `api.channels.listCached` (already exists in `flow/frontend/lib/api.ts`, used unchanged).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Replace the Account dropdown and add the auto-select safety net**

The current `XTriggerInspector` (`flow/frontend/components/Inspector.tsx:157-232`) reads:

```tsx
function XTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  const channelType = data.channelType as string;
  const eventType = data.eventType as string;
  const channelId = data.channelId as string;
  const conditions: Condition[] = data.conditions || [];

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  useEffect(() => {
    if (!eventType) return;
    setLoadingChannels(true);
    api.channels.list(channelType)
      .then(setChannels)
      .catch(() => setChannels([]))
      .finally(() => setLoadingChannels(false));
  }, [eventType, channelType]);

  if (!ctDef) return <p className="text-sm text-muted-foreground">Unknown channel type</p>;

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{ctDef.label} Trigger</h4>

      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Event</Label>
          <Select
            value={eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "", conditions: [] })}
            className="w-full text-sm"
          >
            <option value="">Select event...</option>
            {ctDef.events.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>

        {eventType && (
          <div>
            <Label className="text-xs block mb-1">Account</Label>
            {loadingChannels ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
            ) : channels.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No accounts linked</p>
            ) : (
              <Select
                value={channelId || ""}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="">All accounts</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>@{ch.username}</option>
                ))}
              </Select>
            )}
          </div>
        )}

        {evDef && evDef.contextFields.length > 0 && (
          <ConditionsEditor
            conditions={conditions}
            fields={evDef.contextFields}
            onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          />
        )}
      </div>
    </div>
  );
}
```

Replace it with:

```tsx
function XTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);

  const channelType = data.channelType as string;
  const eventType = data.eventType as string;
  const channelId = data.channelId as string;
  const conditions: Condition[] = data.conditions || [];

  const ctDef = CHANNEL_TYPES.find((ct) => ct.channelType === channelType);
  const evDef = ctDef?.events.find((e) => e.eventType === eventType);

  useEffect(() => {
    if (!eventType) return;
    setLoadingChannels(true);
    api.channels.listCached(channelType)
      .then((chs) => {
        setChannels(chs);
        // Safety net: auto-select the only connected account, same pattern XActionInspector uses.
        if (chs.length === 1 && !channelId) {
          updateNodeData(nodeId, { channelId: chs[0].id });
        }
      })
      .catch(() => setChannels([]))
      .finally(() => setLoadingChannels(false));
  }, [eventType, channelType]);

  if (!ctDef) return <p className="text-sm text-muted-foreground">Unknown channel type</p>;

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{ctDef.label} Trigger</h4>

      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Event</Label>
          <Select
            value={eventType || ""}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { eventType: e.target.value, channelId: "", conditions: [] })}
            className="w-full text-sm"
          >
            <option value="">Select event...</option>
            {ctDef.events.map((ev) => (
              <option key={ev.eventType} value={ev.eventType}>{ev.label}</option>
            ))}
          </Select>
        </div>

        {eventType && (
          <div>
            <Label className="text-xs block mb-1">Account</Label>
            {loadingChannels ? (
              <p className="text-xs text-muted-foreground">Loading...</p>
            ) : channels.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No accounts linked</p>
            ) : (
              <Select
                value={channelId || ""}
                onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
                className="w-full text-sm"
              >
                <option value="">Select account...</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>@{ch.username}</option>
                ))}
              </Select>
            )}
          </div>
        )}

        {evDef && evDef.contextFields.length > 0 && (
          <ConditionsEditor
            conditions={conditions}
            fields={evDef.contextFields}
            onChange={(c) => updateNodeData(nodeId, { conditions: c })}
            label="Event Props"
          />
        )}
      </div>
    </div>
  );
}
```

The only changes: `api.channels.list` → `api.channels.listCached` plus the auto-select safety net inside the existing `useEffect`; `"All accounts"` → `"Select account..."`; `label="Event Props"` added to `ConditionsEditor`.

- [ ] **Step 2: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd flow && git add frontend/components/Inspector.tsx
git commit -m "feat: xTrigger Account is mandatory single-channel, auto-selects when only one exists"
```

---

### Task 4: Add `email` to the `/youtube/subscriptions` response

**Files:**
- Modify: `link/src/routes-channels.ts:245-261` (`GET /youtube/subscriptions`)
- Modify: `flow/frontend/lib/api.ts:90-93` (`youtubeSubscriptions()` return type)
- Test: `link/tests/routes-channels-youtube-account.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /youtube/subscriptions` (and its `flow` module proxy, unchanged pass-through) now includes `email: string | undefined` in its JSON response. Task 6 reads this to label the new Account dropdown.

- [ ] **Step 1: Write the failing test**

In `link/tests/routes-channels-youtube-account.test.ts`, add inside the existing `describe("GET /api/channels/youtube/subscriptions", ...)` block (after the last `it(...)`, before its closing `});`):

```ts
  it("includes the connected account's email alongside its subscriptions", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "acct1",
            config: JSON.stringify({ email: "creator@example.com", subscriptions: [{ channelId: "UC1", channelName: "One", thumbnailUrl: "" }] }),
          }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/youtube/subscriptions", {}, env);
    const body = await res.json() as any;

    expect(body.email).toBe("creator@example.com");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts -t "includes the connected account's email"`
Expected: FAIL — `body.email` is `undefined`, route doesn't return it yet.

- [ ] **Step 3: Add `email` to the route response**

In `link/src/routes-channels.ts`, the `GET /youtube/subscriptions` handler (lines 245-261) currently reads:

```ts
  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string }>();
    if (!accountRow) return c.json({ connected: false, accountChannelId: null, subscriptions: [] });

    const config = JSON.parse(accountRow.config) as {
      subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
    };
    return c.json({
      connected: true,
      accountChannelId: accountRow.id,
      subscriptions: config.subscriptions || [],
    });
  });
```

Change to:

```ts
  router.get("/youtube/subscriptions", async (c) => {
    const tenantId = c.get("tenantId" as never) as number;
    const accountRow = await c.env.LINK_DB
      .prepare("SELECT id, config FROM channels WHERE channel_type = 'YOUTUBE_ACCOUNT' AND tenant_id = ? AND is_active = 1")
      .bind(tenantId)
      .first<{ id: string; config: string }>();
    if (!accountRow) return c.json({ connected: false, accountChannelId: null, subscriptions: [] });

    const config = JSON.parse(accountRow.config) as {
      email?: string;
      subscriptions?: { channelId: string; channelName: string; thumbnailUrl: string }[];
    };
    return c.json({
      connected: true,
      accountChannelId: accountRow.id,
      email: config.email,
      subscriptions: config.subscriptions || [],
    });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd link && npx vitest run tests/routes-channels-youtube-account.test.ts`
Expected: all PASS. Note the existing test "returns the account's id and its cached subscriptions, with no already_watching field" (line 57) uses `toEqual` with an exact object and a config fixture that has no `email` key — `config.email` will be `undefined`, and `c.json({..., email: undefined, ...})` serializes to JSON with the `email` key omitted entirely (Hono's `c.json` uses `JSON.stringify`, which drops `undefined`-valued keys), so that existing exact-match test still passes unchanged.

- [ ] **Step 5: Update the flow module's TypeScript return type**

In `flow/frontend/lib/api.ts`, change (lines 90-93):

```ts
    youtubeSubscriptions: () =>
      request<{ connected: boolean; accountChannelId: string | null; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>(
        `/api/channels/youtube/subscriptions`
      ),
```

to:

```ts
    youtubeSubscriptions: () =>
      request<{ connected: boolean; accountChannelId: string | null; email?: string; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>(
        `/api/channels/youtube/subscriptions`
      ),
```

- [ ] **Step 6: Commit**

```bash
cd link && git add src/routes-channels.ts tests/routes-channels-youtube-account.test.ts
git commit -m "feat: include connected account's email in /youtube/subscriptions response"
cd ../flow && git add frontend/lib/api.ts
git commit -m "chore: add email to youtubeSubscriptions() return type"
```

---

### Task 5: `XContentTriggerInspector` — Event dropdown, Account auto-select, "Content Props"

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:235-313` (`XContentTriggerInspector`)

**Interfaces:**
- Consumes: Task 2's `ConditionsEditor` `label` prop; `CONTENT_X_TRIGGER_MODE_LIST_POSTS` (already imported from `nodeTypeRegistry` at the top of `Inspector.tsx`); `api.channels.listCached`.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add the Event dropdown and Account auto-select**

The current `XContentTriggerInspector` (`flow/frontend/components/Inspector.tsx:235-313`) reads:

```tsx
function XContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const channelId = data.channelId as string;
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);

  useEffect(() => {
    api.channels.list("X").then(setChannels).catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (!channelId) { setLists([]); return; }
    setLoadingLists(true);
    api.channels.xLists(channelId)
      .then((res) => setLists(res.lists || []))
      .catch(() => setLists([]))
      .finally(() => setLoadingLists(false));
  }, [channelId]);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.xContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Account</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No X accounts linked</p>
          ) : (
            <Select
              value={channelId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value, mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "" })}
              className="w-full text-sm"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>@{ch.username}</option>
              ))}
            </Select>
          )}
        </div>

        <div>
          <Label className="text-xs block mb-1">List</Label>
          {!channelId ? (
            <p className="text-xs text-muted-foreground italic">Select an account first</p>
          ) : loadingLists ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : lists.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No owned Lists found on this account</p>
          ) : (
            <Select
              value={data.listId || ""}
              onChange={(e: SelectChange) => {
                const list = lists.find((l) => l.id === e.target.value);
                updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
              }}
              className="w-full text-sm"
            >
              <option value="">Select list...</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when a new post appears in this X List (from any account).</p>

        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_X, data.mode || CONTENT_X_TRIGGER_MODE_LIST_POSTS)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
      </div>
    </div>
  );
}
```

Replace it with:

```tsx
function XContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const channelId = data.channelId as string;
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);

  useEffect(() => {
    api.channels.listCached("X")
      .then((chs) => {
        setChannels(chs);
        // Safety net: auto-select the only connected account, same pattern XActionInspector uses.
        if (chs.length === 1 && !channelId) {
          updateNodeData(nodeId, { channelId: chs[0].id, mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "" });
        }
      })
      .catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (!channelId) { setLists([]); return; }
    setLoadingLists(true);
    api.channels.xLists(channelId)
      .then((res) => setLists(res.lists || []))
      .catch(() => setLists([]))
      .finally(() => setLoadingLists(false));
  }, [channelId]);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.xContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Event</Label>
          <Select value={CONTENT_X_TRIGGER_MODE_LIST_POSTS} disabled className="w-full text-sm">
            <option value={CONTENT_X_TRIGGER_MODE_LIST_POSTS}>List Posts</option>
          </Select>
        </div>

        <div>
          <Label className="text-xs block mb-1">Account</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No X accounts linked</p>
          ) : (
            <Select
              value={channelId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value, mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "" })}
              className="w-full text-sm"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>@{ch.username}</option>
              ))}
            </Select>
          )}
        </div>

        <div>
          <Label className="text-xs block mb-1">List</Label>
          {!channelId ? (
            <p className="text-xs text-muted-foreground italic">Select an account first</p>
          ) : loadingLists ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : lists.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No owned Lists found on this account</p>
          ) : (
            <Select
              value={data.listId || ""}
              onChange={(e: SelectChange) => {
                const list = lists.find((l) => l.id === e.target.value);
                updateNodeData(nodeId, { listId: e.target.value, listName: list?.name || "" });
              }}
              className="w-full text-sm"
            >
              <option value="">Select list...</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when a new post appears in this X List (from any account).</p>

        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_X, data.mode || CONTENT_X_TRIGGER_MODE_LIST_POSTS)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          label="Content Props"
        />
      </div>
    </div>
  );
}
```

Changes: new disabled Event `<Select>` above Account; `api.channels.list` → `api.channels.listCached` plus the auto-select safety net; `label="Content Props"` added to `ConditionsEditor`. The List dropdown and its "select an account first" gating are untouched — it already reads `channelId` reactively, so it naturally benefits from the new auto-select.

- [ ] **Step 2: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd flow && git add frontend/components/Inspector.tsx
git commit -m "feat: xContentTrigger gets an Event dropdown and Account auto-select"
```

---

### Task 6: `YouTubeContentTriggerInspector` — Event + Account dropdowns, "Content Props"

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx:315-374` (`YouTubeContentTriggerInspector`)

**Interfaces:**
- Consumes: Task 2's `ConditionsEditor` `label` prop; Task 4's `email` field on `api.channels.youtubeSubscriptions()`'s response; `ContentMetadata_YouTube` (already imported at the top of `Inspector.tsx`).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Add the Event and Account dropdowns**

The current `YouTubeContentTriggerInspector` (`flow/frontend/components/Inspector.tsx:315-374`) reads:

```tsx
function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const subscriptionChannelId = data.subscriptionChannelId as string;
  const [state, setState] = useState<{ connected: boolean; accountChannelId: string | null; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>({
    connected: false, accountChannelId: null, subscriptions: [],
  });

  useEffect(() => {
    api.channels.youtubeSubscriptions()
      .then(setState)
      .catch(() => setState({ connected: false, accountChannelId: null, subscriptions: [] }));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Subscription</Label>
          {!state.connected ? (
            <p className="text-xs text-muted-foreground italic">
              Connect your YouTube account from the Social page to pick a subscription.
            </p>
          ) : state.subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No subscriptions found — check your YouTube account has subscriptions.
            </p>
          ) : (
            <Select
              value={subscriptionChannelId || ""}
              onChange={(e: SelectChange) => {
                const sub = state.subscriptions.find((s) => s.channelId === e.target.value);
                updateNodeData(nodeId, {
                  channelId: state.accountChannelId || "",
                  subscriptionChannelId: e.target.value,
                  subscriptionChannelName: sub?.channelName || "",
                });
              }}
              className="w-full text-sm"
            >
              <option value="">Select subscription...</option>
              {state.subscriptions.map((sub) => (
                <option key={sub.channelId} value={sub.channelId}>{sub.channelName}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when this subscription publishes a new video.</p>

        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
        />
      </div>
    </div>
  );
}
```

Replace it with:

```tsx
const YOUTUBE_TRIGGER_META = ContentMetadata_YouTube.find((m) => m.sourceContentType === "watch:get-videos")!;

function YouTubeContentTriggerInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const conditions: Condition[] = data.conditions || [];
  const subscriptionChannelId = data.subscriptionChannelId as string;
  const [state, setState] = useState<{ connected: boolean; accountChannelId: string | null; email?: string; subscriptions: { channelId: string; channelName: string; thumbnailUrl: string }[] }>({
    connected: false, accountChannelId: null, subscriptions: [],
  });

  useEffect(() => {
    api.channels.youtubeSubscriptions()
      .then(setState)
      .catch(() => setState({ connected: false, accountChannelId: null, subscriptions: [] }));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{NODE_TYPE_REGISTRY.youtubeContentTrigger.label}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Event</Label>
          <Select value={YOUTUBE_TRIGGER_META.sourceContentType} disabled className="w-full text-sm">
            <option value={YOUTUBE_TRIGGER_META.sourceContentType}>{localizeLabel(YOUTUBE_TRIGGER_META.label!, "en")}</option>
          </Select>
        </div>

        {state.connected && (
          <div>
            <Label className="text-xs block mb-1">Account</Label>
            <Select value={state.accountChannelId || ""} disabled className="w-full text-sm">
              <option value={state.accountChannelId || ""}>{state.email || "Connected account"}</option>
            </Select>
          </div>
        )}

        <div>
          <Label className="text-xs block mb-1">Subscription</Label>
          {!state.connected ? (
            <p className="text-xs text-muted-foreground italic">
              Connect your YouTube account from the Social page to pick a subscription.
            </p>
          ) : state.subscriptions.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              No subscriptions found — check your YouTube account has subscriptions.
            </p>
          ) : (
            <Select
              value={subscriptionChannelId || ""}
              onChange={(e: SelectChange) => {
                const sub = state.subscriptions.find((s) => s.channelId === e.target.value);
                updateNodeData(nodeId, {
                  channelId: state.accountChannelId || "",
                  subscriptionChannelId: e.target.value,
                  subscriptionChannelName: sub?.channelName || "",
                });
              }}
              className="w-full text-sm"
            >
              <option value="">Select subscription...</option>
              {state.subscriptions.map((sub) => (
                <option key={sub.channelId} value={sub.channelId}>{sub.channelName}</option>
              ))}
            </Select>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Fires when this subscription publishes a new video.</p>

        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_YouTube, "watch:get-videos")}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          label="Content Props"
        />
      </div>
    </div>
  );
}
```

Changes: new module-level `YOUTUBE_TRIGGER_META` constant; new disabled Event `<Select>` (single option from the metadata's `label`); new disabled Account `<Select>` (single option showing `state.email`, only rendered once `state.connected`); `email?: string` added to the local state type; `label="Content Props"` added to `ConditionsEditor`. The Subscription dropdown and its gating logic are untouched.

- [ ] **Step 2: Type-check**

Run: `cd flow && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd flow && git add frontend/components/Inspector.tsx
git commit -m "feat: youtubeContentTrigger gets Event and Account dropdowns"
```

---

## Final manual verification (not a subagent task — done by the controller after all tasks complete)

Per this project's CLAUDE.md UI rule, since there is no frontend test infra for these components:

1. `cd flow && npm run deploy:dev` and `cd link && npm run deploy:dev` (only if Task 4 touched `link`).
2. In a browser against real dev data, open a flow and check each of the three Inspectors:
   - `xTrigger`: with 0 accounts (message shown, no crash), 1 account (auto-selected, no "All accounts" option visible), 2+ accounts (must pick explicitly, no "All accounts" option visible). Conditions header reads "Event Props".
   - `xContentTrigger`: Event shows disabled "List Posts"; Account auto-selects when there's exactly one X channel; List gating unchanged. Conditions header reads "Content Props".
   - `youtubeContentTrigger`: Event shows disabled "Subscription Videos"; Account shows the connected account's email, disabled; Subscription gating unchanged. Conditions header reads "Content Props".
3. Confirm `WaitForEventInspector`'s header still reads "Conditions" (unchanged).
4. Trigger a real follow/unfollow event (or inspect via `flow-dev`'s execution logs) against a published `xTrigger` flow with a real `channelId` set, to confirm Task 1's engine enforcement doesn't silently break the common case.

## Self-review notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-19-trigger-inspector-ui-unification-design.md` maps to a task — engine enforcement (Task 1), `ConditionsEditor` label (Task 2), xTrigger Account (Task 3), YouTube email backend field (Task 4), xContentTrigger Event/Account (Task 5), YouTube Event/Account (Task 6).
- **Placeholder scan:** none found — every step has concrete before/after code.
- **Type consistency:** `label?: string` on `ConditionsEditor` (Task 2) is the exact prop name/type consumed by Tasks 3/5/6; `email?: string` added to both the backend response (Task 4) and the two frontend consumers (`api.ts`'s type in Task 4, `YouTubeContentTriggerInspector`'s local state type in Task 6) consistently.
