import { describe, it, expect } from "vitest";
import {
  NODE_TYPE_REGISTRY,
  generatableKeysForDomain,
  USER_FLOW_SIDEBAR_ORDER,
  CONTENT_FLOW_SIDEBAR_ORDER,
  CONTENT_X_TRIGGER_MODE_LIST_POSTS,
  CHANNEL_BOUND_TRIGGER_TYPES,
} from "../../nodeTypeRegistry";
import { ContentMetadata_X } from "../../../metadata/x-byok";
import { ContentMetadata_TikTok } from "../../../metadata/tiktok";
import { CHANNEL_TYPES } from "../../frontend/config/trigger-fields";

describe("NODE_TYPE_REGISTRY", () => {
  it("tags every known node type/actionType with a domain", () => {
    const expectedKeys = [
      "xTrigger", "cronTrigger", "xContentTrigger", "waitForEvent", "wait",
      "timeCondition", "userPropsCondition", "abSplit", "webhook",
      "addToList", "xAction", "xContentAction", "tiktokContentAction",
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
    expect(triggerKeys).toEqual(["cronTrigger", "xContentTrigger", "xTrigger", "youtubeContentTrigger", "githubContentTrigger"].sort());
  });

  it("tags the action-family entries with reactFlowType 'action'", () => {
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction", "videoAction"]) {
      expect(NODE_TYPE_REGISTRY[key].reactFlowType).toBe("action");
    }
  });

  it("gives every node type except xTrigger a display label (single source of truth for Sidebar/Node/Inspector)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType, sourced from CHANNEL_TYPES instead
      expect(cfg.label, `missing label for "${key}"`).toBeTruthy();
    }
  });

  // Replaces the deleted node-type-labels.test.ts: labels/descriptions used to live in a second
  // registry (frontend/config/nodeTypeLabels.ts) whose only guarantee was key parity with this
  // one. Now they're merged, the guarantee is that every entry is fully bilingual.
  it("labels and descriptions are bilingual { en, zh } objects with both languages filled in", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType
      expect(cfg.label!.en, `empty en label for "${key}"`).toBeTruthy();
      expect(cfg.label!.zh, `empty zh label for "${key}"`).toBeTruthy();
      expect(cfg.description!.en, `empty en description for "${key}"`).toBeTruthy();
      expect(cfg.description!.zh, `empty zh description for "${key}"`).toBeTruthy();
    }
  });

  it("gives every entry a defaultData factory returning a fresh object (no aliasing between nodes)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      const a = cfg.defaultData();
      const b = cfg.defaultData();
      expect(a, `defaultData for "${key}" is not an object`).toBeTypeOf("object");
      expect(a, `defaultData for "${key}" returns a shared reference`).not.toBe(b);
      expect(a).toEqual(b);
      if (cfg.role === "action") {
        expect(a.actionType, `action "${key}" defaultData must carry its actionType discriminator`).toBe(key);
      }
    }
  });

  it("tags exactly the third-party-API actions externalApi (drives hasBranches; addToList is internal)", () => {
    const externalKeys = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.externalApi === true)
      .map(([key]) => key)
      .sort();
    expect(externalKeys).toEqual(["tiktokContentAction", "videoAction", "xAction", "xContentAction", "youtubeContentAction"].sort());
    for (const key of externalKeys) {
      expect(NODE_TYPE_REGISTRY[key].role, `externalApi on non-action "${key}"`).toBe("action");
      expect(NODE_TYPE_REGISTRY[key].branches, `externalApi action "${key}" must declare success/failed branches`).toEqual(["success", "failed"]);
    }
  });

  it("declares branches only on branching node types, never on triggers, matching each promptFragment's own wording", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (cfg.role === "trigger") {
        expect(cfg.branches, `trigger "${key}" must not declare branches`).toBeUndefined();
      }
      if (cfg.branches) {
        expect(cfg.branches.length, `"${key}" declares an empty branches list`).toBeGreaterThan(1);
      }
    }
  });

  it("tags exactly the seven ConditionsEditor-driven types propsConditions (drives the OR-empty publish gate)", () => {
    const keys = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.propsConditions === true)
      .map(([key]) => key)
      .sort();
    expect(keys).toEqual(["waitForEvent", "xContentTrigger", "xTrigger", "youtubeCondition", "youtubeContentTrigger", "githubContentTrigger", "githubCondition"].sort());
  });

  // channelBound 驱动两侧的"trigger 没选账号"发布门禁（frontend/lib/validate-flow-graph.ts、
  // src/trigger-health.ts）和编辑器的批量账号自动填充。漏标一个新 trigger，就等于给它开了
  // 一条"发布成功但永不触发"的静默失败路径 —— 2026-08-21 排查生产租户 100001 时正是如此。
  it("tags exactly the triggers whose matcher compares data.channelId, and never cronTrigger", () => {
    const keys = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.channelBound === true)
      .map(([key]) => key)
      .sort();
    expect(keys).toEqual(["githubContentTrigger", "xContentTrigger", "xTrigger", "youtubeContentTrigger"]);
    expect(keys).not.toContain("cronTrigger");
  });

  it("only ever tags trigger-role entries channelBound", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (cfg.channelBound) expect(cfg.role, `"${key}" is channelBound but not a trigger`).toBe("trigger");
    }
  });

  it("CHANNEL_BOUND_TRIGGER_TYPES mirrors the tagged entries", () => {
    expect([...CHANNEL_BOUND_TRIGGER_TYPES].sort()).toEqual(
      ["githubContentTrigger", "xContentTrigger", "xTrigger", "youtubeContentTrigger"]
    );
  });

  // channelBound 的 trigger 必须自带 channelId 这一格，否则新建的节点连"没选账号"这个
  // 状态都表达不出来，门禁判的是一个不存在的字段。
  it("gives every channelBound trigger a channelId key in its defaultData", () => {
    for (const key of CHANNEL_BOUND_TRIGGER_TYPES) {
      expect(NODE_TYPE_REGISTRY[key].defaultData(), key).toHaveProperty("channelId");
    }
  });

  it("derives xContentTrigger/xContentAction Sidebar descriptions from ContentMetadata_X's flowType counts, computed once into both languages", () => {
    const triggerCount = ContentMetadata_X.filter((m) => m.flowType === "trigger").length;
    const actionCount = ContentMetadata_X.filter((m) => m.flowType === "action").length;
    expect(NODE_TYPE_REGISTRY.xContentTrigger.description).toEqual({ en: `${triggerCount} triggers`, zh: `${triggerCount} 个触发器` });
    expect(NODE_TYPE_REGISTRY.xContentAction.description).toEqual({ en: `${actionCount} actions`, zh: `${actionCount} 个动作` });
  });

  it("gives every node type except xTrigger a Sidebar description (single source of truth, no literals left in Sidebar.tsx)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType, computed in Sidebar.tsx from CHANNEL_TYPES instead
      expect(cfg.description, `missing description for "${key}"`).toBeTruthy();
    }
  });

  it("derives xAction's Sidebar description from CHANNEL_TYPES' X entry action count, computed once into both languages", () => {
    const actionCount = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!.actions.length;
    expect(NODE_TYPE_REGISTRY.xAction.description).toEqual({ en: `${actionCount} actions`, zh: `${actionCount} 个动作` });
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

  it("create-post's contentProps include optional IMAGE- and VIDEO-aiType props (message_image, message_video), alongside the existing TEXT prop", () => {
    const createPost = ContentMetadata_X.find((m) => m.sourceContentType === "create-post")!;
    expect(createPost.contentProps).toEqual([
      { propId: "message_text", aiType: "TEXT" },
      { propId: "message_image", aiType: "IMAGE" },
      { propId: "message_video", aiType: "VIDEO" },
    ]);
  });

  it("xContentAction's AI-generation-guidance bullet check only fires for TEXT/IMAGE aiType props, not VIDEO — create-post (TEXT+VIDEO) still gets the AI-generation suffix from its TEXT prop", () => {
    const fragment = NODE_TYPE_REGISTRY.xContentAction.promptFragment!;
    expect(fragment).toContain('operation "create-post": Publish a new post via the triggering channel — prompt = free-text instructions for AI generation, left blank for the user to fill in.');
  });

  it("ContentMetadata_TikTok has a video-post action entry distinct from photo-post, with only TEXT contentProps (video is implicit, not a toggle)", () => {
    const videoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video-post")!;
    expect(videoPost.flowType).toBe("action");
    expect(videoPost.contentProps).toEqual([
      { propId: "title", dataId: "post_info.title", aiType: "TEXT" },
      { propId: "description", dataId: "post_info.description", aiType: "TEXT" },
    ]);
  });

  it("tiktokContentAction's promptFragment is derived from ContentMetadata_TikTok's action entries (not hand-typed), and documents both photo-post and video-post", () => {
    const fragment = NODE_TYPE_REGISTRY.tiktokContentAction.promptFragment!;
    const photoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "photo-post")!;
    const videoPost = ContentMetadata_TikTok.find((m) => m.sourceContentType === "video-post")!;
    expect(fragment).toContain(photoPost.description!.en);
    expect(fragment).toContain(videoPost.description!.en);
    expect(fragment).toContain('operation: "photo-post"|"video-post"');
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
        "xTrigger", "cronTrigger", "waitForEvent", "userPropsCondition",
        "xAction", "addToList", "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
    );
  });

  it("content domain: every domain:'content'/'both' type/actionType, now that all of them are generatable", () => {
    expect(generatableKeysForDomain("content").sort()).toEqual(
      [
        "xContentTrigger", "youtubeContentTrigger", "githubContentTrigger", "xContentAction", "tiktokContentAction", "youtubeContentAction", "videoAction", "videoCondition", "youtubeCondition", "githubCondition",
        "wait", "timeCondition", "abSplit", "webhook",
      ].sort()
    );
  });

  it("registers youtubeCondition as a generatable content-domain condition", () => {
    const cfg = NODE_TYPE_REGISTRY.youtubeCondition;
    expect(cfg).toBeDefined();
    expect(cfg.reactFlowType).toBe("youtubeCondition");
    expect(cfg.role).toBe("condition");
    expect(cfg.domain).toBe("content");
    expect(cfg.generatable).toBe(true);
    expect(cfg.label).toEqual({ en: "YouTube Condition", zh: "YouTube 条件" });
    expect(cfg.description).toEqual({ en: "Re-check the trigger video's current stats", zh: "重新检查触发视频的当前数据" });
  });

  it("puts youtubeCondition in the content sidebar right after videoCondition", () => {
    const order = CONTENT_FLOW_SIDEBAR_ORDER;
    expect(order.indexOf("youtubeCondition")).toBe(order.indexOf("videoCondition") + 1);
  });

  it("does not offer youtubeCondition in the user-flow sidebar", () => {
    expect(USER_FLOW_SIDEBAR_ORDER).not.toContain("youtubeCondition");
  });
});
