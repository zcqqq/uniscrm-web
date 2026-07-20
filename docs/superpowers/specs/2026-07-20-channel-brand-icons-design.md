# Channel Brand Icons Design

**Goal:** Every UI element that represents a specific external channel (X, TikTok, YouTube) shows that channel's real brand mark, everywhere — flow canvas nodes, the flow sidebar's drag palette, the flows list page's node-type badges, and the `link` module's channel-connect cards. Today these are a mix of an ad hoc Unicode glyph (`𝕏`), unrelated emoji (`✨`, `📸`, `▶️`), and a wrong lucide fallback (`FileTextIcon`, `ClockIcon`) — the same root cause (no shared, correct brand-icon source) surfacing in four places independently.

**Not in scope:** non-channel node icons (addToList 📋, webhook 🔗, cron ⏰, changeUserProps ✏️, waitForEvent 🔍, wait ⏳, timeCondition 🕐, userPropsCondition 👤, abSplit ⚡, videoCondition 👁️) are untouched — they don't represent an external channel, so there's no brand mark to be wrong about.

## Current state (facts gathered before designing)

- `link/frontend/lib/channelLogos.tsx` already has correct brand SVGs for `XLogo` and `TikTokLogo` (single-path, `fill="currentColor"`, `viewBox="0 0 24 24"`), used by `link/frontend/lib/channelRegistry.tsx` and `link/frontend/components/SocialChannels.tsx`.
- `shared/frontend/ui/icons.tsx` independently defines a duplicate `XIcon` with the identical path, parametrized via a `className` prop (default `"w-4 h-4"`). It's consumed by `flow/frontend/pages/FlowsPage.tsx` for the flows-list node-type badges. `link` and `flow` are separate Workers/frontends and cannot import each other's files directly, which is why this duplication exists — `shared/frontend/ui/` is this codebase's actual "common to all modules" location (per root `CLAUDE.md`: "shared: 不是模块/worker。包含UI组件等所有模块通用的组件。").
- **No `YouTube` brand icon exists anywhere in the repo.** Every YouTube-representing UI element uses the generic `▶️` play-button emoji instead:
  - `link/frontend/components/SocialChannels.tsx:398` — the YouTube channel-connect card's `logo` prop.
  - `flow/frontend/nodes/YouTubeContentTriggerNode.tsx` and `flow/frontend/components/Sidebar.tsx` (`youtubeContentTrigger` item) — flow canvas/sidebar.
  - `flow/frontend/pages/FlowsPage.tsx`'s `getNodeIcon()` doesn't even special-case `youtubeContentTrigger` — it falls through to the unrelated default `ClockIcon`.
- X-representing nodes (`xTrigger`, `xContentTrigger`, `xAction`, `xContentAction`) use the Unicode character `𝕏` (U+1D54F, mathematical double-struck capital X) directly as text content, not the real `XIcon`/`XLogo` SVG — visually close but not the actual brand mark. Source: `CHANNEL_TYPES[0].icon` in `flow/frontend/config/trigger-fields.ts` (typed `icon: string`), plus hardcoded `"𝕏"` literals in `XContentTriggerNode.tsx`, `ActionNode.tsx`, and `Sidebar.tsx`.
- `tiktokContentAction` uses `📸` (camera emoji) in both `ActionNode.tsx` and `Sidebar.tsx` — no relation to TikTok's brand mark, despite `TikTokLogo` already existing in `link`.
- `xContentAction`'s node label is literally "X Action" (`nodeTypeRegistry.ts:199`) but its icon is `✨` (sparkle) — a leftover from before it was scoped as an X-specific action.
- `FlowsPage.tsx`'s `getNodeIcon()` maps `xContentAction` and `tiktokContentAction` to a generic `FileTextIcon`, and its `action` branch's default case (used by `xAction`, but also unintentionally by `videoAction`, which has no explicit branch) returns `XIcon` — so the unrelated `videoAction` (subtitle-generation, no channel) is currently mislabeled with the X logo in the flows list.
- Root `CLAUDE.md`: "UI：所有icons都要加上tooltip文字便于区分" (all icons must have tooltip text for disambiguation) — already true for `Sidebar.tsx`'s `DraggableItem` (wrapped in `Tooltip`/`TooltipContent`), not yet true for the flow canvas node components (`XTriggerNode`, `XContentTriggerNode`, `YouTubeContentTriggerNode`, `ActionNode`), which render icons as a bare `<span>` next to a text label.

## Changes

### 1. `shared/frontend/ui/icons.tsx` — single source of truth for brand icons

- Keep `XIcon` as-is (already correct, already parametrized).
- Add `TikTokIcon`, moved from `link/frontend/lib/channelLogos.tsx`'s `TikTokLogo`, renamed to match this file's `*Icon` convention and parametrized the same way as `XIcon` (`className` prop, default `"w-4 h-4"`) instead of the hardcoded `w-8 h-8` it has today.
- Add `YouTubeIcon`, new, sourced from the official YouTube brand mark (the rounded-rectangle-plus-play-triangle silhouette; path taken from Simple Icons' YouTube entry, which mirrors YouTube's official brand guideline SVG):

```tsx
export function YouTubeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-label="YouTube">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}
```

Single-color (`fill="currentColor"`), matching `XIcon`/`TikTokIcon`'s style rather than YouTube's two-tone red/white official palette — consistent with how the other two brand marks already render in this app (they inherit the surrounding text color instead of carrying their own fixed brand color).

### 2. `link/frontend/lib/channelLogos.tsx` — remove the now-duplicated logos

- Delete `XLogo` and `TikTokLogo` (and their now-unused imports/exports). Keep `NotionLogo` and `LocalLogo` — they're only consumed within `link`, no cross-module need.
- `link/frontend/lib/channelRegistry.tsx`: `import { TikTokLogo } from "./channelLogos"` → `import { TikTokIcon } from "../../../shared/frontend/ui/icons"`, update the one call site.
- `link/frontend/components/SocialChannels.tsx`:
  - `import { XLogo } from "../lib/channelLogos"` → `import { XIcon } from "../../../shared/frontend/ui/icons"`, update all 3 call sites (`<XLogo/>` → `<XIcon className="w-8 h-8"/>`, preserving the existing 8×8 display size used in this file's cards).
  - `YouTubeAccountCard`'s `logo={<span className="text-2xl leading-none">▶️</span>}` → `logo={<YouTubeIcon className="w-8 h-8"/>}` (new import from `shared`).

### 3. `flow/frontend/config/trigger-fields.ts` — `ChannelTypeDefinition.icon` becomes a component

```ts
export interface ChannelTypeDefinition {
  channelType: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  events: EventDefinition[];
  actions: EventDefinition[];
}
```

`getChannelTypes()`'s X entry: `icon: "𝕏"` → `icon: XIcon` (import from `shared/frontend/ui/icons`).

### 4. Flow canvas nodes — swap glyphs for the shared icons, add tooltips

- `XTriggerNode.tsx`: `<span className="text-lg">{ctDef?.icon || "⚡"}</span>` → render `ctDef.icon` as a component (`const Icon = ctDef?.icon; <Icon className="w-4 h-4"/>` with a fallback when `ctDef` is undefined), wrapped in `Tooltip`/`TooltipContent` showing `ctDef?.label` (e.g. "X").
- `XContentTriggerNode.tsx`: `<span className="text-lg">𝕏</span>` → `<XIcon className="w-4 h-4"/>`, wrapped in `Tooltip` showing "X".
- `YouTubeContentTriggerNode.tsx`: `<span className="text-lg">▶️</span>` → `<YouTubeIcon className="w-4 h-4"/>`, wrapped in `Tooltip` showing "YouTube".
- `ActionNode.tsx`: per-branch icon values change from string literals to component references (`XIcon` for `xAction`/`xContentAction`, `TikTokIcon` for `tiktokContentAction`; `addToList`'s `📋` and `videoAction`'s `🎬` stay as emoji, unrelated to this fix). The render becomes `{typeof icon === "string" ? <span className="text-lg">{icon}</span> : <Icon className="w-4 h-4"/>}` — or, simpler and more consistent with the rest of the plan, every branch normalizes to a component (wrap the two emoji as trivial one-line components, e.g. `const ListIconEmoji = () => <span className="text-lg">📋</span>`) so the render path is uniform. Whichever the implementer finds cleaner given the surrounding code; either way, every icon in this file's render gets wrapped in `Tooltip` showing its `label`.

### 5. `Sidebar.tsx` — widen `DraggableItem`'s `icon` prop, swap the five affected items

`DraggableItemProps.icon` type: `string` → `React.ReactNode`. The existing render (`<span className="text-lg leading-none">{icon}</span>`) already accepts a `ReactNode` child, so plain emoji strings keep working unchanged.

Five call sites switch from string literals to `<Icon className="w-4 h-4"/>` JSX:
- `xTrigger` loop: `icon={ct.icon}` → `icon={<ct.icon className="w-4 h-4"/>}`
- `xContentTrigger`: `icon="𝕏"` → `icon={<XIcon className="w-4 h-4"/>}`
- `xAction`: `icon="𝕏"` → `icon={<XIcon className="w-4 h-4"/>}`
- `xContentAction`: `icon="✨"` → `icon={<XIcon className="w-4 h-4"/>}`
- `tiktokContentAction`: `icon="📸"` → `icon={<TikTokIcon className="w-4 h-4"/>}`
- `youtubeContentTrigger`: `icon="▶️"` → `icon={<YouTubeIcon className="w-4 h-4"/>}`

No tooltip changes needed here — `DraggableItem` already wraps every item in `Tooltip`/`TooltipContent`.

### 6. `FlowsPage.tsx` — fix the node-type badge mapping

```ts
function getNodeIcon(type: string, data: Record<string, unknown>) {
  if (type === "xTrigger") return XIcon;
  if (type === "xContentTrigger") return XIcon;              // was FileTextIcon
  if (type === "youtubeContentTrigger") return YouTubeIcon;  // was missing (fell through to ClockIcon)
  if (type === "waitForEvent") return SearchIcon;
  if (type === "wait") return ClockIcon;
  if (type === "action") {
    const at = data.actionType as string;
    if (at === "addToList") return ListIcon;
    if (at === "xContentAction") return XIcon;                // was FileTextIcon
    if (at === "tiktokContentAction") return TikTokIcon;       // was FileTextIcon
    if (at === "videoAction") return ClapperboardIcon;         // was falling through to XIcon (wrong channel)
    return XIcon;                                              // remaining case: xAction
  }
  return ClockIcon;
}
```

`ClapperboardIcon` imported from `lucide-react` (`Clapperboard as ClapperboardIcon`), matching the 🎬 emoji already used for this node type on the canvas (`ActionNode.tsx`). `TikTokIcon`/`YouTubeIcon` imports added from `shared/frontend/ui/icons`; `XIcon`'s import is unchanged (same file, same export name, now just backed by the same shared definition it already was).

## Self-review

- **Placeholder scan:** none — every change above has concrete before/after code or an exact prop rename.
- **Consistency:** `className` default (`"w-4 h-4"`) and prop name are uniform across `XIcon`/`TikTokIcon`/`YouTubeIcon`; call sites in `link`'s larger cards override to `"w-8 h-8"` explicitly rather than relying on a different default.
- **Scope:** confirmed with the user across 4 rounds — flow canvas nodes, flow sidebar, flows-list badges, and `link`'s YouTube channel card are all in scope; non-channel node icons and YouTube's two-tone official coloring are explicitly out of scope.
