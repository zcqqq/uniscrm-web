import { describe, it, expect } from "vitest";
import { executeFlow, resumeFromNode, type FlowGraph } from "../../src/engine";

describe("executeFlow: xContentTrigger", () => {
  function graphWithXContentTrigger(
    conditions: { field: string; operator: string; value: string }[],
    data: Record<string, unknown> = {}
  ): FlowGraph {
    return {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions, ...data }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  it("matches a My Posts node when channel_id matches and no list_id is on the payload", () => {
    const result = executeFlow(graphWithXContentTrigger([]), "content.created", { channel_id: "chan1", channel_type: "X" });
    expect(result.matched).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ type: "noopLeaf" });
  });

  it("does not match a My Posts node for a different channel_id", () => {
    const result = executeFlow(graphWithXContentTrigger([]), "content.created", { channel_id: "chan-other", channel_type: "X" });
    expect(result.matched).toBe(false);
  });

  it("does not match a My Posts node when the event carries a list_id (list-sourced content must not fire My Posts flows)", () => {
    const result = executeFlow(graphWithXContentTrigger([]), "content.created", { channel_id: "chan1", list_id: "listA", channel_type: "X" });
    expect(result.matched).toBe(false);
  });

  it("matches a List Posts node only when both channel_id and list_id match", () => {
    const graph = graphWithXContentTrigger([], { mode: "get-list-posts", listId: "listA" });
    const matches = executeFlow(graph, "content.created", { channel_id: "chan1", list_id: "listA", channel_type: "X" });
    expect(matches.matched).toBe(true);

    const wrongList = executeFlow(graph, "content.created", { channel_id: "chan1", list_id: "listB", channel_type: "X" });
    expect(wrongList.matched).toBe(false);

    const noList = executeFlow(graph, "content.created", { channel_id: "chan1", channel_type: "X" });
    expect(noList.matched).toBe(false);
  });

  it("does not match when a condition fails", () => {
    const graph = graphWithXContentTrigger([{ field: "channel_type", operator: "==", value: "TIKTOK" }]);
    const result = executeFlow(graph, "content.created", { channel_id: "chan1", channel_type: "X" });
    expect(result.matched).toBe(false);
    expect(result.actions).toHaveLength(0);
  });

  it("does not match on an unrelated eventType", () => {
    const result = executeFlow(graphWithXContentTrigger([]), "follow.followed", { channel_id: "chan1", channel_type: "X" });
    expect(result.matched).toBe(false);
  });

  it("still matches xTrigger nodes unaffected by the new xContentTrigger clause", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", { channel_id: "chan1" });
    expect(result.matched).toBe(true);
  });

  it("does not match an xTrigger node when channelId differs from the event's channel_id", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", { channel_id: "chan-other" });
    expect(result.matched).toBe(false);
  });
});

describe("executeFlow: youtubeContentTrigger", () => {
  function graphWithYoutubeContentTrigger(
    conditions: { field: string; operator: string; value: string }[] = [],
    data: Record<string, unknown> = {}
  ): FlowGraph {
    return {
      nodes: [
        { id: "t1", type: "youtubeContentTrigger", data: { channelId: "acct1", subscriptionChannelId: "UCabc", subscriptionChannelName: "Channel A", conditions, ...data }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  it("matches a youtubeContentTrigger node on channelId + subscriptionChannelId for content.created events", () => {
    const result = executeFlow(graphWithYoutubeContentTrigger(), "content.created", { channel_id: "acct1", subscription_channel_id: "UCabc" });
    expect(result.matched).toBe(true);
    expect(result.actions).toHaveLength(1);
  });

  it("does not match when subscriptionChannelId differs, even if channelId (the account) matches", () => {
    const result = executeFlow(graphWithYoutubeContentTrigger(), "content.created", { channel_id: "acct1", subscription_channel_id: "UCother" });
    expect(result.matched).toBe(false);
  });

  it("does not match a youtubeContentTrigger node for a different account channelId", () => {
    const result = executeFlow(graphWithYoutubeContentTrigger(), "content.created", { channel_id: "acct-other", subscription_channel_id: "UCabc" });
    expect(result.matched).toBe(false);
  });
});

describe("collectActions: new content-domain action types", () => {
  it("no longer grants hasBranches to a bare 'repost' actionType (the standalone repost node type has been removed; it now behaves like any unrecognized actionType)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "repost" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([{ type: "repost", nodeId: "a1", hasBranches: false }]);
  });

  it("collects an xContentAction action carrying its operation, prompt, and provider (no target channel — always acts via the triggering channel)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post", prompt: "Rewrite this: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "xContentAction", nodeId: "a1", hasBranches: true, operation: "repost-post", prompt: "Rewrite this: $content.content_text", provider: "default", skillId: "none", attachVideo: false },
    ]);
  });

  it("defaults skillId to 'none' when not set on an xContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ skillId: "none" });
  });

  it("carries a set skillId through", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", skillId: "marketingskills-social" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ skillId: "marketingskills-social" });
  });

  it("defaults operation to 'create-post' when not set on an xContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ operation: "create-post" });
  });

  it("collects a noopLeaf action and continues traversal past it", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
      ],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "noopLeaf", nodeId: "a1", hasBranches: false },
      { type: "noopLeaf", nodeId: "a2", hasBranches: false },
    ]);
  });

  it("collects a tiktokContentAction action carrying its prompts record and other fields, defaulting textSkillId/imageSkillId to 'none' and imageCount to 1 when unset", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            prompts: { title: "Write a title: $content.title", description: "Write a caption: $content.content_text", message_image: "A photo of: $content.title" },
            textProvider: "default", imageProvider: "default",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      {
        type: "tiktokContentAction", nodeId: "a1", hasBranches: true, operation: "photo-post", channelId: "tiktok-chan-1",
        prompts: { title: "Write a title: $content.title", description: "Write a caption: $content.content_text", message_image: "A photo of: $content.title" },
        textProvider: "default", textSkillId: "none",
        imageCount: 1, imageProvider: "default", imageSkillId: "none",
      },
    ]);
  });

  it("carries a set imageCount/textSkillId/imageSkillId through for tiktokContentAction", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            prompts: { title: "t", description: "d", message_image: "i" },
            textProvider: "default", textSkillId: "marketingskills-social",
            imageCount: 5, imageProvider: "openai", imageSkillId: "marketingskills-social",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ imageCount: 5, textSkillId: "marketingskills-social", imageSkillId: "marketingskills-social" });
  });

  it("collects attachVideo:true on an xContentAction node when data.attachVideo is set", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post", attachVideo: true }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ attachVideo: true });
  });

  it("defaults attachVideo to false when not set on an xContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "create-post" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ attachVideo: false });
  });

  it("defaults tiktokContentAction operation to 'photo-post' when not set", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", channelId: "tiktok-chan-1", prompts: {}, textProvider: "default", imageProvider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ operation: "photo-post" });
  });

  it("carries a set 'video-post' operation through on a tiktokContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", operation: "video-post", channelId: "tiktok-chan-1", prompts: {}, textProvider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ operation: "video-post" });
  });

  it("collects a videoCondition action, defaulting operation to 'check-face' when unset", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "videoCondition", nodeId: "a1", operation: "check-face", hasBranches: true },
    ]);
  });

  it("carries a set operation through for videoCondition", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "own:get-posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "videoCondition", data: { operation: "check-face" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "videoCondition", nodeId: "a1", operation: "check-face", hasBranches: true },
    ]);
  });
});

describe("resumeFromNode: action branch targets get full actionData", () => {
  it("continues traversal past a non-branching action branch target", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-1" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "noopLeaf" }, position: { x: 200, y: 0 } },
        { id: "a3", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "a1", target: "a2", sourceHandle: "success" },
        { id: "e2", source: "a2", target: "a3" },
      ],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "noopLeaf", nodeId: "a2", hasBranches: false },
      { type: "addToList", nodeId: "a3", hasBranches: false, listId: "l1" },
    ]);
  });
});
