import { PROPS, EventMetadata_X, t } from "../../metadata";
import type { PropDefinition, Locale } from "../../metadata";

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

// R2 的 uniscrm.user 把这些做成了真实列,不再需要从 raw_data 里 json_extract。
// "u" is the alias buildSegmentQuery gives the deduped-latest-row subquery over uniscrm.user —
// every entry here must stay in sync with that alias, not with the raw table name.
const SQL_EXPR_MAP: Record<string, { source: "user" | "event"; sqlExpr: string }> = {
  name: { source: "user", sqlExpr: "u.name" },
  username: { source: "user", sqlExpr: "u.username" },
  followers_count: { source: "user", sqlExpr: "u.followers_count" },
  following_count: { source: "user", sqlExpr: "u.following_count" },
  verified_type: { source: "user", sqlExpr: "u.verified_type" },
  is_follow: { source: "user", sqlExpr: "u.is_follow" },
  is_followed: { source: "user", sqlExpr: "u.is_followed" },
};

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
