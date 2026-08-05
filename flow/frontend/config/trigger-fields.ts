import { EventMetadata_X, PROPS, t, USER_PROP_PREFIX } from "../../../metadata";
import type { Locale } from "../../../metadata";
import type { ContentMetadata } from "../../../metadata/dataTypes";
import { XIcon } from "../../../shared/frontend/ui/icons";

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
  icon: React.ComponentType<{ className?: string }>;
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
      icon: XIcon,
      events: xEvents,
      actions: xActions,
    },
  ];
}

// i18n-ok: intentionally frozen to English — this is NOT a UI-display constant. Its one
// remaining consumer is flow/nodeTypeRegistry.ts (outside flow/frontend, out of this task's
// scope), which reads CHANNEL_TYPES at module-load time (not inside a component, no locale
// available) to compose LLM prompt fragments (X_TRIGGER_EVENT_LIST, X_ACTION_EVENT_LIST) that
// are sent to the AI-generate endpoint — those must stay English regardless of the user's
// locale, same as every other promptFragment in that registry. A "module-level array used for
// static shape" per the i18n-full-coverage plan's own escape hatch.
// Every UI-facing consumer inside flow/frontend (XTriggerNode, WaitForEventNode) has been
// switched to call getChannelTypes(locale) directly instead of importing this constant.
// Two consumers outside this task's file scope — Inspector.tsx (ctDef/evDef labels,
// CHANNEL_TYPES.flatMap for the waitForEvent event <select>) and Sidebar.tsx (xTrigger's
// dynamic per-channel label) — still import this frozen constant and therefore still render
// X event/action names in English regardless of locale; both were already flagged in Task 8's
// report as a follow-up and are out of Task 9's file scope (already translated in Tasks 7-8,
// "do not re-translate"). Left as a known gap — see task-9-report.md.
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
 *
 * userProps（可选，只有声明了的内容源才有）以 group:"user" 追加在内容字段之后，id 为
 * USER_PROP_PREFIX 限定名——见 metadata/dataTypes.ts 的 USER_PROP_PREFIX 注释。
 */
export function getContentTriggerFields(
  metadata: ContentMetadata[],
  sourceContentType: string,
  locale: Locale = "en"
): TriggerFieldDefinition[] {
  const meta = metadata.find((m) => m.sourceContentType === sourceContentType);
  if (!meta) return [];
  const content = meta.contentProps
    .map((p) => propToField(p.propId, locale, "content"))
    .filter(Boolean) as TriggerFieldDefinition[];
  // 作者字段的 id 是**限定名** USER_PROP_PREFIX + propId，与 payload 里的键逐字相同——
  // ConditionsEditor 把 id 直接存进 cond.field，evaluateCondition 用 payload[field] 取值，
  // 两边必须一致。label 仍是 prop 自己的标签（"Views"/"Likes"），靠 SelectPropsValue 的
  // USER PROPS 分组标题与内容侧的同名项区分。
  // 没声明 userProps 的内容源在这里得到空数组，返回值与改动前逐字相同。
  const author = (meta.userProps || [])
    .map((p) => {
      const field = propToField(p.propId, locale, "user");
      return field ? { ...field, id: USER_PROP_PREFIX + field.id } : null;
    })
    .filter(Boolean) as TriggerFieldDefinition[];
  return [...content, ...author];
}
