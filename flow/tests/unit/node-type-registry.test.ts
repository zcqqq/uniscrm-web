import { describe, it, expect } from "vitest";
import {
  NODE_TYPE_REGISTRY,
  generatableKeysForDomain,
  USER_FLOW_SIDEBAR_ORDER,
  CONTENT_FLOW_SIDEBAR_ORDER,
  CONTENT_X_TRIGGER_MODE_LIST_POSTS,
} from "../../nodeTypeRegistry";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { CHANNEL_TYPES } from "../../frontend/config/trigger-fields";

describe("NODE_TYPE_REGISTRY", () => {
  it("tags every known node type/actionType with a domain", () => {
    const expectedKeys = [
      "xTrigger", "cronTrigger", "xContentTrigger", "waitForEvent", "wait",
      "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps",
      "addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus",
    ];
    for (const key of expectedKeys) {
      expect(NODE_TYPE_REGISTRY[key], `missing registry entry for "${key}"`).toBeDefined();
    }
  });

  it("marks the three non-functional node types as not generatable", () => {
    expect(NODE_TYPE_REGISTRY.timeCondition.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.abSplit.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.webhook.generatable).toBe(false);
  });

  it("tags the action-family entries with reactFlowType 'action'", () => {
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"]) {
      expect(NODE_TYPE_REGISTRY[key].reactFlowType).toBe("action");
    }
  });

  it("gives every node type except xTrigger a display label (single source of truth for Sidebar/Node/Inspector)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType, sourced from CHANNEL_TYPES instead
      expect(cfg.label, `missing label for "${key}"`).toBeTruthy();
    }
  });

  it("derives xContentTrigger/xContentAction Sidebar descriptions from ContentMetadata_X's flowType counts", () => {
    const triggerCount = ContentMetadata_X.filter((m) => m.flowType === "trigger").length;
    const actionCount = ContentMetadata_X.filter((m) => m.flowType === "action").length;
    expect(NODE_TYPE_REGISTRY.xContentTrigger.description).toBe(`${triggerCount} triggers`);
    expect(NODE_TYPE_REGISTRY.xContentAction.description).toBe(`${actionCount} actions`);
  });

  it("gives every node type except xTrigger a Sidebar description (single source of truth, no literals left in Sidebar.tsx)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType, computed in Sidebar.tsx from CHANNEL_TYPES instead
      expect(cfg.description, `missing description for "${key}"`).toBeTruthy();
    }
  });

  it("derives xAction's Sidebar description from CHANNEL_TYPES' X entry action count", () => {
    const actionCount = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions.length;
    expect(NODE_TYPE_REGISTRY.xAction.description).toBe(`${actionCount} actions`);
  });

  it("gives every generatable node type a promptFragment (both domains' generate prompts are composed from the registry)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (!cfg.generatable) continue;
      expect(cfg.promptFragment, `missing promptFragment for generatable "${key}"`).toBeTruthy();
    }
  });

  it("derives xTrigger's eventTypes list from CHANNEL_TYPES' X entry (adds dm.read, excludes post.create/like.create which lack flowType:\"trigger\")", () => {
    const xEvents = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.events;
    const fragment = NODE_TYPE_REGISTRY.xTrigger.promptFragment!;
    for (const ev of xEvents) {
      expect(fragment, `missing "${ev.eventType}" (${ev.description})`).toContain(`"${ev.eventType}" (${ev.description})`);
    }
    expect(fragment).not.toContain("post.create");
    expect(fragment).not.toContain("like.create");
  });

  it("derives xAction's xEvents list from CHANNEL_TYPES' X entry actions (byte-identical to today's hardcoded list, zero behavior change)", () => {
    const xActions = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions;
    expect(xActions.map((a) => a.eventType)).toEqual(["follow-user", "unfollow-user", "create-dm", "mute-user"]);
    expect(NODE_TYPE_REGISTRY.xAction.promptFragment).toContain(
      `xEvents: ${xActions.map((a) => `"${a.eventType}"`).join(", ")}`
    );
  });

  it("derives xContentAction's operation enum from ContentMetadata_X's flowType:\"action\" entries, in metadata declaration order", () => {
    const operations = ContentMetadata_X.filter((m) => m.flowType === "action").map((m) => m.sourceContentType);
    expect(operations).toEqual(["create-bookmark", "like-post", "repost-post", "create-post"]);
    expect(NODE_TYPE_REGISTRY.xContentAction.promptFragment).toContain(
      `operation: ${operations.map((op) => `"${op}"`).join("|")}`
    );
  });

  it("derives xContentTrigger's mode enum from ContentMetadata_X's flowType:\"trigger\" sourceContentType values, not a hand-typed my_posts/list_posts enum", () => {
    const modes = ContentMetadata_X.filter((m) => m.flowType === "trigger").map((m) => m.sourceContentType);
    expect(modes).toEqual(["get-list-posts"]); // own:get-posts is poll-only (no flowType: "trigger")
    expect(CONTENT_X_TRIGGER_MODE_LIST_POSTS).toBe("get-list-posts");
    expect(NODE_TYPE_REGISTRY.xContentTrigger.promptFragment).toContain(
      `mode: ${modes.map((m) => `"${m}"`).join("|")}`
    );
    expect(NODE_TYPE_REGISTRY.xContentTrigger.promptFragment).not.toContain("my_posts");
    expect(NODE_TYPE_REGISTRY.xContentTrigger.promptFragment).not.toContain("list_posts");
  });

  it("includes youtubeContentTrigger with domain content and a promptFragment", () => {
    expect(NODE_TYPE_REGISTRY.youtubeContentTrigger.domain).toBe("content");
    expect(NODE_TYPE_REGISTRY.youtubeContentTrigger.promptFragment).toContain("youtubeContentTrigger");
  });

  it("lists youtubeContentTrigger in the content sidebar order", () => {
    expect(CONTENT_FLOW_SIDEBAR_ORDER).toContain("youtubeContentTrigger");
  });
});

describe("USER_FLOW_SIDEBAR_ORDER / CONTENT_FLOW_SIDEBAR_ORDER", () => {
  it("user order lists exactly the domain:'user'/'both' keys, no duplicates or omissions", () => {
    const expected = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.domain === "user" || cfg.domain === "both")
      .map(([key]) => key);
    expect(new Set(USER_FLOW_SIDEBAR_ORDER)).toEqual(new Set(expected));
    expect(USER_FLOW_SIDEBAR_ORDER.length).toBe(expected.length);
  });

  it("content order lists exactly the domain:'content'/'both' keys, no duplicates or omissions", () => {
    const expected = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.domain === "content" || cfg.domain === "both")
      .map(([key]) => key);
    expect(new Set(CONTENT_FLOW_SIDEBAR_ORDER)).toEqual(new Set(expected));
    expect(CONTENT_FLOW_SIDEBAR_ORDER.length).toBe(expected.length);
  });
});

describe("generatableKeysForDomain", () => {
  it("user domain: exactly the 5 types/actionTypes the generate prompt documents today", () => {
    expect(generatableKeysForDomain("user").sort()).toEqual(
      ["addToList", "wait", "waitForEvent", "xAction", "xTrigger"].sort()
    );
  });

  it("content domain: exactly the 6 real, functional content types", () => {
    expect(generatableKeysForDomain("content").sort()).toEqual(
      ["tiktokContentAction", "updateContentStatus", "wait", "xContentAction", "xContentTrigger", "youtubeContentTrigger"].sort()
    );
  });
});
