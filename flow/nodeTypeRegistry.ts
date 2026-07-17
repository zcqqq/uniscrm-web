export type FlowDomain = "user" | "content";

export interface NodeTypeConfig {
  /** The React Flow `node.type` this entry corresponds to ("action" for every actionType variant). */
  reactFlowType: string;
  domain: FlowDomain | "both";
  /** Whether the AI generate feature may produce this node type/actionType. */
  generatable: boolean;
  /**
   * LLM-facing documentation fragment, used only by the content-domain prompt builder
   * (the user-domain prompt is a frozen constant and does not read from this registry).
   * Non-action entries: the full item body ("type - description\n   data: {...}\n   - notes").
   * Action-family entries: a "For X actions: ..." sub-bullet (grouped under one numbered
   * "action" item by the prompt builder, matching how the frozen user prompt groups
   * xAction/addToList under its own item 4).
   */
  promptFragment?: string;
}

export const NODE_TYPE_REGISTRY: Record<string, NodeTypeConfig> = {
  // --- user-domain triggers/flow-control/actions ---
  xTrigger: { reactFlowType: "xTrigger", domain: "user", generatable: true },
  cronTrigger: { reactFlowType: "cronTrigger", domain: "user", generatable: false },
  waitForEvent: { reactFlowType: "waitForEvent", domain: "user", generatable: true },
  userPropsCondition: { reactFlowType: "userPropsCondition", domain: "user", generatable: false },
  changeUserProps: { reactFlowType: "changeUserProps", domain: "user", generatable: false },
  addToList: { reactFlowType: "action", domain: "user", generatable: true },
  xAction: { reactFlowType: "action", domain: "user", generatable: true },

  // --- content-domain triggers/actions ---
  xContentTrigger: {
    reactFlowType: "xContentTrigger",
    domain: "content",
    generatable: true,
    promptFragment: `xContentTrigger - triggers when new content arrives on an X channel
   data: { channelId: "", mode: "my_posts"|"list_posts", listId: "", listName: "", conditions: [] }
   - channelId, listId, listName are left blank ("") — the user fills them in via the Inspector after generation.
   - mode "my_posts": triggers on the channel's own posts. mode "list_posts": triggers on posts from a specific X List (leave listId/listName blank).`,
  },
  xContentAction: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    // Leading 3-space indent on the first line matches the frozen user-domain prompt's
    // own "   For X actions: ..." / "   For list actions: ..." sub-variant style under
    // its item 4 — these fragments are concatenated directly under a numbered "action" item.
    promptFragment: `   For content actions: data: { actionType: "xContentAction", operation: "create-post"|"repost-post", channelId: "", prompt: "", provider: "default" }
   - operation "create-post": generates and publishes a new post (channelId = target account, left blank for the user to pick; prompt = free-text instructions for AI generation, left blank for the user to fill in).
   - operation "repost-post": reposts the triggering content via the triggering channel's own account — needs no additional fields; leave channelId/prompt/provider at these defaults.`,
  },
  tiktokContentAction: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    promptFragment: `   For TikTok photo-post actions: data: { actionType: "tiktokContentAction", channelId: "", prompts: {}, textProvider: "default", textSkillId: "none", imageCount: 1, imageProvider: "default", imageSkillId: "none" }
   - Generates images and a caption from the triggering content and posts as a TikTok draft. Leave all fields at these defaults for the user to configure via the Inspector.`,
  },
  updateContentStatus: {
    reactFlowType: "action",
    domain: "content",
    generatable: true,
    promptFragment: `   For status-update actions: data: { actionType: "updateContentStatus", status: "" }
   - status must be set by the user afterward via the Inspector to "published" or "ignored" — leave it blank ("") here. No branching.`,
  },

  // --- shared across both domains ---
  wait: {
    reactFlowType: "wait",
    domain: "both",
    generatable: true,
    promptFragment: `wait - delay execution
   data: { duration: number, unit: "minutes"|"hours"|"days" }`,
  },
  timeCondition: { reactFlowType: "timeCondition", domain: "both", generatable: false },
  abSplit: { reactFlowType: "abSplit", domain: "both", generatable: false },
  webhook: { reactFlowType: "webhook", domain: "both", generatable: false },
};

export function generatableKeysForDomain(domain: FlowDomain): string[] {
  return Object.entries(NODE_TYPE_REGISTRY)
    .filter(([, cfg]) => cfg.generatable && (cfg.domain === domain || cfg.domain === "both"))
    .map(([key]) => key);
}
