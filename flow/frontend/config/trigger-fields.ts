export interface TriggerFieldDefinition {
  id: string;
  label: string;
  dataType: "number" | "string" | "boolean";
  operators: string[];
}

export interface TriggerTypeDefinition {
  type: string;
  label: string;
  description: string;
  contextFields: TriggerFieldDefinition[];
}

const NUMBER_OPS = [">", "<", ">=", "<=", "=="];
const STRING_OPS = ["==", "!=", "contains"];
const BOOLEAN_OPS = ["=="];

export const TRIGGER_TYPES: TriggerTypeDefinition[] = [
  {
    type: "xFollow",
    label: "X Follow",
    description: "Triggered when the channel follows someone on X",
    contextFields: [
      { id: "target.username", label: "Target Username", dataType: "string", operators: STRING_OPS },
      { id: "target.followers_count", label: "Target Follower Count", dataType: "number", operators: NUMBER_OPS },
      { id: "target.following_count", label: "Target Following Count", dataType: "number", operators: NUMBER_OPS },
      { id: "target.verified", label: "Target Verified", dataType: "boolean", operators: BOOLEAN_OPS },
      { id: "target.bio", label: "Target Bio", dataType: "string", operators: STRING_OPS },
    ],
  },
  {
    type: "xFollowed",
    label: "X Followed",
    description: "Triggered when someone follows the channel on X",
    contextFields: [
      { id: "source.username", label: "Source Username", dataType: "string", operators: STRING_OPS },
      { id: "source.followers_count", label: "Source Follower Count", dataType: "number", operators: NUMBER_OPS },
      { id: "source.following_count", label: "Source Following Count", dataType: "number", operators: NUMBER_OPS },
      { id: "source.verified", label: "Source Verified", dataType: "boolean", operators: BOOLEAN_OPS },
      { id: "source.bio", label: "Source Bio", dataType: "string", operators: STRING_OPS },
    ],
  },
];

export function getTriggerType(type: string): TriggerTypeDefinition | undefined {
  return TRIGGER_TYPES.find((t) => t.type === type);
}
