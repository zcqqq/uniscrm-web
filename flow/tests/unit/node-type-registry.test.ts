import { describe, it, expect } from "vitest";
import {
  NODE_TYPE_REGISTRY,
  generatableKeysForDomain,
  USER_FLOW_SIDEBAR_ORDER,
  CONTENT_FLOW_SIDEBAR_ORDER,
  CONTENT_X_TRIGGER_MODE_LIST_POSTS,
} from "../../nodeTypeRegistry";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_TikTok } from "../../../metadata/tiktok";
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

  it("marks every registry entry generatable — timeCondition/abSplit/userPropsCondition/webhook's branches don't resolve at runtime yet, but generation was explicitly turned on anyway (see flow/CLAUDE.md or the commit message for context)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      expect(cfg.generatable, `expected "${key}" to be generatable`).toBe(true);
    }
  });

  it("tags every entry with a role, and role 'action' exactly matches reactFlowType 'action'", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      expect(cfg.role, `missing role for "${key}"`).toBeTruthy();
    }
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      expect(cfg.role === "action", `role/reactFlowType mismatch for "${key}"`).toBe(cfg.reactFlowType === "action");
    }
  });

  it("tags exactly the trigger-family entries with role 'trigger'", () => {
    const triggerKeys = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.role === "trigger")
      .map(([key]) => key)
      .sort();
    expect(triggerKeys).toEqual(["cronTrigger", "xContentTrigger", "xTrigger", "youtubeContentTrigger"].sort());
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

  it("derives xContentAction's per-operation bullets from ContentMetadata_X's description field, not hand-typed prose", () => {
    const entries = ContentMetadata_X.filter((m) => m.flowType === "action");
    const fragment = NODE_TYPE_REGISTRY.xContentAction.promptFragment!;
    for (const m of entries) {
      expect(m.description, `"${m.sourceContentType}" is missing a description — xContentAction's bullet generator needs it`).toBeTruthy();
      expect(fragment, `missing bullet for "${m.sourceContentType}"`).toContain(`operation "${m.sourceContentType}": ${m.description!.en}`);
    }
  });

  it("gives operations with an aiType prop the AI-generation guidance suffix, others the no-additional-fields suffix", () => {
    const fragment = NODE_TYPE_REGISTRY.xContentAction.promptFragment!;
    const createPost = ContentMetadata_X.find((m) => m.sourceContentType === "create-post")!;
    expect(createPost.contentProps.some((p) => p.aiType)).toBe(true);
    expect(fragment).toContain('operation "create-post": Publish a new post via the triggering channel — prompt = free-text instructions for AI generation, left blank for the user to fill in.');
    const bookmark = ContentMetadata_X.find((m) => m.sourceContentType === "create-bookmark")!;
    expect(bookmark.contentProps.some((p) => p.aiType)).toBe(false);
    expect(fragment).toContain('operation "create-bookmark": Bookmarks via the triggering channel — needs no additional fields; leave prompt/provider at these defaults.');
  });

  it("derives tiktokContentAction's description from ContentMetadata_TikTok's photo-post entry, not hand-typed prose", () => {
    const photoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "photo-post")!;
    expect(photoPost.description).toBeTruthy();
    expect(NODE_TYPE_REGISTRY.tiktokContentAction.promptFragment).toContain(photoPost.description!.en);
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
  it("user domain: every domain:'user'/'both' type/actionType, now that all of them are generatable", () => {
    expect(generatableKeysForDomain("user").sort()).toEqual(
      [
        "xTrigger", "cronTrigger", "waitForEvent", "userPropsCondition", "changeUserProps",
        "xAction", "addToList", "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
    );
  });

  it("content domain: every domain:'content'/'both' type/actionType, now that all of them are generatable", () => {
    expect(generatableKeysForDomain("content").sort()).toEqual(
      [
        "xContentTrigger", "youtubeContentTrigger", "xContentAction", "tiktokContentAction", "updateContentStatus",
        "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
    );
  });
});
