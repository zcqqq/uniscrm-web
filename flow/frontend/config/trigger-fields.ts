import { EventMetadata_X, PROPS, t } from "../../../metadata";
import type { Locale } from "../../../metadata";
import type { ContentMetadata } from "../../../metadata/dataTypes";

export interface TriggerFieldDefinition {
  id: string;
  label: string;
  dataType: "number" | "string" | "enum";
  operators: string[];
  enums?: { value: string; label: string }[];
  group: "event" | "user" | "content";
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
  /** flowType:"action" entries for this channel — mirrors `events`, which is flowType:"trigger". */
  actions: EventDefinition[];
}

const NUMBER_OPS = [">", "<", ">=", "<=", "=="];
const STRING_OPS = ["==", "!=", "contains"];
const ENUM_OPS = ["==", "!="];

function propToField(propId: string, locale: Locale, group: "event" | "user" | "content"): TriggerFieldDefinition | null {
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

  const xActions = EventMetadata_X
    .filter((m) => m.flowType === "action")
    .map((m) => ({
      eventType: m.eventType,
      label: t(m.label, locale),
      description: m.description ? t(m.description, locale) : "",
      contextFields: [
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
      actions: xActions,
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

/**
 * Fields offered by a content trigger's condition editor, scoped to the trigger's own
 * `sourceContentType` (e.g. own:get-posts vs get-list-posts vs watch:get-videos) via the
 * given platform's ContentMetadata array's per-mode `contentProps` — rather than a generic
 * entity:"content" filter across all platforms, which previously leaked TikTok-only fields
 * (duration, width, height, ...) into X triggers.
 *
 * Generalized (was `(mode, locale)` scoped to ContentMetadata_X only) so non-X content
 * triggers (e.g. youtubeContentTrigger) can reuse it against their own ContentMetadata array.
 */
export function getContentTriggerFields(
  metadata: ContentMetadata[],
  sourceContentType: string,
  locale: Locale = "en"
): TriggerFieldDefinition[] {
  const meta = metadata.find((m) => m.sourceContentType === sourceContentType);
  if (!meta) return [];
  return meta.contentProps
    .map((p) => propToField(p.propId, locale, "content"))
    .filter(Boolean) as TriggerFieldDefinition[];
}
