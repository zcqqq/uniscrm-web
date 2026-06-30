# Frontend Full Componentization Design

## Context

The UniSCRM frontend across 6 modules (web, link, flow, analytics, profile, insight-segment) uses Tailwind CSS v4 with a shared theme system. A partial component library exists in `shared/frontend/ui/` (Button, Card, Input, Badge, Select, Separator, Label) using CVA + `cn()` pattern.

**Problem**: Many modules bypass shared components, writing raw Tailwind class strings directly (e.g., `className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md"` instead of `<Button size="sm">`). This causes:
- Inconsistent styling across modules (link uses blue-600, web uses primary)
- No dark mode support in hardcoded colors
- Duplicated patterns (tables, forms, dialogs) in every module
- Missing common UI primitives (Dialog, Tabs, Tooltip, Dropdown, Toast)

**Solution**: Install full shadcn/ui component library via CLI, then refactor all modules to use shared components exclusively. No raw Tailwind class strings for standard UI elements.

## Architecture

### shadcn/ui CLI Setup

Configure at repo root with output to `shared/frontend/ui/`:

```json
// shared/frontend/components.json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "../../web/tailwind.config.ts",
    "css": "./index.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": ".",
    "utils": "./lib/utils",
    "ui": "./ui"
  }
}
```

### Components to Install

**Primitives (from shadcn):**
- Layout: table, tabs, separator, card, accordion, collapsible, scroll-area
- Forms: input, select, checkbox, switch, radio-group, textarea, form, label, slider
- Feedback: dialog, alert-dialog, toast, tooltip, popover, dropdown-menu, sheet
- Display: badge, avatar, skeleton, progress, alert
- Navigation: breadcrumb, pagination
- Actions: button, toggle, toggle-group

**Existing replacements**: Our hand-written Button, Card, Input, Badge, Select, Separator, Label will be replaced by shadcn versions (identical pattern, better accessibility attributes).

### Component Hierarchy

```
shared/frontend/
├── ui/                    <- shadcn primitives (CLI-managed)
│   ├── button.tsx
│   ├── card.tsx
│   ├── table.tsx
│   ├── dialog.tsx
│   ├── tabs.tsx
│   ├── toast.tsx
│   ├── toaster.tsx
│   ├── use-toast.ts
│   └── ... (full set, ~25 components)
├── components/            <- business components (hand-written on top of ui/)
│   ├── CellStatus.tsx     <- uses Badge from ui/
│   ├── CellDate.tsx       <- format-time util
│   ├── CellOperation.tsx  <- DropdownMenu + Button from ui/
│   ├── BarAiGenerate.tsx  <- Button + Input from ui/
│   ├── EmptyState.tsx     <- NEW: standardized empty state pattern
│   ├── ConfirmDialog.tsx  <- NEW: wraps AlertDialog for destructive actions
│   ├── PageHeader.tsx     <- NEW: title + description + actions layout
│   └── FormField.tsx      <- NEW: label + input + error message pattern
├── lib/
│   ├── utils.ts           <- cn() utility (stays)
│   └── format-time.ts    <- timezone formatting (stays)
├── Sidebar.tsx
├── Nav.tsx
├── urls.ts
├── theme.ts
└── index.css              <- Tailwind theme variables
```

### New Business Components

**EmptyState**: Used when a list/table has no data.
```tsx
<EmptyState
  icon={<InboxIcon />}
  title="No channels yet"
  description="Connect your first social account to get started."
  action={<Button onClick={...}>Connect Channel</Button>}
/>
```

**ConfirmDialog**: Wraps AlertDialog for delete/destructive confirmations.
```tsx
<ConfirmDialog
  open={showDelete}
  onConfirm={handleDelete}
  title="Delete flow?"
  description="This action cannot be undone."
  confirmLabel="Delete"
  variant="destructive"
/>
```

**PageHeader**: Consistent page title layout across modules.
```tsx
<PageHeader
  title="Channels"
  description="Manage your connected social accounts"
  actions={<Button>Add Channel</Button>}
/>
```

**FormField**: Label + input + validation error grouping.
```tsx
<FormField label="Email" error={errors.email}>
  <Input value={email} onChange={...} />
</FormField>
```

## Dependencies

**New packages** (added to root package.json):
- `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`
- `@radix-ui/react-tabs`
- `@radix-ui/react-tooltip`
- `@radix-ui/react-switch`
- `@radix-ui/react-checkbox`
- `@radix-ui/react-radio-group`
- `@radix-ui/react-accordion`
- `@radix-ui/react-alert-dialog`
- `@radix-ui/react-avatar`
- `@radix-ui/react-popover`
- `@radix-ui/react-scroll-area`
- `@radix-ui/react-slider`
- `@radix-ui/react-toggle`
- `@radix-ui/react-toggle-group`
- `@radix-ui/react-toast`
- `@radix-ui/react-slot`
- `@radix-ui/react-collapsible`
- `lucide-react` (icon library, replaces hand-drawn SVGs in icons.tsx)

**Existing deps stay**: `tailwind-merge`, `class-variance-authority`, `clsx`, `tailwindcss`, `@tailwindcss/vite`

## Module Refactor Plan

### Refactor Rules

1. **No raw button styling** -> use `<Button variant="..." size="...">`
2. **No raw table HTML** -> use `<Table><TableHeader><TableRow><TableHead>...`
3. **No hardcoded color classes** (bg-blue-600, text-green-500) -> use semantic tokens (bg-primary, text-destructive) or Badge variants
4. **No repeated form layout** -> use FormField component
5. **No custom modal markup** -> use Dialog/AlertDialog
6. **No inline conditional badge colors** -> use Badge with variant prop or CellStatus

### Per-Module Scope

**link** (High priority, ~8 files):
- `ProductTable.tsx`: raw table + badges -> Table + Badge components
- `LinkAdd.tsx`: raw inputs + buttons -> Input, Button, FormField
- `ChannelList.tsx`: raw table + status badges -> Table + CellStatus
- `ContentList.tsx`: raw table -> Table compound component
- `CommerceList.tsx`: raw table -> Table compound component
- All page containers: standardize with PageHeader

**analytics** (~5 files):
- `AnalyticsList.tsx`: raw table + badges + buttons -> Table, Badge, Button
- `AnalyticsDetail.tsx`: tabs (if present) -> Tabs component
- Empty states -> EmptyState component
- Filter dropdowns -> Select/DropdownMenu

**flow** (~6 files):
- `FlowList.tsx`: raw table -> Table
- `FlowEdit.tsx`: form fields -> FormField, dialogs -> Dialog
- Status actions -> DropdownMenu + ConfirmDialog for delete
- AI generation bar: already using shared BarAiGenerate

**web** (~4 files):
- `Home.tsx`: raw table -> Table, raw select -> Select
- `Settings.tsx`: mostly componentized, add Tabs for sections
- `Billing.tsx`: plan cards already use Card
- `Login.tsx`: minimal changes needed

**profile** (~2 files):
- Page layout standardization with PageHeader
- Form fields with FormField

**insight-segment** (~3 files):
- `SegmentCreate.tsx`: form -> FormField components
- `SegmentList.tsx`: table -> Table component
- Condition builder: specialized, may keep custom

### Toaster Setup

Each module's root App.tsx adds `<Toaster />` from shadcn toast. Usage:
```tsx
import { useToast } from "../../shared/frontend/ui/use-toast";
const { toast } = useToast();
toast({ title: "Saved", description: "Settings updated." });
```

## Verification

1. **Setup verification**: After shadcn install, `npm run dev` in web module -> all existing pages render correctly
2. **Component replacement**: After replacing existing ui/ files with shadcn versions -> visual check Login, Settings, Billing, Home
3. **Dark mode**: Toggle theme -> all new components respect `.dark` CSS variables
4. **Per-module refactor**: Start each module's dev server, navigate all pages, verify no broken layouts
5. **Cross-module**: Click sidebar links between modules, verify consistent styling
6. **Responsive**: Check mobile view (sidebar collapse, table scroll)
7. **Accessibility**: Tab through forms, check focus rings, verify dialog trap focus
