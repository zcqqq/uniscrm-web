# contentPropsFilter: System-Level Content Trigger Filtering

## Context

Content triggers currently fire for every new piece of content on a channel. There is no system-level (non-user-editable) gate — the first concrete need is to only process YouTube videos with `duration <= 120` seconds, so that downstream video-processing actions never receive long videos.

The user domain already has this mechanism: `EventMetadata.userPropsFilter` (`metadata/dataTypes.ts`), enforced in `flow/src/index.ts` before executing an action ("action满足条件时才调用外部API"). This design adds the symmetric twin for the content domain — declared in metadata, not in `flow/nodeTypeRegistry.ts`, because:

- The limit is per source content type (`watch:get-videos`), which is exactly `ContentMetadata`'s row granularity. `nodeTypeRegistry` keys on node types (one node type can map to multiple metadata entries, as X triggers already do).
- `nodeTypeRegistry.ts` is editor/LLM-prompt-layer config (labels, sidebar, promptFragment); the runtime engine barely depends on it. `/metadata/` definitions are the project's declared cross-module configuration home.

## Decisions (confirmed 2026-07-24)

- **Filter shape:** new `PropFilter` type with an operator — `userPropsFilter` migrates to it too (it was equality-only via `PropMapping`).
- **Analytics semantics:** a filtered-out video is treated as a non-match — no node log, no `entered` count. Flow-list "No. triggered" is not inflated by long videos.
- **Scope:** declared only on YouTube `watch:get-videos`, threshold `duration <= 120` seconds. X/TikTok entries get no filter now (mechanism is generic; declarations can be added any time).
- **Enforcement point:** link side, before enqueueing `content.created` — saves queue messages and flow-worker invocations, and matches link's existing "metadata whitelist to reduce server load" principle.

## 1. Types (`metadata/dataTypes.ts`)

```ts
export interface PropFilter {
  propId: string;
  operator: "==" | "!=" | "<=" | "<" | ">=" | ">";
  value: string | number;
}
```

- `ContentMetadata` gains `contentPropsFilter?: PropFilter[]` — all filters must pass for the trigger event to be emitted; comment mirrors `userPropsFilter`'s.
- `EventMetadata.userPropsFilter` changes type from `PropMapping[]` to `PropFilter[]`.
- The two existing `userPropsFilter` declarations in `metadata/x.ts` (`is_follow` on Follow/Unfollow) each gain `operator: "=="`.

## 2. Shared evaluator (`metadata/props-filter.ts`, new file)

Pure function, no DOM/Workers dependencies, shared by link and flow:

```ts
export function passesPropsFilter(
  filters: PropFilter[] | undefined,
  props: Record<string, unknown>
): boolean;
```

Semantics:

- `undefined` or empty `filters` → passes.
- All filters must pass (AND).
- `==` / `!=`: strict `===` / `!==` on the raw values — preserves current `userPropsFilter` behavior exactly (`is_follow` is number 0/1 in both D1 rows and metadata).
- `<=` / `<` / `>=` / `>`: both sides through `Number()`; if either side is `NaN` (including a missing prop, `Number(undefined)` = NaN), the filter does **not** pass (fail-closed).
- **Amendment (2026-07-24, task-1 review finding):** `null` and `""` must also fail ordering operators — `Number(null)` and `Number("")` coerce to `0`, not `NaN`, which would silently pass a `<= 120` check for a null-valued prop (D1 rows surface missing fields as `null`). The evaluator guards `actual === null || actual === ""` before the `Number()` coercion.

## 3. Declaration (`metadata/youtube.ts`)

`watch:get-videos` gains:

```ts
contentPropsFilter: [
  { propId: "duration", operator: "<=", value: 120 },
],
```

`duration` is computed in seconds at ingestion (`link/src/services/pollers/youtube-content.ts`, `parseISO8601Duration`), so the value is present in `props` at the enforcement point.

## 4. link-side enforcement (`link/src/services/pollers/youtube-content.ts`)

In `ingestYouTubeVideo`, order is deliberate:

1. `recordTriggerContentSeen` stays **first** — a long video is still marked seen, so subsequent polls never re-fetch its details (protects YouTube API quota) and never re-evaluate it.
2. If `isNew` and `passesPropsFilter(YOUTUBE_METADATA.contentPropsFilter, props)` → `emitContentTriggerEvent` as today.
3. If `isNew` and the filter fails → do **not** enqueue; log one console line:
   `{ event: "youtube_content_skipped_filter", account_channel_id, subscription_channel_id, video_id, duration }`.

No D1/R2 behavior changes — the YouTube trigger path already writes no content row.

## 5. flow-side migration (`flow/src/index.ts:319-331`)

The inline `meta.userPropsFilter.every(f => row?.[f.propId] === f.value)` check is replaced by `passesPropsFilter(meta.userPropsFilter, row ?? {})`. Behavior is unchanged (the existing declarations are `==` filters). The `flow_action_skipped_filter` log line stays as-is.

## Out of scope

- Inspector UI hint showing the system limit ("≤120s") on the YouTube trigger node.
- `contentPropsFilter` declarations on X/TikTok entries (would need missing-`duration` semantics for image-only posts — the fail-closed rule would block them, which is not decided).
- Flow-engine-side enforcement (`executeFlow`); the filter never reaches the flow worker by design.

## Testing

- **Unit tests for `passesPropsFilter`** — every operator, missing prop fail-closed on ordering operators, non-numeric value fail-closed, empty/undefined filter passes, AND across multiple filters. Located with the enforcement consumer's suite (`link/tests/unit/`), since metadata has no test runner of its own.
- **YouTube poller filter path** — `duration <= 120` emits the trigger event; `duration > 120` records seen but does not emit, and logs `youtube_content_skipped_filter`.
- **flow regression** — existing `userPropsFilter` tests (Follow/Unfollow gating) pass unchanged after the migration.
