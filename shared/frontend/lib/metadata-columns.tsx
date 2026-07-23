import React, { type ReactNode } from "react";
import type { Column } from "../components/DataTable";
import { DateCell } from "../components/CellDate";
import type { PropDefinition } from "../../../metadata/dataTypes";
import { t, type Locale } from "../../../metadata/locale";

// Generates one Column per prop tagged with the given entity, in the props
// array's declaration order. Label, sort default, and cell rendering are all
// derived from the metadata definition (fieldType/dataType/enums) so pages
// don't hand-duplicate that logic. Callers can override individual columns
// afterward (e.g. to restore custom interactive rendering) by mapping over
// the returned array.
export function buildEntityColumns<T extends Record<string, unknown>>(
  props: readonly PropDefinition[],
  entity: "user" | "content",
  locale: Locale,
  timezone: string
): Column<T>[] {
  return props
    .filter((p) => p.entity?.includes(entity) && p.isList !== false)
    .map((p) => {
      // Only INT/DATETIME columns are sortable — TEXT/ENUM comparison order isn't
      // well-defined (alphabetical enum order, free-text collation) and R2 SQL-backed
      // pages have no server-side sort to fall back on, so we don't advertise it.
      const sortType = p.dataType === "INT" ? ("number" as const)
        : p.dataType === "DATETIME" ? ("date" as const)
        : undefined;
      return {
        key: p.propId,
        label: t(p.label, locale),
        sortable: sortType !== undefined,
        sortType,
        render: (row: T): ReactNode => {
          const value = row[p.propId];
          if (value === null || value === undefined || value === "") return "—";

          if (p.fieldType === "IMAGE") {
            return (
              <img
                src={String(value)}
                alt=""
                className="w-8 h-8 rounded-full object-cover"
              />
            );
          }
          if (p.dataType === "DATETIME") {
            return <DateCell iso={String(value)} timezone={timezone} />;
          }
          if (p.dataType === "ENUM_INT" || p.dataType === "ENUM_TEXT") {
            const enumDef = p.enums?.find((e) => String(e.value) === String(value));
            return enumDef ? t(enumDef.label, locale) : String(value);
          }
          if (p.dataType === "INT") {
            return Number(value).toLocaleString();
          }
          return String(value);
        },
      };
    });
}
