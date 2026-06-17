import { PROPS_X, METADATA_X, t } from "../../metadata";
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

const SQL_EXPR_MAP: Record<string, { source: "user" | "event"; sqlExpr: string }> = {
  name: { source: "user", sqlExpr: "user.name" },
  username: { source: "user", sqlExpr: "user.username" },
  followers_count: { source: "user", sqlExpr: "CAST(json_extract(user.raw_data, '$.public_metrics.followers_count') AS INTEGER)" },
  following_count: { source: "user", sqlExpr: "CAST(json_extract(user.raw_data, '$.public_metrics.following_count') AS INTEGER)" },
  verified_type: { source: "user", sqlExpr: "json_extract(user.raw_data, '$.verified_type')" },
};

export function getAllFields(locale: Locale = "en"): InsightField[] {
  const propFields = PROPS_X.map((prop) => {
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
    sqlExpr: "event.event_type",
    description: locale === "zh" ? "事件类型" : "Event Type",
    enums: METADATA_X.map((m) => ({ value: m.eventType, label: t(m.label, locale) })),
  };

  const eventTimeField: InsightField = {
    propId: "event_time",
    dataType: "DATETIME",
    source: "event",
    sqlExpr: "event.event_time",
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
