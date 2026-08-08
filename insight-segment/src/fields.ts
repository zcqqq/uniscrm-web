import { PROPS, EventMetadata_X, t } from "../../metadata";
import type { PropDefinition, Locale } from "../../metadata";
import { userColumnFor } from "../../metadata/columns";

export type Operator = "=" | "!=" | ">" | "<" | ">=" | "<=" | "IN" | "BETWEEN";

export interface Condition {
  field: string;
  operator: Operator;
  value: string | number | string[] | [string, string];
  timeRelative?: string;
}

export interface ParsedConditions {
  logic: "AND" | "OR";
  conditions: Condition[];
}

export interface InsightField {
  propId: string;
  dataType: PropDefinition["dataType"];
  source: "user" | "event";
  sqlExpr: string;
  description: string;
  enums?: { value: string | number; label: string }[];
}

// 分段条件向用户开放哪些 user 字段是**产品选择**（这份 propId 清单），但每个字段的
// 列名与"它确实是 uniscrm.user 的真实列"由 metadata/columns.ts 的 userColumnFor 保证 ——
// 写进一个不存在的 propId 会在模块加载期抛错，而不是生成引用幽灵列的 SQL。
const SEGMENT_USER_PROP_IDS = [
  "name", "username", "followers_count", "following_count",
  "verified_type", "is_follow", "is_followed",
] as const;

// 分段字段对应的物理列（按上面清单的顺序）。Exported for sql-builder.ts's dedup
// projection — the QUALIFY subquery must SELECT every column a condition can reference.
export const SEGMENT_USER_COLUMNS: string[] = SEGMENT_USER_PROP_IDS.map((id) => userColumnFor(id));

// R2 的 uniscrm.user 把这些做成了真实列,不再需要从 raw_data 里 json_extract。
// "u" is the alias buildSegmentQuery gives the deduped-latest-row subquery over uniscrm.user —
// every entry here must stay in sync with that alias, not with the raw table name.
const SQL_EXPR_MAP: Record<string, { source: "user" | "event"; sqlExpr: string }> =
  Object.fromEntries(
    SEGMENT_USER_PROP_IDS.map((id) => [id, { source: "user" as const, sqlExpr: `u.${userColumnFor(id)}` }])
  );

export function getAllFields(locale: Locale = "en"): InsightField[] {
  const propFields = PROPS.map((prop) => {
    const mapping = SQL_EXPR_MAP[prop.propId];
    if (!mapping) return null;
    return {
      propId: prop.propId,
      dataType: prop.dataType,
      source: mapping.source,
      sqlExpr: mapping.sqlExpr,
      description: t(prop.label, locale),
      enums: prop.enums?.map((e) => ({ value: e.value, label: t(e.label, locale) })),
    };
  }).filter(Boolean) as InsightField[];

  const eventTypeField: InsightField = {
    propId: "event_type",
    dataType: "ENUM",
    source: "event",
    // "e" is the alias buildSegmentQuery gives the LEFT JOIN uniscrm.event — matches the "u"
    // convention above, kept in its own field since event rows are never deduped (each is a
    // discrete occurrence, not an entity with a "current state" — see buildSegmentQuery).
    sqlExpr: "e.event_type",
    description: locale === "zh" ? "事件类型" : "Event Type",
    enums: EventMetadata_X.map((m) => ({ value: m.eventType, label: t(m.label, locale) })),
  };

  const eventTimeField: InsightField = {
    propId: "event_time",
    dataType: "DATETIME",
    source: "event",
    sqlExpr: "e.event_time",
    description: locale === "zh" ? "事件时间" : "Event Time",
  };

  return [...propFields, eventTypeField, eventTimeField];
}

export function generateFieldsPrompt(fields: InsightField[]): string {
  return fields
    .map((f) => {
      let desc = `- ${f.propId} (${f.dataType}): ${f.description}`;
      if (f.enums) {
        desc += ` [${f.enums.map((e) => `${e.value}=${e.label}`).join(", ")}]`;
      }
      return desc;
    })
    .join("\n");
}
