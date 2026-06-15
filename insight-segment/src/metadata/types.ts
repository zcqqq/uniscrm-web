export type FieldDataType = "INT" | "TEXT" | "ENUM" | "DATETIME";

export interface FieldDefinition {
  propId: string;
  dataType: FieldDataType;
  source: "user_x" | "event_x";
  sqlExpr: string;
  description: string;
  enums?: { value: string; label: string }[];
}

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
