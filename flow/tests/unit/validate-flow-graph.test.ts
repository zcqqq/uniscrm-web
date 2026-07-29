import { describe, it, expect } from "vitest";
import { findOrphanNodeIds, validateFlowGraph, TRIGGER_NODE_TYPES } from "../../frontend/lib/validate-flow-graph";

describe("TRIGGER_NODE_TYPES", () => {
  it("lists the flow-execution entry-point node types", () => {
    expect(TRIGGER_NODE_TYPES).toEqual(["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger"]);
  });
});

describe("findOrphanNodeIds", () => {
  it("returns empty for an empty graph", () => {
    expect(findOrphanNodeIds([], [])).toEqual([]);
  });

  it("returns empty for a trigger-only graph with no other nodes", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }];
    expect(findOrphanNodeIds(nodes, [])).toEqual([]);
  });

  it("flags every non-trigger node when there is no trigger at all", () => {
    const nodes = [
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [{ source: "a1", target: "a2" }];
    expect(findOrphanNodeIds(nodes, edges).sort()).toEqual(["a1", "a2"]);
  });

  it("flags a trigger node with zero outgoing edges (the reported bug case)", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
    ];
    expect(findOrphanNodeIds(nodes, [])).toEqual(["a1"]);
  });

  it("returns empty when every non-trigger node is reachable from a trigger", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      { source: "a1", target: "a2" },
    ];
    expect(findOrphanNodeIds(nodes, edges)).toEqual([]);
  });

  it("flags a branch that is connected to the graph but not reachable from any trigger", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "a1", type: "action" },
      { id: "orphan1", type: "action" },
      { id: "orphan2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      // orphan1 -> orphan2 is a connected pair, but nothing points into orphan1 from a trigger
      { source: "orphan1", target: "orphan2" },
    ];
    expect(findOrphanNodeIds(nodes, edges).sort()).toEqual(["orphan1", "orphan2"]);
  });

  it("recognizes youtubeContentTrigger as a trigger and reaches its downstream action", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "a1", type: "action" },
    ];
    const edges = [{ source: "t1", target: "a1" }];
    expect(findOrphanNodeIds(nodes, edges)).toEqual([]);
  });

  it("reaches nodes downstream of multiple trigger nodes", () => {
    const nodes = [
      { id: "t1", type: "xTrigger" },
      { id: "t2", type: "cronTrigger" },
      { id: "a1", type: "action" },
      { id: "a2", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "a1" },
      { source: "t2", target: "a2" },
    ];
    expect(findOrphanNodeIds(nodes, edges)).toEqual([]);
  });
});

describe("validateFlowGraph", () => {
  it("is valid when there are no orphan nodes", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const edges = [{ source: "t1", target: "a1" }];
    expect(validateFlowGraph(nodes, edges)).toEqual({ valid: true, orphanNodeIds: [], misplacedNodeIds: [] });
  });

  it("is invalid and lists orphan ids when nodes are unreachable", () => {
    const nodes = [{ id: "t1", type: "xTrigger" }, { id: "a1", type: "action" }];
    const result = validateFlowGraph(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.orphanNodeIds).toEqual(["a1"]);
    expect(result.misplacedNodeIds).toEqual([]);
  });

  it("flags a youtubeCondition whose flow is triggered by something other than YouTube", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
    // 它是连着的——不该同时被算成孤儿，否则两条错误文案会同时弹出来
    expect(result.orphanNodeIds).toEqual([]);
  });

  it("accepts a youtubeCondition under a YouTube trigger", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.misplacedNodeIds).toEqual([]);
  });

  it("flags a youtubeCondition in a flow with no trigger at all", () => {
    const nodes = [{ id: "yc1", type: "youtubeCondition" }];
    const result = validateFlowGraph(nodes, []);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
  });

  it("flags every misplaced youtubeCondition, not just the first", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
      { id: "yc2", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }, { source: "yc1", target: "yc2" }];
    expect(validateFlowGraph(nodes, edges).misplacedNodeIds).toEqual(["yc1", "yc2"]);
  });

  it("stays quiet about flows that contain no youtubeCondition", () => {
    const nodes = [{ id: "t1", type: "xContentTrigger" }, { id: "a1", type: "action" }];
    const edges = [{ source: "t1", target: "a1" }];
    expect(validateFlowGraph(nodes, edges).misplacedNodeIds).toEqual([]);
  });
});
