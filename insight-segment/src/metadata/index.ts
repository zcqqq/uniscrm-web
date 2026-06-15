import type { FieldDefinition } from "./types";
import { TWITTER_FIELDS } from "./twitter";

export type { FieldDefinition, FieldDataType, Operator, Condition, ParsedConditions } from "./types";

const CHANNEL_REGISTRY: Record<string, FieldDefinition[]> = {
  TWITTER: TWITTER_FIELDS,
};

export function getFieldsForChannel(channelType: string): FieldDefinition[] {
  return CHANNEL_REGISTRY[channelType] || [];
}

export function getAllFields(): FieldDefinition[] {
  return Object.values(CHANNEL_REGISTRY).flat();
}

export function generateFieldsPrompt(fields: FieldDefinition[]): string {
  return fields
    .map((f) => {
      let desc = `- ${f.propId} (${f.dataType}): ${f.description}`;
      if (f.enums) {
        desc += ` [可选值: ${f.enums.map((e) => `${e.value}=${e.label}`).join(", ")}]`;
      }
      return desc;
    })
    .join("\n");
}
