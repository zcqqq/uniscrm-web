import { ContentMetadata_X } from "../metadata/x-byok";
import { CHANNEL_TYPES } from "./frontend/config/trigger-fields";

export type FlowDomain = "user" | "content";

export interface NodeTypeConfig {
  /** The React Flow `node.type` this entry corresponds to ("action" for every actionType variant). */
  reactFlowType: string;
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
    generatable: true,
    promptFragment: `xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: ${X_TRIGGER_EVENT_LIST}`,
  },
  cronTrigger: { reactFlowType: "cronTrigger", label: "Cron Trigger", description: "Trigger on a schedule", domain: "user", generatable: false },
  waitForEvent: {
    reactFlowType: "waitForEvent",
    label: "Wait for Event",
    description: "Check if event has occurred",
    domain: "user",
    generatable: true,
    promptFragment: `waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }`,
  },
  userPropsCondition: { reactFlowType: "userPropsCondition", label: "User Props", description: "Branch by user properties", domain: "user", generatable: false },
  changeUserProps: { reactFlowType: "changeUserProps", label: "Change User Props", description: "Update user properties", domain: "user", generatable: false },
  // Declared before addToList: the user-domain prompt's action item lists X actions first
  // (see buildUserDomainPrompt in generate-prompt.ts, which composes fragments in this order).
  xAction: {
    reactFlowType: "action",
    label: "X Action",
    description: `${X_ACTION_COUNT} actions`,
    domain: "user",
    generatable: true,
    promptFragment: `   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: ${X_ACTION_EVENT_LIST}`,
  },
  addToList: {
    reactFlowType: "action",
    label: "Add to List",
    description: "Add user to a profile list",
    domain: "user",
    generatable: true,
    promptFragment: `   For list actions: data: { actionType: "addToList", listId: "", listName: "" }`,
  },

  // --- content-domain triggers/actions ---
  xContentTrigger: {
    reactFlowType: "xContentTrigger",
    label: "X Trigger",
    description: `${CONTENT_X_TRIGGER_COUNT} triggers`,
    domain: "content",
    generatable: true,
    promptFragment: `xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: ${CONTENT_X_TRIGGER_MODES}, listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "${CONTENT_X_TRIGGER_MODE_LIST_POSTS}": triggers on posts from a specific X List (leave listId/listName blank).`,
  },
  xContentAction: {
    reactFlowType: "action",
    label: "X Action",
    description: `${CONTENT_X_ACTION_COUNT} actions`,
    domain: "content",
    generatable: true,
    // Leading 3-space indent on the first line matches the user-domain action fragments'
    // (xAction/addToList) "   For X actions: ..." sub-variant style — these fragments are
    // concatenated directly under a numbered "action" item by the prompt builder.
    promptFragment: `   For content actions: data: { actionType: "xContentAction", operation: ${CONTENT_X_ACTION_OPERATIONS}, prompt: "", provider: "default" }
   - Every operation acts via the triggering channel's own account — there is no target-account picker.
   - operation "create-bookmark": bookmarks the triggering content — needs no additional fields; leave prompt/provider at these defaults.
   - operation "like-post": likes the triggering content — needs no additional fields; leave prompt/provider at these defaults.
   - operation "repost-post": reposts the triggering content — needs no additional fields; leave prompt/provider at these defaults.
   - operation "create-post": generates and publishes a new post (prompt = free-text instructions for AI generation, left blank for the user to fill in).`,
  },
  tiktokContentAction: {
    reactFlowType: "action",
    label: "TikTok Action",
    description: "Generate images + caption and send to TikTok as a draft",
    domain: "content",
    generatable: true,
    promptFragment: `   For TikTok photo-post actions: data: { actionType: "tiktokContentAction", channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - Generates images and a caption from the triggering content and posts as a TikTok draft. Leave all fields at these defaults for the user to configure via the Inspector.`,
  },
  updateContentStatus: {
    reactFlowType: "action",
    label: "Update Content Status",
    description: "Set this content's status",
    domain: "content",
    generatable: true,
    promptFragment: `   For status-update actions: data: { actionType: "updateContentStatus", status: "" }
   - status must be set by the user afterward via the Inspector to "published" or "ignored" — leave it blank ("") here. No branching.`,
  },

  // --- shared across both domains ---
  wait: {
    reactFlowType: "wait",
    label: "Wait",
    description: "Delay for a specified duration",
    domain: "both",
    generatable: true,
    promptFragment: `wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }`,
  },
  timeCondition: { reactFlowType: "timeCondition", label: "Time Condition", description: "Gate by time-of-day / day-of-week", domain: "both", generatable: false },
  abSplit: { reactFlowType: "abSplit", label: "A/B Split", description: "Split traffic by % or condition", domain: "both", generatable: false },
  webhook: { reactFlowType: "webhook", label: "Webhook", description: "Send HTTP request", domain: "both", generatable: false },
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
  "xTrigger", "cronTrigger", "waitForEvent", "userPropsCondition", "changeUserProps",
  "xAction", "addToList", "wait", "timeCondition", "abSplit", "webhook",
];

export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "xContentAction", "tiktokContentAction", "updateContentStatus",
  "wait", "timeCondition", "abSplit", "webhook",
];
