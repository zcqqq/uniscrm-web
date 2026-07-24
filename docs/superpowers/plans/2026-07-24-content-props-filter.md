# contentPropsFilter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** System-level content trigger filtering declared in metadata — first use: only YouTube videos with `duration <= 120` seconds fire content flows.

**Architecture:** New `PropFilter` type + pure evaluator in `/metadata/` shared by link and flow. Enforcement is link-side, before enqueueing `content.created` (filtered videos are still dedup-recorded but never reach the flow worker — no `entered` count). Existing `userPropsFilter` migrates to the same type/evaluator with unchanged behavior.

**Tech Stack:** TypeScript, Cloudflare Workers, vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-07-24-content-props-filter-design.md`

## Global Constraints

- `PropFilter` shape verbatim: `{ propId: string; operator: "==" | "!=" | "<=" | "<" | ">=" | ">"; value: string | number }`
- `==`/`!=` compare with strict `===`/`!==` on raw values (preserves current `userPropsFilter` behavior exactly)
- `<=`/`<`/`>=`/`>` compare via `Number()` on both sides; either side `NaN` (incl. missing prop) → filter does NOT pass (fail-closed)
- Empty/undefined filter list passes; multiple filters are AND
- YouTube threshold: `{ propId: "duration", operator: "<=", value: 120 }` on `watch:get-videos` ONLY (no X/TikTok declarations)
- link enforcement order: `recordTriggerContentSeen` FIRST (long videos still marked seen — protects YouTube API quota), filter gates only `emitContentTriggerEvent`
- Skip log event name verbatim: `youtube_content_skipped_filter` with fields `account_channel_id`, `subscription_channel_id`, `video_id`, `duration`
- Do not touch `flow/nodeTypeRegistry.ts` or any Inspector UI
- Work directly on `main`, no worktree, commit locally, do NOT push

---

### Task 1: `PropFilter` type + `passesPropsFilter` evaluator

**Files:**
- Modify: `metadata/dataTypes.ts` (append after the `PropMapping` interface, ~line 50)
- Create: `metadata/props-filter.ts`
- Test: `link/tests/services/props-filter.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `PropFilter` (exported from `metadata/dataTypes.ts`), `passesPropsFilter(filters: PropFilter[] | undefined, props: Record<string, unknown>): boolean` (exported from `metadata/props-filter.ts`) — Tasks 2 and 3 import both

- [ ] **Step 1: Write the failing test**

Create `link/tests/services/props-filter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { passesPropsFilter } from "../../../metadata/props-filter";
import type { PropFilter } from "../../../metadata/dataTypes";

describe("passesPropsFilter", () => {
  it("passes when filters is undefined or empty", () => {
    expect(passesPropsFilter(undefined, { duration: 999 })).toBe(true);
    expect(passesPropsFilter([], { duration: 999 })).toBe(true);
  });

  it("== uses strict equality on raw values (number 0 !== string '0')", () => {
    const f: PropFilter[] = [{ propId: "is_follow", operator: "==", value: 0 }];
    expect(passesPropsFilter(f, { is_follow: 0 })).toBe(true);
    expect(passesPropsFilter(f, { is_follow: "0" })).toBe(false);
    expect(passesPropsFilter(f, { is_follow: 1 })).toBe(false);
    expect(passesPropsFilter(f, {})).toBe(false);
  });

  it("!= uses strict inequality", () => {
    const f: PropFilter[] = [{ propId: "is_follow", operator: "!=", value: 1 }];
    expect(passesPropsFilter(f, { is_follow: 0 })).toBe(true);
    expect(passesPropsFilter(f, { is_follow: 1 })).toBe(false);
  });

  it("<= compares numerically, boundary inclusive", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<=", value: 120 }];
    expect(passesPropsFilter(f, { duration: 119 })).toBe(true);
    expect(passesPropsFilter(f, { duration: 120 })).toBe(true);
    expect(passesPropsFilter(f, { duration: 121 })).toBe(false);
  });

  it("ordering operators coerce numeric strings", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<", value: 120 }];
    expect(passesPropsFilter(f, { duration: "60" })).toBe(true);
    expect(passesPropsFilter(f, { duration: "180" })).toBe(false);
  });

  it("> and >= work", () => {
    expect(passesPropsFilter([{ propId: "n", operator: ">", value: 5 }], { n: 6 })).toBe(true);
    expect(passesPropsFilter([{ propId: "n", operator: ">", value: 5 }], { n: 5 })).toBe(false);
    expect(passesPropsFilter([{ propId: "n", operator: ">=", value: 5 }], { n: 5 })).toBe(true);
  });

  it("ordering operators fail closed on missing prop or non-numeric value", () => {
    const f: PropFilter[] = [{ propId: "duration", operator: "<=", value: 120 }];
    expect(passesPropsFilter(f, {})).toBe(false);
    expect(passesPropsFilter(f, { duration: undefined })).toBe(false);
    expect(passesPropsFilter(f, { duration: "abc" })).toBe(false);
  });

  it("multiple filters are AND", () => {
    const f: PropFilter[] = [
      { propId: "duration", operator: "<=", value: 120 },
      { propId: "content_type", operator: "==", value: "VIDEO" },
    ];
    expect(passesPropsFilter(f, { duration: 60, content_type: "VIDEO" })).toBe(true);
    expect(passesPropsFilter(f, { duration: 60, content_type: "IMAGE" })).toBe(false);
    expect(passesPropsFilter(f, { duration: 200, content_type: "VIDEO" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/props-filter.test.ts`
Expected: FAIL — cannot resolve `../../../metadata/props-filter`

- [ ] **Step 3: Add the type and implementation**

In `metadata/dataTypes.ts`, insert directly after the `PropMapping` interface (after its closing `}` at ~line 50):

```ts
// 系统级过滤条件（非用户可编辑）。用于 EventMetadata.userPropsFilter 和
// ContentMetadata.contentPropsFilter，由 metadata/props-filter.ts 的
// passesPropsFilter 统一评估：==/!= 严格比较原始值；<=/</>=/> 两侧 Number()
// 后比较，任一侧 NaN（含缺字段）视为不通过（fail-closed）。
export interface PropFilter {
  propId: string;
  operator: "==" | "!=" | "<=" | "<" | ">=" | ">";
  value: string | number;
}
```

Create `metadata/props-filter.ts`:

```ts
import type { PropFilter } from "./dataTypes";

// 纯函数，link（内容 trigger 入队前）与 flow（action 执行前）共用。
// 语义见 dataTypes.ts 中 PropFilter 的注释。
export function passesPropsFilter(
  filters: PropFilter[] | undefined,
  props: Record<string, unknown>
): boolean {
  if (!filters?.length) return true;
  return filters.every((f) => {
    const actual = props[f.propId];
    if (f.operator === "==") return actual === f.value;
    if (f.operator === "!=") return actual !== f.value;
    const a = Number(actual);
    const b = Number(f.value);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    switch (f.operator) {
      case "<=": return a <= b;
      case "<": return a < b;
      case ">=": return a >= b;
      case ">": return a > b;
      default: return false;
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/props-filter.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add metadata/dataTypes.ts metadata/props-filter.ts link/tests/services/props-filter.test.ts
git commit -m "feat(metadata): add PropFilter type and shared passesPropsFilter evaluator"
```

---

### Task 2: Migrate `userPropsFilter` to `PropFilter`

**Files:**
- Modify: `metadata/dataTypes.ts:77` (the `userPropsFilter` field on `EventMetadata`)
- Modify: `metadata/x.ts:153-155` and `metadata/x.ts:165-167` (the two `is_follow` declarations)
- Modify: `flow/src/index.ts:319-335` (the inline filter check)

**Interfaces:**
- Consumes: `PropFilter` and `passesPropsFilter` from Task 1
- Produces: `EventMetadata.userPropsFilter?: PropFilter[]` — no downstream consumers besides `flow/src/index.ts` (verified: only `metadata/x.ts`, `metadata/dataTypes.ts`, `flow/src/index.ts` reference `userPropsFilter`)

- [ ] **Step 1: Change the field type**

In `metadata/dataTypes.ts`, the `EventMetadata` interface:

```ts
  userPropsFilter?: PropFilter[]; // action满足条件时才调用外部API（passesPropsFilter评估）
```

(replaces `userPropsFilter?: PropMapping[]; // action满足条件时才调用外部API`)

- [ ] **Step 2: Migrate the two declarations in `metadata/x.ts`**

Follow entry (~line 153):

```ts
    userPropsFilter: [
      { propId: "is_follow", operator: "==", value: 0 },
    ],
```

Unfollow entry (~line 165):

```ts
    userPropsFilter: [
      { propId: "is_follow", operator: "==", value: 1 },
    ],
```

- [ ] **Step 3: Replace the inline check in `flow/src/index.ts`**

Add import at the top of `flow/src/index.ts` (next to the existing `EventMetadata_X` import from the metadata module):

```ts
import { passesPropsFilter } from "../../metadata/props-filter";
```

Replace line 329:

```ts
          const pass = meta.userPropsFilter.every(f => row?.[f.propId] === f.value);
```

with:

```ts
          const pass = passesPropsFilter(meta.userPropsFilter, row ?? {});
```

Everything else in the block (the D1 lookup, the `flow_action_skipped_filter` log, `continue`) stays untouched.

- [ ] **Step 4: Verify compile + full regression on both modules**

Run: `cd flow && npx tsc --noEmit && npm test`
Expected: compile clean, all existing flow tests PASS

Run: `cd link && npm test`
Expected: all link tests PASS (behavior parity of `==` is covered by Task 1's strict-equality tests)

- [ ] **Step 5: Commit**

```bash
git add metadata/dataTypes.ts metadata/x.ts flow/src/index.ts
git commit -m "refactor(flow): migrate userPropsFilter to PropFilter + shared evaluator"
```

---

### Task 3: `contentPropsFilter` declaration + link-side enforcement

**Files:**
- Modify: `metadata/dataTypes.ts` (the `ContentMetadata` interface, ~line 58-66)
- Modify: `metadata/youtube.ts` (the `watch:get-videos` entry)
- Modify: `link/src/services/pollers/youtube-content.ts:41-43` (the `isNew` block)
- Test: `link/tests/services/pollers/youtube-content.test.ts` (append cases)

**Interfaces:**
- Consumes: `PropFilter`, `passesPropsFilter` from Task 1
- Produces: `ContentMetadata.contentPropsFilter?: PropFilter[]` — read only at the link emit site for now

- [ ] **Step 1: Write the failing tests**

Append to the `describe("ingestYouTubeVideo", ...)` block in `link/tests/services/pollers/youtube-content.test.ts`:

```ts
  it("does not emit content.created when duration exceeds 120s, but still records dedup seen", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-long",
      snippet: { title: "Long", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT2M1S" },
    });

    const tenantDb = createMockTenantDb();
    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const logSpy = vi.spyOn(console, "log");
    const ctx = baseCtx({ tenantDb, flowQueue });
    await ingestYouTubeVideo(ctx, "vid-long");

    const dedupCall = tenantDb.run.mock.calls.find((c: unknown[]) => (c[0] as string).includes("content_trigger_dedup"));
    expect(dedupCall).toBeTruthy();
    expect(flowQueue.send).not.toHaveBeenCalled();
    const skipLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("youtube_content_skipped_filter"));
    expect(skipLog).toBeTruthy();
    expect(JSON.parse(skipLog!)).toMatchObject({
      event: "youtube_content_skipped_filter",
      account_channel_id: "chan-acc",
      subscription_channel_id: "chan-sub",
      video_id: "vid-long",
      duration: 121,
    });
  });

  it("emits content.created at exactly 120s (boundary inclusive)", async () => {
    vi.spyOn(youtubeApi, "fetchVideoDetails").mockResolvedValue({
      id: "vid-2m",
      snippet: { title: "Exactly 2m", publishedAt: "2026-07-18T00:00:00Z", thumbnails: { default: { url: "https://img/t.jpg" } } },
      contentDetails: { duration: "PT2M" },
    });

    const flowQueue = { send: vi.fn().mockResolvedValue(undefined) };
    const ctx = baseCtx({ flowQueue });
    await ingestYouTubeVideo(ctx, "vid-2m");

    expect(flowQueue.send).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify the new long-video case fails**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: the `duration exceeds 120s` test FAILS (`flowQueue.send` was called); the boundary test and all existing tests PASS

- [ ] **Step 3: Add the field, the declaration, and the enforcement**

In `metadata/dataTypes.ts`, `ContentMetadata` interface, after `contentProps`:

```ts
  contentPropsFilter?: PropFilter[]; // 全部通过才发content trigger事件（link端入队前评估，被拦内容不计flow entered）
```

In `metadata/youtube.ts`, `watch:get-videos` entry, after the `contentProps` array's closing `],`:

```ts
    // 系统级限制：只有 <=120 秒的视频才触发 content flow（link 端入队前拦截）。
    contentPropsFilter: [
      { propId: "duration", operator: "<=", value: 120 },
    ],
```

In `link/src/services/pollers/youtube-content.ts`, add import:

```ts
import { passesPropsFilter } from "../../../../metadata/props-filter";
```

Replace the `isNew` block (lines 41-43):

```ts
  if (isNew) {
    if (passesPropsFilter(YOUTUBE_METADATA.contentPropsFilter, props)) {
      await contentService.emitContentTriggerEvent(ctx.accountChannelId, "YOUTUBE", "subscriptionChannelId", ctx.subscriptionChannelId, props);
    } else {
      console.log(JSON.stringify({ event: "youtube_content_skipped_filter", account_channel_id: ctx.accountChannelId, subscription_channel_id: ctx.subscriptionChannelId, video_id: videoId, duration: props.duration }));
    }
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd link && npx vitest run tests/services/pollers/youtube-content.test.ts`
Expected: PASS (7 tests: 5 existing + 2 new)

Run: `cd link && npm test`
Expected: full link suite PASS

- [ ] **Step 5: Commit**

```bash
git add metadata/dataTypes.ts metadata/youtube.ts link/src/services/pollers/youtube-content.ts link/tests/services/pollers/youtube-content.test.ts
git commit -m "feat(link): gate YouTube content trigger on contentPropsFilter (duration <= 120s)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 types → Tasks 1+2+3; §2 evaluator → Task 1; §3 declaration → Task 3; §4 link enforcement (dedup-first ordering, log shape) → Task 3; §5 flow migration → Task 2; Testing section → each task's test steps. Out-of-scope items appear in no task. ✓
- **Placeholder scan:** all steps carry complete code/commands. ✓
- **Type consistency:** `passesPropsFilter(filters, props)` signature identical across Tasks 1/2/3; `PropFilter` field names (`propId`/`operator`/`value`) consistent. `PT2M1S` = 121s, `PT2M` = 120s — verified against `parseISO8601Duration` semantics and the existing test's `PT2M → duration: 120` assertion. ✓
- **Ordering:** Task 1 is additive-only (compiles standalone); Task 2's type change lands together with both consumers' migration; Task 3 depends only on Task 1. ✓
