# `isList` Prop Flag — Design

**Goal:** Let a `PropDefinition` opt out of being shown as a column in the User/Content list tables, without affecting its use elsewhere (e.g. analytics dimensions).

**Architecture:** A new optional `isList?: boolean` field on `PropDefinition` (`metadata/dataTypes.ts`). Absent or `true` = shown (default); explicit `false` = hidden. Enforced at a single choke point — `buildEntityColumns()` in `shared/frontend/lib/metadata-columns.tsx` — which both `link/frontend/pages/Users.tsx` and `link/frontend/components/ContentTable.tsx` already call to turn `metadata/props.ts`'s `PROPS` array into `DataTable` columns.

**Tech Stack:** TypeScript, existing `PropDefinition`/`buildEntityColumns`/`DataTable` metadata-driven column pattern (same pattern already used for INT/DATETIME front-end sortability).

## Global Constraints

- `isList` default is `true` when the field is omitted — every existing `PROPS` entry must keep working with zero edits.
- `isList` is orthogonal to `isInsight`: the analytics `ReportConfig.tsx` dimension/measure picker (filters on `isInsight` + `entity`) must NOT be changed to respect `isList`. A prop can be `isList: false` (hidden from list table) yet still `isInsight: true` (usable as an analytics dimension), and vice versa.
- No changes to `Users.tsx`, `ContentTable.tsx`, or `DataTable.tsx` — they consume whatever `Column<T>[]` comes out of `buildEntityColumns`; the filter lives only inside that function.

---

## Data Model

`metadata/dataTypes.ts`'s `PropDefinition` interface gains one field:

```ts
export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  fieldType?: PropFieldType;
  isInsight?: boolean;
  isList?: boolean; // default true when omitted; false hides this prop's column
                     // from the User/Content list tables (buildEntityColumns).
                     // Orthogonal to isInsight (analytics dimension/measure picker).
  entity?: Array<"user" | "content">;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}
```

## Enforcement

`shared/frontend/lib/metadata-columns.tsx`'s `buildEntityColumns()` filter changes from:

```ts
return props
  .filter((p) => p.entity?.includes(entity))
```

to:

```ts
return props
  .filter((p) => p.entity?.includes(entity) && p.isList !== false)
```

`p.isList !== false` treats `undefined` (field omitted) and `true` identically as "show" — only an explicit `false` excludes the prop. This is the only code change needed; both `Users.tsx` and `ContentTable.tsx` inherit the behavior automatically since they both call `buildEntityColumns`.

## Initial Data — mark internal-linkage props

In `metadata/props.ts`, set `isList: false` on the three propIds whose sole purpose is internal record linkage, never end-user display:

- `user_id` (used to associate content/commerce records back to the User table)
- `source_user_id`
- `source_content_id`

Note: none of these three currently have an `entity` array set, so they are *already* excluded from both list tables by the existing `entity` filter — this change has no visible effect today. It is added defensively/for documentation: if an `entity` tag is ever added to one of these props later (e.g. because some other consumer needs it filterable by entity), the column still won't leak into the list table by accident.

## Testing

Extend `analytics/tests/unit/metadata-columns.test.ts` (already covers the INT/DATETIME-sortable behavior of `buildEntityColumns`) with two new cases:

1. A prop with `entity` matching the requested entity and `isList: false` is excluded from `buildEntityColumns`'s output.
2. A prop with `entity` matching and `isList` omitted (or `true`) still appears — confirms the default-true behavior isn't broken by the new filter clause.

No changes needed to `analytics/tests/unit/metadata-entity.test.ts` (the `ReportConfig.tsx` `isInsight`-based filter test) — it must keep passing unmodified, proving `isList` doesn't leak into that picker.
