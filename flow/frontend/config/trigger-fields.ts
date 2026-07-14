import { EventMetadata_X, PROPS, t } from "../../../metadata";
import type { Locale } from "../../../metadata";

export interface TriggerFieldDefinition {
  id: string;
  label: string;
  dataType: "number" | "string" | "enum";
  operators: string[];
  enums?: { value: string; label: string }[];
  group: "event" | "user";
}

export interface EventDefinition {
  eventType: string;
  label: string;
  description: string;
  contextFields: TriggerFieldDefinition[];
}

export interface ChannelTypeDefinition {
  channelType: string;
  label: string;
  icon: string;
  events: EventDefinition[];
}

const NUMBER_OPS = [">", "<", ">=", "<=", "=="];
const STRING_OPS = ["==", "!=", "contains"];
const ENUM_OPS = ["==", "!="];

function propToField(propId: string, locale: Locale, group: "event" | "user"): TriggerFieldDefinition | null {
  const prop = PROPS.find((p) => p.propId === propId);
  if (!prop) return null;

  if (prop.dataType === "ENUM_INT" || prop.dataType === "ENUM_TEXT") {
    return {
      id: propId,
      label: t(prop.label, locale),
      dataType: "enum",
      operators: ENUM_OPS,
      enums: prop.enums?.map((e) => ({ value: String(e.value), label: t(e.label, locale) })),
      group,
    };
  }

  const dataType = prop.dataType === "INT" ? "number" : "string";
  const operators = dataType === "number" ? NUMBER_OPS : STRING_OPS;
  return { id: propId, label: t(prop.label, locale), dataType, operators, group };
}

export function getChannelTypes(locale: Locale = "en"): ChannelTypeDefinition[] {
  const eventTimeField: TriggerFieldDefinition = {
    id: "event_time",
    label: t({ en: "Event Time", zh: "事件时间" }, locale),
    dataType: "string",
    operators: STRING_OPS,
    group: "event",
  };

  const xEvents = EventMetadata_X
    .filter((m) => m.flowType === "trigger")
    .map((m) => ({
      eventType: m.eventType,
      label: t(m.label, locale),
      description: m.description ? t(m.description, locale) : "",
      contextFields: [
        eventTimeField,
        ...m.eventProps.map((p) => propToField(p.propId, locale, "event")),
        ...m.userProps.map((p) => propToField(p.propId, locale, "user")),
      ].filter(Boolean) as TriggerFieldDefinition[],
    }));

  return [
    {
      channelType: "X",
      label: "X",
      icon: "𝕏",
      events: xEvents,
    },
  ];
}

export const CHANNEL_TYPES: ChannelTypeDefinition[] = getChannelTypes("en");

export function getEventDefinition(eventType: string, locale: Locale = "en"): EventDefinition | undefined {
  for (const ct of getChannelTypes(locale)) {
    const ev = ct.events.find((e) => e.eventType === eventType);
    if (ev) return ev;
  }
  return undefined;
}
