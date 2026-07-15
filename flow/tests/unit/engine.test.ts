import { describe, it, expect } from "vitest";
import { executeFlow, type FlowGraph } from "../../src/engine";

describe("executeFlow: contentTrigger", () => {
  function graphWithContentTrigger(conditions: { field: string; operator: string; value: string }[]): FlowGraph {
    return {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  it("matches a contentTrigger node on eventType 'content.created' with no conditions", () => {
    const result = executeFlow(graphWithContentTrigger([]), "content.created", { channel_type: "X" });
    expect(result.matched).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ type: "updateContentStatus" });
  });

  it("does not match a contentTrigger node when a condition fails", () => {
    const graph = graphWithContentTrigger([{ field: "channel_type", operator: "==", value: "TIKTOK" }]);
    const result = executeFlow(graph, "content.created", { channel_type: "X" });
    expect(result.matched).toBe(false);
    expect(result.actions).toHaveLength(0);
  });

  it("does not match a contentTrigger node on an unrelated eventType", () => {
    const result = executeFlow(graphWithContentTrigger([]), "follow.followed", { channel_type: "X" });
    expect(result.matched).toBe(false);
  });

  it("still matches xTrigger nodes unaffected by the new contentTrigger clause", () => {
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
  it("collects a repost action with hasBranches true", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "repost" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([{ type: "repost", nodeId: "a1", hasBranches: true }]);
  });

  it("collects an aiRewritePublish action carrying its target channel and skill", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "aiRewritePublish", channelId: "tiktok-chan-1", skillId: "punchy-social" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([
      { type: "aiRewritePublish", nodeId: "a1", hasBranches: true, targetChannelId: "tiktok-chan-1", skillId: "punchy-social" },
    ]);
  });

  it("collects an updateContentStatus action and continues traversal past it", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "contentTrigger", data: { conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "updateContentStatus", status: "published" }, position: { x: 200, y: 0 } },
        { id: "a2", type: "action", data: { actionType: "updateContentStatus", status: "ignored" }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
      ],
    };
    const result = executeFlow(graph, "content.created", {});
    expect(result.actions).toEqual([
      { type: "updateContentStatus", nodeId: "a1", hasBranches: false, status: "published" },
      { type: "updateContentStatus", nodeId: "a2", hasBranches: false, status: "ignored" },
    ]);
  });
});
