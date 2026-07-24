# System contentPropsFilter: Disabled Display Rows in the Inspector

## Context

`contentPropsFilter` (see `2026-07-24-content-props-filter-design.md`) is enforced link-side before enqueueing — the flow editor never sees it, so users configuring a YouTube content trigger have no way to know the system only fires flows for videos `duration <= 600s`. This change surfaces the rule in the Inspector as visibly locked condition rows.

## Decisions (confirmed 2026-07-24)

- Display-only: system filters do NOT enter `data.conditions`. Runtime enforcement stays link-side against metadata; storing copies in graph JSON would snapshot the threshold (stale after metadata changes) and pollute the user-editable conditions array. User conditions can only further tighten, never loosen, the system limit — enforcement is upstream.
- Rendered as disabled condition-row lookalikes (per user: "在UI上应该是disabled不可编辑删除的状态"), not as a prose hint.

## Design

`ConditionsEditor` (`flow/frontend/components/Inspector.tsx`) gains an optional prop `systemFilters?: PropFilter[]`:

- When present and non-empty, renders one locked row per filter **above** the user conditions: disabled field `Select` (label resolved from `fields` by `propId`, falling back to the raw propId), disabled operator `Select`, disabled value `Input` — same compact row layout and `h-7 text-xs` styling as editable rows, matching the existing disabled Event/Account selects' look.
- No × delete button; in its place a 🔒 icon wrapped in `Tooltip` ("System limit — cannot be edited or removed"), per the project-wide icons-need-tooltips rule. Inspector has no `TooltipProvider` today — the lock icon brings its own local provider.
- The "No filters — all matching events pass." empty-state line shows only when user conditions are empty AND there are no system filters.
- The `fields.length === 0 → return null` guard is unchanged (every metadata entry declaring a filter also declares its prop in `contentProps`, so fields are never empty when filters exist).

Wiring: `YouTubeContentTriggerInspector` passes `YOUTUBE_TRIGGER_META.contentPropsFilter`. No other inspector passes the prop, so nothing else changes. Values are read live from metadata — threshold edits show up without touching the UI, and a future X/TikTok `contentPropsFilter` declaration only needs its inspector to pass the same prop.

## Out of scope

- Canvas node appearance, engine/runtime behavior, `data.conditions` contents.

## Testing

No React component-test infrastructure exists (workerd vitest pool, no DOM) and none is added. Manual verification on the local dev server + flow-dev deploy: YouTube trigger shows the locked `duration <= 600` row (uneditable, undeletable, tooltip on the lock), X content trigger unchanged, user conditions still add/edit/remove normally below the locked row.
