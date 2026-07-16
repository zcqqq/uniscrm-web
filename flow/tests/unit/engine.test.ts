import { describe, it, expect } from "vitest";
import { executeFlow, resumeFromNode, type FlowGraph } from "../../src/engine";

describe("executeFlow: xContentTrigger", () => {
  function graphWithXContentTrigger(
    conditions: { field: string; operator: string; value: string }[],
    data: Record<string, unknown> = {}
  ): FlowGraph {
    return {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions, ...data }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  it("matches a My Posts node when channel_id matches and no list_id is on the payload", () => {
    const result = executeFlow(graphWithXContentTrigger([]), "content.created", { channel_id: "chan1", channel_type: "X" });
    expect(result.matched).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ type: "updateContentStatus" });
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
    const graph = graphWithXContentTrigger([], { mode: "list_posts", listId: "listA" });
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
        { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "follow.followed", {});
    expect(result.matched).toBe(true);
  });
});

describe("collectActions: new content-domain action types", () => {
  it("no longer grants hasBranches to a bare 'repost' actionType (the standalone repost node type has been removed; it now behaves like any unrecognized actionType)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "repost" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([{ type: "repost", nodeId: "a1", hasBranches: false }]);
  });

  it("collects an xContentAction action carrying its operation, target channel, prompt, and provider", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", operation: "repost-post", channelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "xContentAction", nodeId: "a1", hasBranches: true, operation: "repost-post", targetChannelId: "tiktok-chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" },
    ]);
  });

  it("defaults operation to 'create-post' when not set on an xContentAction node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-2" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ operation: "create-post" });
  });

  it("collects an updateContentStatus action and continues traversal past it", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
      ],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a1", hasBranches: false, status: "published" },
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "ignored" },
    ]);
  });
});

describe("resumeFromNode: action branch targets get full actionData", () => {
  it("populates status on an updateContentStatus branch target (not just {type})", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-1", prompt: "Rewrite this: $content.content_text", provider: "default" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "a1", target: "a2", sourceHandle: "success" }],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "published" },
    ]);
  });

  it("continues traversal past a non-branching action branch target", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a1", type: "action", data: { actionType: "xContentAction", channelId: "chan-1" }, position: { x: 0, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
        { id: "a3", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "a1", target: "a2", sourceHandle: "success" },
        { id: "e2", source: "a2", target: "a3" },
      ],
    };
    const result = resumeFromNode(graph, "a1", {}, "success");
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "published" },
      { type: "addToList", nodeId: "a3", hasBranches: false, listId: "l1" },
    ]);
  });
});
