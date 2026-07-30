import { describe, it, expect } from "vitest";
import { findOrphanNodeIds, validateFlowGraph, findEmptyYouTubeConditionIds, TRIGGER_NODE_TYPES } from "../../frontend/lib/validate-flow-graph";

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
    expect(validateFlowGraph(nodes, edges)).toEqual({ valid: true, orphanNodeIds: [], misplacedNodeIds: [], emptyConditionNodeIds: [] });
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
    // 带一条真条件：这个 case 要验的是"位置对不对"，不能让空条件那条规则顺带把它判失败。
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "view_count", operator: ">", value: "1" }] } },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.misplacedNodeIds).toEqual([]);
  });

  it("flags a youtubeCondition when the graph has a second, non-YouTube trigger", () => {
    // 单 trigger 只由 addNode 保证；replaceGraph（AI 生成 / 模板载入）不校验，所以两个
    // trigger 的图确实会出现。X 触发的那次运行会把 X post id 喂给 videos.list。
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "t2", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition" },
    ];
    const edges = [{ source: "t1", target: "yc1" }, { source: "t2", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
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

describe("findEmptyYouTubeConditionIds", () => {
  // 条件为空的 youtubeCondition 恒走 true 分支（every() on [] === true），却仍然为每条内容
  // 打一次 videos.list——全平台共享的 10000 units/天配额。发布前必须挡住。
  const ytTrigger = { id: "t1", type: "youtubeContentTrigger" };

  it("flags a youtubeCondition whose conditions array is empty", () => {
    const nodes = [ytTrigger, { id: "yc1", type: "youtubeCondition", data: { conditions: [] } }];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual(["yc1"]);
  });

  it("flags a youtubeCondition with no data at all", () => {
    expect(findEmptyYouTubeConditionIds([ytTrigger, { id: "yc1", type: "youtubeCondition" }])).toEqual(["yc1"]);
  });

  it("accepts a youtubeCondition with one usable condition", () => {
    const nodes = [
      ytTrigger,
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "view_count", operator: ">", value: "1000" }] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual([]);
  });

  it("accepts a condition whose only reference is an author field on the value side", () => {
    // like_count > $user.followers_count * 0.01 —— field 侧是内容字段，作者引用只在 value 里。
    const nodes = [
      ytTrigger,
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "like_count", operator: ">", value: "$user.followers_count * 0.01" }] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual([]);
  });

  it("treats a row with a blank field as no condition — ConditionsEditor's '+ Add' inserts one", () => {
    // evaluateCondition 与 resolveYouTubeCondition 都跳过 !c.field 的条目，所以只有空行的
    // 节点在运行时同样恒为 true。发布校验必须与运行时的判断一致。
    const nodes = [
      ytTrigger,
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "", operator: "==", value: "" }] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual(["yc1"]);
  });

  it("keeps a node that has one blank row alongside one real condition", () => {
    const nodes = [
      ytTrigger,
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "", operator: "==", value: "" }, { field: "view_count", operator: ">", value: "10" }] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual([]);
  });

  it("treats a non-array conditions value as empty, matching the runtime Array.isArray guard", () => {
    // executeContentActions 把畸形值降级成"没有条件"，运行时恒为 true —— 校验必须一致。
    for (const conditions of ["view_count > 1000", 42, { field: "view_count" }, null]) {
      const nodes = [ytTrigger, { id: "yc1", type: "youtubeCondition", data: { conditions } }];
      expect(findEmptyYouTubeConditionIds(nodes), String(conditions)).toEqual(["yc1"]);
    }
  });

  it("ignores nodes that are not youtubeCondition, even with empty conditions", () => {
    const nodes = [
      ytTrigger,
      { id: "vc1", type: "videoCondition", data: { conditions: [] } },
      { id: "a1", type: "action", data: { conditions: [] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual([]);
  });

  it("flags every empty youtubeCondition, not just the first", () => {
    const nodes = [
      ytTrigger,
      { id: "yc1", type: "youtubeCondition", data: { conditions: [] } },
      { id: "yc2", type: "youtubeCondition", data: { conditions: [] } },
    ];
    expect(findEmptyYouTubeConditionIds(nodes)).toEqual(["yc1", "yc2"]);
  });
});

describe("validateFlowGraph — empty youtubeCondition conditions", () => {
  it("blocks publish and reports the node id", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "w1", type: "wait" },
      { id: "yc1", type: "youtubeCondition", data: { conditions: [] } },
    ];
    const edges = [{ source: "t1", target: "w1" }, { source: "w1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.emptyConditionNodeIds).toEqual(["yc1"]);
    // 这条图的连线和 trigger 都是对的——不能顺带误报另外两类
    expect(result.orphanNodeIds).toEqual([]);
    expect(result.misplacedNodeIds).toEqual([]);
  });

  it("passes a fully configured YouTube condition flow", () => {
    const nodes = [
      { id: "t1", type: "youtubeContentTrigger" },
      { id: "w1", type: "wait" },
      { id: "yc1", type: "youtubeCondition", data: { conditions: [{ field: "view_count", operator: ">=", value: "$user.view_count / 1000" }] } },
      { id: "a1", type: "action" },
    ];
    const edges = [
      { source: "t1", target: "w1" },
      { source: "w1", target: "yc1" },
      { source: "yc1", target: "a1" },
    ];
    expect(validateFlowGraph(nodes, edges)).toEqual({
      valid: true,
      orphanNodeIds: [],
      misplacedNodeIds: [],
      emptyConditionNodeIds: [],
    });
  });

  it("reports all three categories at once when a graph has all three problems", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "yc1", type: "youtubeCondition", data: { conditions: [] } },
      { id: "orphan", type: "action" },
    ];
    const edges = [{ source: "t1", target: "yc1" }];
    const result = validateFlowGraph(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.orphanNodeIds).toEqual(["orphan"]);
    expect(result.misplacedNodeIds).toEqual(["yc1"]);
    expect(result.emptyConditionNodeIds).toEqual(["yc1"]);
  });
});
