import { ContentMetadata_X } from "../metadata/x-byok";
import { ContentMetadata_TikTok } from "../metadata/tiktok";
import { CHANNEL_TYPES } from "./frontend/config/trigger-fields";

export type FlowDomain = "user" | "content";

export interface NodeTypeConfig {
  /** The React Flow `node.type` this entry corresponds to ("action" for every actionType variant). */
  reactFlowType: string;
  /**
   * Flow-semantics role, independent of `reactFlowType` (a canvas-rendering detail). Drives how
   * generate-prompt.ts composes this entry into the LLM prompt:
   * - "trigger": starts a flow, no target handle. Exactly one trigger-role node must open a
   *   generated graph; multiple trigger-role entries per domain are alternatives (e.g. xTrigger
   *   vs cronTrigger), not a chain.
   * - "action": grouped under one shared numbered "action" item (data.actionType-discriminated,
   *   reactFlowType "action" — same membership reactFlowType already identified, now explicit).
   * - "condition": everything else — gets its own individual numbered prompt item. Catch-all: not
   *   every "condition" entry actually branches (wait/changeUserProps are linear; webhook has its
   *   own reactFlowType and a real side effect, not just a gate, but is grouped here rather than
   *   "action" to avoid implying its JSON shape is data.actionType-discriminated like real actions).
   */
  role: "trigger" | "action" | "condition";
  /**
   * Display name shown in Sidebar, the canvas node, and the Inspector heading — the single
   * source of truth for this type's name so the three surfaces can't drift apart. Omitted only
   * for xTrigger, whose label is dynamic per channelType and sourced from CHANNEL_TYPES instead.
   */
  label?: string;
  /**
   * Sidebar description — the single source of truth for this type's palette tooltip text,
   * same rationale as `label`. Omitted only for xTrigger, whose description is dynamic per
   * channelType and computed in Sidebar.tsx from CHANNEL_TYPES instead.
   */
  description?: string;
  domain: FlowDomain | "both";
  /** Whether the AI generate feature may produce this node type/actionType. */
  generatable: boolean;
  /**
   * LLM-facing documentation fragment, composed by both domains' prompt builders in
   * generate-prompt.ts (buildUserDomainPrompt / buildContentDomainPrompt).
   * Non-action entries: the full item body ("type - description\n   data: {...}\n   - notes").
   * Action-family entries: a "For X actions: ..." sub-bullet (grouped under one numbered
   * "action" item by the prompt builder — order within that item follows this registry's
   * declaration order, so xAction is declared before addToList to match the existing prompt).
   */
  promptFragment?: string;
}

const CONTENT_X_TRIGGER_ENTRIES = ContentMetadata_X.filter((m) => m.flowType === "trigger");
const CONTENT_X_ACTION_ENTRIES = ContentMetadata_X.filter((m) => m.flowType === "action");
const CONTENT_X_TRIGGER_COUNT = CONTENT_X_TRIGGER_ENTRIES.length;
const CONTENT_X_ACTION_COUNT = CONTENT_X_ACTION_ENTRIES.length;
const X_CHANNEL = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!;
const X_ACTION_COUNT = X_CHANNEL.actions.length;
// All three derived at module load from metadata rather than hand-typed, so the generate
// prompt never drifts from the actual set of supported X trigger events / actions / operations.
const X_TRIGGER_EVENT_LIST = X_CHANNEL.events.map((ev) => `"${ev.eventType}" (${ev.description})`).join(", ");
const X_ACTION_EVENT_LIST = X_CHANNEL.actions.map((a) => `"${a.eventType}"`).join(", ");
const CONTENT_X_ACTION_OPERATIONS = CONTENT_X_ACTION_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");
// mode values are ContentMetadata_X's own sourceContentType tokens ("own:get-posts"/"get-list-posts")
// rather than a separately-named enum, so there's nothing to keep in sync by hand.
const CONTENT_X_TRIGGER_MODES = CONTENT_X_TRIGGER_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");

// Per-operation bullet text for xContentAction, derived from ContentMetadata_X rather than
// hand-typed per operation — a new operation added to the metadata automatically gets both its
// enum value (CONTENT_X_ACTION_OPERATIONS above) and its explanatory bullet here, with no
// separate line to remember to add. The "needs no additional fields"/"prompt = free-text..."
// suffix is derived from whether the operation has an aiType prop (same check Inspector.tsx
// uses to decide whether to show the prompt/provider fields at all), not hand-typed either.
const CONTENT_X_ACTION_BULLETS = CONTENT_X_ACTION_ENTRIES.map((m) => {
  // Only TEXT/IMAGE aiType props mean "AI generates this from a prompt" — VIDEO means
  // "optionally attach $content.processed_video_url", never AI-generated, never prompted.
  const hasAiProp = m.contentProps.some((p) => p.aiType === "TEXT" || p.aiType === "IMAGE");
  const guidance = hasAiProp
    ? "prompt = free-text instructions for AI generation, left blank for the user to fill in."
    : "needs no additional fields; leave prompt/provider at these defaults.";
  return `   - operation "${m.sourceContentType}": ${m.description!.en} — ${guidance}`;
}).join("\n");

const CONTENT_TIKTOK_ACTION_ENTRIES = ContentMetadata_TikTok.filter((m) => m.flowType === "action");
const CONTENT_TIKTOK_ACTION_OPERATIONS = CONTENT_TIKTOK_ACTION_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");
const CONTENT_TIKTOK_ACTION_BULLETS = CONTENT_TIKTOK_ACTION_ENTRIES.map((m) => {
  return `   - operation "${m.sourceContentType}": ${m.description!.en}`;
}).join("\n");

// Exported so every consumer of the mode field (Inspector, flow-editor default data, the
// XContentTriggerNode canvas subtitle, templates, and the engine's runtime dispatch) reads the
// same value instead of re-typing ContentMetadata_X's sourceContentType literal itself.
// own:get-posts is poll-only (no flowType: "trigger") — it feeds content ingestion but never
// fires a content flow — so get-list-posts is currently the only content-flow trigger mode.
export const CONTENT_X_TRIGGER_MODE_LIST_POSTS = CONTENT_X_TRIGGER_ENTRIES.find((m) => m.sourceContentType === "get-list-posts")!.sourceContentType;

export const NODE_TYPE_REGISTRY: Record<string, NodeTypeConfig> = {
  // --- user-domain triggers/flow-control/actions ---
  xTrigger: {
    reactFlowType: "xTrigger",
    domain: "user",
    role: "trigger",
    generatable: true,
    promptFragment: `xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: ${X_TRIGGER_EVENT_LIST}`,
  },
  cronTrigger: {
    reactFlowType: "cronTrigger",
    label: "Cron Trigger",
    description: "Trigger on a schedule",
    domain: "user",
    role: "trigger",
    generatable: true,
    promptFragment: `cronTrigger - triggers on a schedule (all times UTC)
   data: { scheduleType: "daily"|"interval"|"cron", dailyTime: "09:00", cronExpr: "", intervalValue: 60, intervalUnit: "minutes"|"hours"|"days" }
   - scheduleType "daily": fires once per day at dailyTime ("HH:mm", UTC).
   - scheduleType "interval": fires every intervalValue intervalUnit (e.g. intervalValue:30, intervalUnit:"minutes" = every 30 minutes).
   - scheduleType "cron": fires per a 5-field cron expression in cronExpr ("minute hour day month weekday").`,
  },
  waitForEvent: {
    reactFlowType: "waitForEvent",
    label: "Wait for Event",
    description: "Check if event has occurred",
    domain: "user",
    role: "condition",
    generatable: true,
    promptFragment: `waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }`,
  },
  userPropsCondition: {
    reactFlowType: "userPropsCondition",
    label: "User Props",
    description: "Branch by user properties",
    domain: "user",
    role: "condition",
    generatable: true,
    promptFragment: `userPropsCondition - branches on the triggering user's profile fields, has "yes"/"no" branches
   data: { conditions: [{ field: string, operator: "=="|"!="|">"|"<", value: string }] }
   - All conditions must pass (AND) for the "yes" branch; otherwise "no".`,
  },
  changeUserProps: {
    reactFlowType: "changeUserProps",
    label: "Change User Props",
    description: "Update user properties",
    domain: "user",
    role: "condition",
    generatable: true,
    promptFragment: `changeUserProps - updates fields on the triggering user's profile, single output (no branching)
   data: { updates: [{ field: string, value: string }] }
   - value supports $user.x / $event.x interpolation from the triggering payload.`,
  },
  // Declared before addToList: the user-domain prompt's action item lists X actions first
  // (see buildUserDomainPrompt in generate-prompt.ts, which composes fragments in this order).
  xAction: {
    reactFlowType: "action",
    label: "X Action",
    description: `${X_ACTION_COUNT} actions`,
    domain: "user",
    role: "action",
    generatable: true,
    promptFragment: `   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: ${X_ACTION_EVENT_LIST}`,
  },
  addToList: {
    reactFlowType: "action",
    label: "Add to List",
    description: "Add user to a profile list",
    domain: "user",
    role: "action",
    generatable: true,
    promptFragment: `   For list actions: data: { actionType: "addToList", listId: "", listName: "" }`,
  },

  // --- content-domain triggers/actions ---
  xContentTrigger: {
    reactFlowType: "xContentTrigger",
    label: "X Trigger",
    description: `${CONTENT_X_TRIGGER_COUNT} triggers`,
    domain: "content",
    role: "trigger",
    generatable: true,
    promptFragment: `xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: ${CONTENT_X_TRIGGER_MODES}, listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "${CONTENT_X_TRIGGER_MODE_LIST_POSTS}": triggers on posts from a specific X List (leave listId/listName blank).`,
  },
  youtubeContentTrigger: {
    reactFlowType: "youtubeContentTrigger",
    label: "YouTube Trigger",
    description: "Watches a subscribed YouTube channel",
    domain: "content",
    role: "trigger",
    generatable: true,
    promptFragment: `youtubeContentTrigger - triggers when a subscribed YouTube channel publishes a new video
   data: { channelId: "", subscriptionChannelId: "", subscriptionChannelName: "", conditions: [] }
   - channelId and subscriptionChannelId are left blank ("") — the user picks a subscription from a dropdown in the Inspector after generation, sourced from their connected YouTube account (OAuth) on the Social page.
   - conditions may filter on "duration" (seconds).`,
  },
  xContentAction: {
    reactFlowType: "action",
    label: "X Action",
    description: `${CONTENT_X_ACTION_COUNT} actions`,
    domain: "content",
    role: "action",
    generatable: true,
    // Leading 3-space indent on the first line matches the user-domain action fragments'
    // (xAction/addToList) "   For X actions: ..." sub-variant style — these fragments are
    // concatenated directly under a numbered "action" item by the prompt builder.
    promptFragment: `   For content actions: data: { actionType: "xContentAction", operation: ${CONTENT_X_ACTION_OPERATIONS}, prompt: "", provider: "default" }
   - Every operation acts via the triggering channel's own account — there is no target-account picker.
${CONTENT_X_ACTION_BULLETS}`,
  },
  tiktokContentAction: {
    reactFlowType: "action",
    label: "TikTok Action",
    description: `${CONTENT_TIKTOK_ACTION_ENTRIES.length} actions`,
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For TikTok content actions: data: { actionType: "tiktokContentAction", operation: ${CONTENT_TIKTOK_ACTION_OPERATIONS}, channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - Leave all fields at these defaults for the user to configure via the Inspector. imageCount/imageProvider/imageSkillId only apply to "photo-post".
${CONTENT_TIKTOK_ACTION_BULLETS}`,
  },
  videoAction: {
    reactFlowType: "action",
    label: "Video Action",
    description: "Add translated subtitles to the content's video",
    domain: "content",
    role: "action",
    generatable: true,
    promptFragment: `   For video actions: data: { actionType: "videoAction", operation: ["add-subtitle"], targetLanguage: "zh" }
   - "add-subtitle": downloads the content's video, transcribes speech, translates it into targetLanguage, burns in subtitles, caches the result in R2. Has "success"/"failed" branches. Never publishes anywhere — produces $content.processed_video_url, $content.video_transcript, $content.translated_subtitle_text for later nodes to use.`,
  },
  videoCondition: {
    reactFlowType: "videoCondition",
    label: "Video Condition",
    description: "Run a model-based check on the content's thumbnail",
    domain: "content",
    role: "condition",
    generatable: true,
    promptFragment: `videoCondition - runs a model-based check on the content's thumbnail, has "has-face"/"no-face"/"failed" branches
   data: { operation: "check-face" }
   - "check-face": detects whether the content's cover image contains a human face. "failed" covers a missing thumbnail or a model error — never guess a result on failure.`,
  },
  // --- shared across both domains ---
  wait: {
    reactFlowType: "wait",
    label: "Wait",
    description: "Delay for a specified duration",
    domain: "both",
    role: "condition",
    generatable: true,
    promptFragment: `wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }`,
  },
  timeCondition: {
    reactFlowType: "timeCondition",
    label: "Time Condition",
    description: "Gate by time-of-day / day-of-week",
    domain: "both",
    role: "condition",
    generatable: true,
    promptFragment: `timeCondition - gates downstream execution to a time-of-day / day-of-week window, single output (no branching)
   data: { timeFrom: "09:00", timeTo: "17:00", daysOfWeek: [1,2,3,4,5] }
   - timeFrom/timeTo are "HH:mm". daysOfWeek is an array of 0(Sun)-6(Sat). Execution continues once inside the window.`,
  },
  abSplit: {
    reactFlowType: "abSplit",
    label: "A/B Split",
    description: "Split traffic by % or condition",
    domain: "both",
    role: "condition",
    generatable: true,
    promptFragment: `abSplit - splits traffic into two branches, has "a"/"b" branches
   data: { mode: "random"|"condition", percentA: 50, conditions: [{ field: string, operator: "==", value: string }] }
   - mode "random": percentA% of traffic takes branch "a", the rest takes "b".
   - mode "condition": a single field=="value" check in conditions[0] decides "a" (match) vs "b" (no match).`,
  },
  webhook: {
    reactFlowType: "webhook",
    label: "Webhook",
    description: "Send HTTP request",
    domain: "both",
    role: "condition",
    generatable: true,
    promptFragment: `webhook - sends an HTTP request, has "success"/"failed" branches
   data: { url: string, method: "GET"|"POST"|"PUT", body: "" }
   - body supports $user.x / $event.x interpolation; if left blank, defaults to a JSON object of the triggering payload.`,
  },
};

export function generatableKeysForDomain(domain: FlowDomain): string[] {
  return Object.entries(NODE_TYPE_REGISTRY)
    .filter(([, cfg]) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both"))
    .map(([key]) => key);
}

// Sidebar item order within each domain — deliberately separate from NODE_TYPE_REGISTRY's own
// declaration order (which only needs to agree with itself for the shared "both" entries, e.g.
// promptFragment composition order) so user-flow and content-flow Sidebars can each be reordered
// independently without touching the other, or the registry's identity data.
export const USER_FLOW_SIDEBAR_ORDER: string[] = [
  "xTrigger", "cronTrigger", "xAction", "addToList", "changeUserProps", "webhook", "waitForEvent", "userPropsCondition",
  "wait", "timeCondition", "abSplit",
];

export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "videoAction", "videoCondition",
  "wait", "timeCondition", "abSplit", "webhook",
];
