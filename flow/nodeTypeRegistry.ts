import { ContentMetadata_X } from "../metadata/x-byok";
import { ContentMetadata_TikTok } from "../metadata/tiktok";
import { ContentMetadata_YouTube } from "../metadata/youtube";
import { CHANNEL_TYPES } from "./frontend/config/trigger-fields";
import type { LocalizedString } from "../metadata/dataTypes";

export type FlowDomain = "user" | "content";

/** Sidebar palette section a node type is listed under. Colour derives from the section. */
export type SidebarSection = "triggers" | "actions" | "flowControl";

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
   *   every "condition" entry actually branches (wait/timeCondition are linear; webhook has its
   *   own reactFlowType and a real side effect, not just a gate, but is grouped here rather than
   *   "action" to avoid implying its JSON shape is data.actionType-discriminated like real actions).
   */
  role: "trigger" | "action" | "condition";
  /**
   * Bilingual display name shown in Sidebar, the canvas node, and the Inspector heading — the
   * single source of truth for this type's name so the three surfaces can't drift apart.
   * (Formerly split between this registry's English string and frontend/config/nodeTypeLabels.ts's
   * zh table; merged here. This file sits at flow/ root, outside the i18n audit's frontend scan
   * dirs, and every label/description line carries `en:` — which the audit treats as
   * already-bilingual — so the merge keeps the audit green.)
   * Omitted only for xTrigger, whose label is dynamic per channelType and sourced from
   * CHANNEL_TYPES instead.
   */
  label?: LocalizedString;
  /**
   * Bilingual Sidebar description — the single source of truth for this type's palette tooltip
   * text, same rationale as `label`. Count-based descriptions ("4 actions") compute the number
   * once at module load into both languages — no "{n}" placeholder / regex round-trip anymore.
   * Omitted only for xTrigger, whose description is dynamic per channelType and computed in
   * Sidebar.tsx from CHANNEL_TYPES instead.
   */
  description?: LocalizedString;
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
  /**
   * Fresh default `node.data` for a newly added node of this type (consumed by the editor's
   * addNode — persisted graphs carry their own data). A factory, not a shared object, so two
   * nodes never alias the same conditions array.
   */
  defaultData: () => Record<string, unknown>;
  /**
   * The node's outgoing sourceHandle ids when it branches (["success","failed"], ["yes","no"],
   * ["true","false","failed"], ...). Absent = single unnamed output. The runtime handles stay
   * where they always were (node components / executors); this declaration exists so the
   * generate-prompt Rules block derives its sourceHandle lines instead of hand-typing them —
   * the documentation can no longer drift from the registry.
   */
  branches?: readonly string[];
  /**
   * True for node types whose data.conditions is a props-conditions array edited via the
   * Inspector's ConditionsEditor and evaluated by conditionsPass at runtime. Drives
   * validate-flow-graph.ts's OR-with-zero-conditions publish gate (PROPS_CONDITION_NODE_TYPES).
   * userPropsCondition/abSplit also carry data.conditions but neither use ConditionsEditor nor
   * are engine-evaluated — deliberately not tagged (see validate-flow-graph.ts).
   */
  propsConditions?: boolean;
  /**
   * Trigger-role entries only: true when this trigger fires for one specific connected account
   * and its runtime matcher compares `data.channelId` against the event's `payload.channel_id`
   * (src/node-executors.ts's TRIGGER_MATCHERS). False/absent for cronTrigger, which fires on a
   * schedule and binds no account.
   *
   * Drives the "trigger has no account selected" publish gate on both sides
   * (frontend/lib/validate-flow-graph.ts, src/trigger-health.ts) and the editor's bulk
   * channel auto-fill. An empty `data.channelId` on one of these makes the matcher compare
   * "" against a real channel id — the flow publishes, looks healthy, and never fires once.
   * That is how prod tenant 100001's only published flow sat dead from 2026-07-25 on.
   */
  channelBound?: boolean;
  /**
   * Action-role entries only: true when the action calls a third-party platform API and thus
   * has success/failed branches resolved asynchronously (flow/CLAUDE.md: 2xx→success,
   * 4xx/5xx/timeout→failed). Drives buildActionData's hasBranches — formerly a hand-maintained
   * string list in engine.ts.
   */
  externalApi?: boolean;
  /** Which Sidebar section this type is listed under (colour derives from the section). */
  sidebarSection: SidebarSection;
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

const CONTENT_YOUTUBE_ACTION_ENTRIES = ContentMetadata_YouTube.filter((m) => m.flowType === "action");
const CONTENT_YOUTUBE_ACTION_OPERATIONS = CONTENT_YOUTUBE_ACTION_ENTRIES.map((m) => `"${m.sourceContentType}"`).join("|");
const CONTENT_YOUTUBE_ACTION_BULLETS = CONTENT_YOUTUBE_ACTION_ENTRIES.map((m) => `   - operation "${m.sourceContentType}": ${m.description!.en}`).join("\n");

// Exported so every consumer of the mode field (Inspector, flow-editor default data, the
// XContentTriggerNode canvas subtitle, templates, and the engine's runtime dispatch) reads the
// same value instead of re-typing ContentMetadata_X's sourceContentType literal itself.
// own:get-posts is poll-only (no flowType: "trigger") — it feeds content ingestion but never
// fires a content flow — so get-list-posts is currently the only content-flow trigger mode.
export const CONTENT_X_TRIGGER_MODE_LIST_POSTS = CONTENT_X_TRIGGER_ENTRIES.find((m) => m.sourceContentType === "get-list-posts")!.sourceContentType;

// `as const satisfies` (not a plain Record annotation) so the key set and each entry's literal
// reactFlowType/role survive at the type level: NodeTypeKey / ReactFlowNodeType / TriggerTypeKey /
// ActionTypeKey below derive from them, and the per-side behavior maps (src/node-executors.ts,
// frontend/nodes/index.ts, Inspector.tsx's inspector maps) are typed Record<those keys, …> —
// adding a registry entry without an executor/matcher/component/inspector is a compile error.
const REGISTRY = {
  // --- user-domain triggers/flow-control/actions ---
  xTrigger: {
    reactFlowType: "xTrigger",
    domain: "user",
    role: "trigger",
    channelBound: true,
    generatable: true,
    sidebarSection: "triggers",
    propsConditions: true,
    defaultData: () => ({ channelType: "X", eventType: "", channelId: "" }),
    promptFragment: `xTrigger - triggers on X (Twitter) events
   data: { channelType: "X", eventType: string }
   eventTypes: ${X_TRIGGER_EVENT_LIST}`,
  },
  cronTrigger: {
    reactFlowType: "cronTrigger",
    label: { en: "Cron Trigger", zh: "Cron 触发器" },
    description: { en: "Trigger on a schedule", zh: "按计划定时触发" },
    domain: "user",
    role: "trigger",
    generatable: true,
    sidebarSection: "triggers",
    defaultData: () => ({ scheduleType: "", dailyTime: "09:00", cronExpr: "", intervalValue: 60, intervalUnit: "minutes" }),
    promptFragment: `cronTrigger - triggers on a schedule (all times UTC)
   data: { scheduleType: "daily"|"interval"|"cron", dailyTime: "09:00", cronExpr: "", intervalValue: 60, intervalUnit: "minutes"|"hours"|"days" }
   - scheduleType "daily": fires once per day at dailyTime ("HH:mm", UTC).
   - scheduleType "interval": fires every intervalValue intervalUnit (e.g. intervalValue:30, intervalUnit:"minutes" = every 30 minutes).
   - scheduleType "cron": fires per a 5-field cron expression in cronExpr ("minute hour day month weekday").`,
  },
  waitForEvent: {
    reactFlowType: "waitForEvent",
    label: { en: "Wait for Event", zh: "等待事件" },
    description: { en: "Check if event has occurred", zh: "检查事件是否已发生" },
    domain: "user",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["yes", "no"],
    propsConditions: true,
    defaultData: () => ({ eventType: "", channelId: "", duration: 1, unit: "days", conditions: [] }),
    promptFragment: `waitForEvent - wait for an event within a time window, has "yes"/"no" branches
   data: { eventType: string, duration: number, unit: "minutes"|"hours"|"days", conditions: [] }`,
  },
  userPropsCondition: {
    reactFlowType: "userPropsCondition",
    label: { en: "User Props", zh: "用户属性" },
    description: { en: "Branch by user properties", zh: "按用户属性分支" },
    domain: "user",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["yes", "no"],
    defaultData: () => ({ conditions: [] }),
    promptFragment: `userPropsCondition - branches on the triggering user's profile fields, has "yes"/"no" branches
   data: { conditions: [{ field: string, operator: "=="|"!="|">"|"<", value: string }] }
   - All conditions must pass (AND) for the "yes" branch; otherwise "no".`,
  },
  // Declared before addToList: the user-domain prompt's action item lists X actions first
  // (see buildUserDomainPrompt in generate-prompt.ts, which composes fragments in this order).
  xAction: {
    reactFlowType: "action",
    label: { en: "X Action", zh: "X 动作" },
    description: { en: `${X_ACTION_COUNT} actions`, zh: `${X_ACTION_COUNT} 个动作` },
    domain: "user",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    externalApi: true,
    defaultData: () => ({ actionType: "xAction", xEvent: "", channelId: "" }),
    promptFragment: `   For X actions: data: { actionType: "xAction", xEvent: string }
   xEvents: ${X_ACTION_EVENT_LIST}`,
  },
  addToList: {
    reactFlowType: "action",
    label: { en: "Add to List", zh: "加入名单" },
    description: { en: "Add user to a profile list", zh: "把用户加入画像名单" },
    domain: "user",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    defaultData: () => ({ actionType: "addToList", listId: "", listName: "" }),
    promptFragment: `   For list actions: data: { actionType: "addToList", listId: "", listName: "" }`,
  },

  // --- content-domain triggers/actions ---
  xContentTrigger: {
    reactFlowType: "xContentTrigger",
    label: { en: "X Trigger", zh: "X 触发器" },
    description: { en: `${CONTENT_X_TRIGGER_COUNT} triggers`, zh: `${CONTENT_X_TRIGGER_COUNT} 个触发器` },
    domain: "content",
    role: "trigger",
    channelBound: true,
    generatable: true,
    sidebarSection: "triggers",
    propsConditions: true,
    defaultData: () => ({ channelId: "", mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "", conditions: [] }),
    promptFragment: `xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: ${CONTENT_X_TRIGGER_MODES}, listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "${CONTENT_X_TRIGGER_MODE_LIST_POSTS}": triggers on posts from a specific X List (leave listId/listName blank).`,
  },
  youtubeContentTrigger: {
    reactFlowType: "youtubeContentTrigger",
    label: { en: "YouTube Trigger", zh: "YouTube 触发器" },
    description: { en: "Watches a subscribed YouTube channel", zh: "监听已订阅的 YouTube 频道" },
    domain: "content",
    role: "trigger",
    channelBound: true,
    generatable: true,
    sidebarSection: "triggers",
    propsConditions: true,
    defaultData: () => ({ channelId: "", subscriptions: [], conditions: [] }),
    promptFragment: `youtubeContentTrigger - triggers when any of the selected subscribed YouTube channels publishes a new video
   data: { channelId: "", subscriptions: [], conditions: [] }
   - channelId and subscriptions are left blank — the user picks one or more subscriptions from a multi-select in the Inspector after generation, sourced from their connected YouTube account (OAuth) on the Social page.
   - conditions may filter on "duration" (seconds).`,
  },
  githubContentTrigger: {
    reactFlowType: "githubContentTrigger",
    label: { en: "GitHub Trigger", zh: "GitHub 触发器" },
    description: { en: "Watches releases of selected repos", zh: "监听所选仓库的发版" },
    domain: "content",
    role: "trigger",
    channelBound: true,
    generatable: true,
    sidebarSection: "triggers",
    propsConditions: true,
    defaultData: () => ({ channelId: "", repos: [], includePrerelease: false, conditions: [] }),
    promptFragment: `githubContentTrigger - triggers when any of the selected watched GitHub repos publishes a release
   data: { channelId: "", repos: [], includePrerelease: false, conditions: [] }
   - channelId and repos are left blank — the user picks one or more repos from a multi-select in the Inspector after generation, sourced from the repos they watch on their connected GitHub account (OAuth) on the Social page.
   - includePrerelease defaults to false: prereleases (rc/nightly) do not trigger unless the user opts in.
   - conditions may filter on "release_count_1d" / "release_count_7d" / "release_count_30d" (how many releases the repo published in that window — counted with the same prerelease rule as includePrerelease), "is_prerelease", "tag_name", "title", "content_text", and author fields such as "user.followers_count" (the repo's star count).`,
  },
  xContentAction: {
    reactFlowType: "action",
    label: { en: "X Action", zh: "X 动作" },
    description: { en: `${CONTENT_X_ACTION_COUNT} actions`, zh: `${CONTENT_X_ACTION_COUNT} 个动作` },
    domain: "content",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    externalApi: true,
    defaultData: () => ({ actionType: "xContentAction", prompt: "", provider: "default" }),
    // Leading 3-space indent on the first line matches the user-domain action fragments'
    // (xAction/addToList) "   For X actions: ..." sub-variant style — these fragments are
    // concatenated directly under a numbered "action" item by the prompt builder.
    promptFragment: `   For content actions: data: { actionType: "xContentAction", operation: ${CONTENT_X_ACTION_OPERATIONS}, prompt: "", provider: "default" }
   - Every operation acts via the triggering channel's own account — there is no target-account picker.
${CONTENT_X_ACTION_BULLETS}`,
  },
  tiktokContentAction: {
    reactFlowType: "action",
    label: { en: "TikTok Action", zh: "TikTok 动作" },
    description: { en: `${CONTENT_TIKTOK_ACTION_ENTRIES.length} actions`, zh: `${CONTENT_TIKTOK_ACTION_ENTRIES.length} 个动作` },
    domain: "content",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    externalApi: true,
    defaultData: () => ({
      actionType: "tiktokContentAction", channelId: "", prompts: {},
      textProvider: "default", textSkillId: "none",
      imageCount: 1, imageProvider: "default",
    }),
    promptFragment: `   For TikTok content actions: data: { actionType: "tiktokContentAction", operation: ${CONTENT_TIKTOK_ACTION_OPERATIONS}, channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default" }
   - Leave all fields at these defaults for the user to configure via the Inspector. imageCount/imageProvider only apply to "photo-post".
${CONTENT_TIKTOK_ACTION_BULLETS}`,
  },
  youtubeContentAction: {
    reactFlowType: "action",
    label: { en: "YouTube Action", zh: "YouTube 动作" },
    description: { en: `${CONTENT_YOUTUBE_ACTION_ENTRIES.length} actions`, zh: `${CONTENT_YOUTUBE_ACTION_ENTRIES.length} 个动作` },
    domain: "content",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    externalApi: true,
    defaultData: () => ({ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "", playlistTitle: "" }),
    promptFragment: `   For YouTube content actions: data: { actionType: "youtubeContentAction", operation: ${CONTENT_YOUTUBE_ACTION_OPERATIONS}, playlistId: "" }
   - Every operation acts via the triggering channel's own YouTube account — there is no target-account picker.
   - "save-to-playlist" needs playlistId (user picks a playlist in the Inspector); "rate-like" needs no additional fields.
${CONTENT_YOUTUBE_ACTION_BULLETS}`,
  },
  videoAction: {
    reactFlowType: "action",
    label: { en: "Video Action", zh: "视频动作" },
    description: { en: "Add translated subtitles to the content's video", zh: "为内容的视频添加翻译字幕" },
    domain: "content",
    role: "action",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    externalApi: true,
    defaultData: () => ({ actionType: "videoAction", targetLanguage: "zh" }),
    promptFragment: `   For video actions: data: { actionType: "videoAction", operation: "add-subtitle"|"rotate-to-vertical"|"remove-face", targetLanguage: "zh" }
   - "add-subtitle": downloads the content's video (or the previous Video Action node's output, if chained), transcribes speech, translates it into targetLanguage, burns in subtitles, caches the result in R2. Has "success"/"failed" branches. Produces $content.processed_video_url, $content.video_transcript, $content.translated_subtitle_text.
   - "rotate-to-vertical": pads the video into 9:16 (1080x1920), centered, black bars top/bottom. No-ops (still succeeds) if already portrait/square. Has "success"/"failed" branches. Produces $content.processed_video_url only. targetLanguage is ignored.
   - "remove-face": cuts every segment containing a human face, shortening the video. Fails if the remaining duration drops below ~2 seconds. Has "success"/"failed" branches. Produces $content.processed_video_url only. targetLanguage is ignored.`,
  },
  videoCondition: {
    reactFlowType: "videoCondition",
    label: { en: "Video Condition", zh: "视频条件" },
    description: {
      en: "Sample frames across the video and branch on the face ratio",
      zh: "在视频中抽帧，按人脸占比分支",
    },
    domain: "content",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["true", "false", "failed"],
    defaultData: () => ({ operation: "check-face", operator: "<=", threshold: 0.2 }),
    promptFragment: `videoCondition - samples frames across the content's video and compares the share of frames containing a face against a threshold, has "true"/"false"/"failed" branches
   data: { operation: "check-face", operator: "<=", threshold: 0.2 }
   - "check-face": samples 20 frames spread across the video, measures what fraction of them contain a human face (0-1), and takes the "true" branch when that ratio satisfies operator/threshold. operator is one of "<=", "<", ">=", ">"; threshold is a number between 0 and 1. The default "<= 0.2" therefore means "almost no faces in this video".
   - Uses the upstream Video Action node's output video when one precedes it, otherwise the original. Exposes $content.face_ratio.
   - "failed" covers content with no video (image-only posts), a video longer than 600 seconds, and detection errors — never guess a result on failure.`,
  },
  youtubeCondition: {
    reactFlowType: "youtubeCondition",
    label: { en: "YouTube Condition", zh: "YouTube 条件" },
    description: { en: "Re-check the trigger video's current stats", zh: "重新检查触发视频的当前数据" },
    domain: "content",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["true", "false", "failed"],
    propsConditions: true,
    defaultData: () => ({ conditions: [] }),
    promptFragment: `youtubeCondition - re-fetches the trigger video's current stats from YouTube and branches on them, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }] }
   - Requires a youtubeContentTrigger in the same flow. Put a wait node before it to check the video some time after publication (e.g. wait 1 day, then check whether it passed 10000 views).
   - Fields are the same content props youtubeContentTrigger filters on (view_count, like_count, title, duration, ...), re-read live rather than taken from the trigger-time snapshot.
   - All conditions must pass (AND) for "true"; "failed" means the video is gone/private or the API errored — never guessed.`,
  },
  githubCondition: {
    reactFlowType: "githubCondition",
    label: { en: "GitHub Release Condition", zh: "GitHub 发版条件" },
    description: { en: "Re-check current releases in a repo and branch (e.g. only the latest one wins)", zh: "重新检查repo当前发版情况并分支（例如只让最新的那条通过）" },
    domain: "content",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["true", "false", "failed"],
    propsConditions: true,
    defaultData: () => ({ conditions: [], maxWaitDays: 7 }),
    promptFragment: `githubCondition - re-fetches the current release list for the trigger's repo and branches on it, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }], maxWaitDays: number }
   - Requires a githubContentTrigger in the same flow. Put a wait node before it to let releases published during the wait accumulate.
   - Injects fresh release_count_window (int), release_notes_window (JSON array of {title, content_text}), is_latest_release (0/1) computed over the trailing maxWaitDays.
   - Set maxWaitDays to at least the preceding wait node's own duration. If the wait node's duration ever exceeds maxWaitDays, is_latest_release is forced to 1 regardless of whether a newer release exists (which produces extra posts) — keep wait <= maxWaitDays so this stays inert and only the recency check decides the branch.
   - "failed" means the repo/GitHub API errored — never guessed.`,
  },
  // --- shared across both domains ---
  wait: {
    reactFlowType: "wait",
    label: { en: "Wait", zh: "等待" },
    description: { en: "Delay for a specified duration", zh: "延迟指定时长" },
    domain: "both",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    defaultData: () => ({ duration: 0, unit: "minutes" }),
    promptFragment: `wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }`,
  },
  timeCondition: {
    reactFlowType: "timeCondition",
    label: { en: "Time Condition", zh: "时间条件" },
    description: { en: "Gate by time-of-day / day-of-week", zh: "按时段 / 星期几放行" },
    domain: "both",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    defaultData: () => ({ timeFrom: "", timeTo: "", daysOfWeek: [] }),
    promptFragment: `timeCondition - gates downstream execution to a time-of-day / day-of-week window, single output (no branching)
   data: { timeFrom: "09:00", timeTo: "17:00", daysOfWeek: [1,2,3,4,5] }
   - timeFrom/timeTo are "HH:mm". daysOfWeek is an array of 0(Sun)-6(Sat). Execution continues once inside the window.`,
  },
  abSplit: {
    reactFlowType: "abSplit",
    label: { en: "A/B Split", zh: "A/B 分流" },
    description: { en: "Split traffic by % or condition", zh: "按百分比或条件分流" },
    domain: "both",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["a", "b"],
    defaultData: () => ({ mode: "random", percentA: 50, conditions: [] }),
    promptFragment: `abSplit - splits traffic into two branches, has "a"/"b" branches
   data: { mode: "random"|"condition", percentA: 50, conditions: [{ field: string, operator: "==", value: string }] }
   - mode "random": percentA% of traffic takes branch "a", the rest takes "b".
   - mode "condition": a single field=="value" check in conditions[0] decides "a" (match) vs "b" (no match).`,
  },
  webhook: {
    reactFlowType: "webhook",
    label: { en: "Webhook", zh: "Webhook" },
    description: { en: "Send HTTP request", zh: "发送 HTTP 请求" },
    domain: "both",
    role: "condition",
    generatable: true,
    sidebarSection: "actions",
    branches: ["success", "failed"],
    defaultData: () => ({ url: "", method: "POST", headers: {}, body: "" }),
    promptFragment: `webhook - sends an HTTP request, has "success"/"failed" branches
   data: { url: string, method: "GET"|"POST"|"PUT", body: "" }
   - body supports $user.x / $event.x interpolation; if left blank, defaults to a JSON object of the triggering payload.`,
  },
} as const satisfies Record<string, NodeTypeConfig>;

/** Every registry key: node type ids for non-action types, actionType ids for the action family. */
export type NodeTypeKey = keyof typeof REGISTRY;
/** Union of every React Flow `node.type` the registry declares (the action family collapses to "action"). */
export type ReactFlowNodeType = (typeof REGISTRY)[NodeTypeKey]["reactFlowType"];
/** Registry keys with role "trigger" (their reactFlowType equals the key). */
export type TriggerTypeKey = { [K in NodeTypeKey]: (typeof REGISTRY)[K]["role"] extends "trigger" ? K : never }[NodeTypeKey];
/** Registry keys with role "action" — the data.actionType discriminator values. */
export type ActionTypeKey = { [K in NodeTypeKey]: (typeof REGISTRY)[K]["role"] extends "action" ? K : never }[NodeTypeKey];

// Intersection type: named access keeps each entry's literal facets (and NodeTypeKey stays a
// closed union), while arbitrary-string indexing (NODE_TYPE_REGISTRY[node.type]) still
// typechecks for runtime lookups of possibly-unknown types — exactly how consumers always used
// this export. Runtime lookups must keep treating the result as possibly undefined (`?.`):
// the Record half of the type can't know which strings are real keys.
export const NODE_TYPE_REGISTRY: typeof REGISTRY & Record<string, NodeTypeConfig> = REGISTRY;

export function generatableKeysForDomain(domain: FlowDomain): string[] {
  return Object.entries(NODE_TYPE_REGISTRY)
    .filter(([, cfg]) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both"))
    .map(([key]) => key);
}

/**
 * Bilingual display name for a node type key, falling back to the raw key for unknown types
 * (old graphs may carry types no longer registered). Replaces frontend/config/nodeTypeLabels.ts's
 * nodeLabel — same signature and fallback, now reading the merged registry.
 */
export function nodeLabel(nodeType: string): LocalizedString {
  return NODE_TYPE_REGISTRY[nodeType]?.label ?? { en: nodeType, zh: nodeType };
}

// ---- Derived structural sets (no consumer hand-maintains these lists anymore) ----

// Widened to NodeTypeConfig[] so optional facets (propsConditions, ...) are accessible without
// per-entry narrowing against the const-literal union.
const ALL_ENTRIES: NodeTypeConfig[] = Object.values(REGISTRY);

function uniqueReactFlowTypes(entries: NodeTypeConfig[]): string[] {
  return [...new Set(entries.map((e) => e.reactFlowType))];
}

/** React Flow node types that start a flow — drives orphan detection and trigger lookups. */
export const TRIGGER_REACT_FLOW_TYPES: string[] = uniqueReactFlowTypes(ALL_ENTRIES.filter((e) => e.role === "trigger"));

// Edge legality, derived from role: anything known may be a connection source; anything known
// except a trigger may be a target (triggers have no target handle). Unknown/legacy types (e.g.
// pre-registry "condition" nodes in old graphs) are in neither set — connections to/from them
// stay invalid, byte-for-byte the old hand-written validSources/validTargets behavior.
export const VALID_CONNECTION_SOURCE_TYPES: string[] = uniqueReactFlowTypes(ALL_ENTRIES);
export const VALID_CONNECTION_TARGET_TYPES: string[] = uniqueReactFlowTypes(ALL_ENTRIES.filter((e) => e.role !== "trigger"));

/** Node types whose data.conditions is a ConditionsEditor props-conditions array (see propsConditions). */
export const PROPS_CONDITION_NODE_TYPES: string[] = uniqueReactFlowTypes(ALL_ENTRIES.filter((e) => e.propsConditions === true));

/**
 * Trigger types that fire for one specific connected account (see channelBound). Consumed by
 * both publish gates and by the editor's bulk channel auto-fill, so a new channel-bound trigger
 * is covered everywhere the moment it is tagged in the registry.
 */
export const CHANNEL_BOUND_TRIGGER_TYPES: string[] = uniqueReactFlowTypes(ALL_ENTRIES.filter((e) => e.channelBound === true));

// Sidebar item order within each domain — deliberately separate from NODE_TYPE_REGISTRY's own
// declaration order (which only needs to agree with itself for the shared "both" entries, e.g.
// promptFragment composition order) so user-flow and content-flow Sidebars can each be reordered
// independently without touching the other, or the registry's identity data.
export const USER_FLOW_SIDEBAR_ORDER: string[] = [
  "xTrigger", "cronTrigger", "xAction", "addToList", "webhook", "waitForEvent", "userPropsCondition",
  "wait", "timeCondition", "abSplit",
];

export const CONTENT_FLOW_SIDEBAR_ORDER: string[] = [
  "xContentTrigger", "youtubeContentTrigger", "githubContentTrigger", "xContentAction", "tiktokContentAction", "youtubeContentAction", "videoAction", "videoCondition", "youtubeCondition", "githubCondition",
  "wait", "timeCondition", "abSplit", "webhook",
];

// 条件组的连接词，存在节点的 data.conditionLogic 上。判定只认 CONDITION_LOGIC_OR 这一个
// 字面量：缺省（存量 graph 没这个键）、"and"、以及任何畸形值（AI 生成的 true / null /
// 对象 / 数字 / 大写 "OR"）一律走 AND —— 与本功能上线前的行为逐字相同。
// 前后端共用：后端 engine.ts 的 conditionsPass 与前端 validate-flow-graph.ts 的
// findOrLogicEmptyNodeIds 必须判同一个值，否则会出现"发布拦不住但运行时按别的语义跑"。
export const CONDITION_LOGIC_OR = "or";
export const CONDITION_LOGIC_AND = "and";

export interface YouTubeSubscriptionRef {
  channelId: string;
  channelName: string;
}

// youtubeContentTrigger 的订阅取值，前后端共用的唯一入口：引擎匹配（engine.ts）、
// watches 端点（index.ts）、发布校验（validate-flow-graph.ts）、Inspector 与节点卡片
// 必须判同一份值，否则会出现"发布拦不住但运行时不触发"或反之。
// 优先级：subscriptions 是数组就用它（空数组=用户明确清空，不回退）；否则回退旧标量
// subscriptionChannelId/subscriptionChannelName（存量已发布 flow 的形状，零迁移）。
// 对任何畸形输入（AI 生成/手改坏的 graph_json）只降级、不抛异常——本函数在队列 handler
// 执行路径上，抛出会导致整条消息重试、已执行的 action 重复执行。
export function resolveYouTubeSubscriptions(
  data: Record<string, unknown> | null | undefined
): YouTubeSubscriptionRef[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { subscriptions?: unknown }).subscriptions;
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        channelId: typeof s.channelId === "string" ? s.channelId : "",
        channelName: typeof s.channelName === "string" ? s.channelName : "",
      }))
      .filter((s) => s.channelId !== "");
  }
  const legacyId = (data as { subscriptionChannelId?: unknown }).subscriptionChannelId;
  if (typeof legacyId !== "string" || legacyId === "") return [];
  const legacyName = (data as { subscriptionChannelName?: unknown }).subscriptionChannelName;
  return [{ channelId: legacyId, channelName: typeof legacyName === "string" ? legacyName : "" }];
}

export interface GitHubRepoRef { fullName: string }

/**
 * 节点 data 里的 repo 多选。前后端共用这一份 —— 前端禁止 import flow/src/*，所以解析
 * 必须住在这个两边都 import 的文件里（与 resolveYouTubeSubscriptions 同址同理）。
 * 每一层都做类型检查：AI 生成的 graph 会带任意形状，抛出去会让整条队列消息重试。
 */
export function resolveGitHubRepos(data: Record<string, unknown> | null | undefined): GitHubRepoRef[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { repos?: unknown }).repos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ fullName: typeof r.fullName === "string" ? r.fullName : "" }))
    .filter((r) => r.fullName !== "");
}
