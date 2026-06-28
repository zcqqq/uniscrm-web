import type { InsightField, ParsedConditions, Condition, Operator } from "../fields";

const MAX_CONDITIONS = 10;

const OPERATOR_COMPAT: Record<string, Operator[]> = {
  INT: ["=", "!=", ">", "<", ">=", "<=", "IN", "BETWEEN"],
  TEXT: ["=", "!=", "IN"],
  ENUM: ["=", "!=", "IN"],
  ENUM_TEXT: ["=", "!=", "IN"],
  ENUM_INT: ["=", "!=", "IN"],
  DATETIME: ["=", "!=", ">", "<", ">=", "<=", "BETWEEN"],
};

export interface ValidationResult {
  valid: true;
  conditions: ParsedConditions;
}

export interface ValidationError {
  valid: false;
  errors: string[];
}

export function validateConditions(
  parsed: ParsedConditions,
  fields: InsightField[]
): ValidationResult | ValidationError {
  const errors: string[] = [];

  if (parsed.logic !== "AND" && parsed.logic !== "OR") {
    errors.push(`Invalid logic: "${parsed.logic}", must be AND or OR`);
  }

  if (!Array.isArray(parsed.conditions) || parsed.conditions.length === 0) {
    errors.push("conditions must be a non-empty array");
    return { valid: false, errors };
  }

  if (parsed.conditions.length > MAX_CONDITIONS) {
    errors.push(`Too many conditions (${parsed.conditions.length}), max ${MAX_CONDITIONS}`);
    return { valid: false, errors };
  }

  for (const cond of parsed.conditions) {
    validateCondition(cond, fields, errors);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, conditions: parsed };
}

function validateCondition(cond: Condition, fields: InsightField[], errors: string[]): void {
  const field = fields.find((f) => f.propId === cond.field);
  if (!field) {
    errors.push(`Unknown field: "${cond.field}"`);
    return;
  }

  const allowedOps = OPERATOR_COMPAT[field.dataType];
  if (!allowedOps?.includes(cond.operator)) {
    errors.push(`Operator "${cond.operator}" not allowed for ${field.dataType} field "${cond.field}"`);
    return;
  }

  if (field.dataType === "ENUM" && field.enums) {
    const validValues = field.enums.map((e) => e.value);
    if (cond.operator === "IN") {
      const vals = cond.value as string[];
      if (!Array.isArray(vals)) {
        errors.push(`IN operator requires array value for "${cond.field}"`);
      } else {
        for (const v of vals) {
          if (!validValues.includes(v)) {
            errors.push(`Invalid enum value "${v}" for field "${cond.field}"`);
          }
        }
      }
    } else {
      if (!validValues.includes(cond.value as string)) {
        errors.push(`Invalid enum value "${cond.value}" for field "${cond.field}"`);
      }
    }
  }

  if (field.dataType === "INT") {
    if (cond.operator === "BETWEEN") {
      const pair = cond.value as [string, string];
      if (!Array.isArray(pair) || pair.length !== 2) {
        errors.push(`BETWEEN requires [min, max] for "${cond.field}"`);
      }
    } else if (cond.operator !== "IN") {
      if (typeof cond.value !== "number" && isNaN(Number(cond.value))) {
        errors.push(`INT field "${cond.field}" requires numeric value, got "${cond.value}"`);
      }
    }
  }

  if (field.dataType === "DATETIME" && cond.timeRelative) {
    if (!/^\d+d$/.test(cond.timeRelative)) {
      errors.push(`Invalid timeRelative format "${cond.timeRelative}", expected "<N>d"`);
    }
  }
}
