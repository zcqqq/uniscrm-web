import { describe, it, expect, vi, afterEach } from "vitest";
import { executeFlow, resumeFromNode, type FlowGraph } from "../../src/engine";
import { NODE_EXECUTORS, TRIGGER_MATCHERS, getNodeExecutor, getTriggerMatcher, buildActionData } from "../../src/node-executors";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

afterEach(() => {
  vi.restoreAllMocks();
});

function graphWithTarget(targetType: string): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "follow.created", channelId: "ch1" }, position: { x: 0, y: 0 } },
      { id: "n1", type: targetType, data: {}, position: { x: 0, y: 0 } },
      { id: "n2", type: "action", data: { actionType: "addToList", listId: "l1" }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "n1" },
      { id: "e2", source: "n1", target: "n2" },
    ],
  };
}

describe("unknown node type at runtime (old graphs may carry unregistered types)", () => {
  it("logs an explicit console.error with node id/type and skips the node instead of dying silently", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = executeFlow(graphWithTarget("bogusLegacyType"), "follow.created", { channel_id: "ch1" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain("bogusLegacyType");
    expect(message).toContain("n1");

    // Skip, not crash: the unknown node's "enter" is logged, nothing downstream of it runs.
    expect(result.actions).toEqual([]);
    expect(result.pendingWaits).toEqual([]);
    expect(result.nodeLogs).toEqual([
      { nodeId: "t1", direction: "enter" },
      { nodeId: "t1", direction: "exit" },
      { nodeId: "n1", direction: "enter" },
    ]);
  });

  it("never throws for an unknown type (a throw would retry the queue message and re-run executed actions)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => executeFlow(graphWithTarget("bogusLegacyType"), "follow.created", { channel_id: "ch1" })).not.toThrow();
    expect(() => resumeFromNode(graphWithTarget("bogusLegacyType"), "n1", {})).not.toThrow();
  });

  it("known types do not hit the unknown-type error path", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = executeFlow(graphWithTarget("wait"), "follow.created", { channel_id: "ch1" });
    expect(errorSpy).not.toHaveBeenCalled();
    // wait with no duration parks nothing but is executed (enter logged, no exit until resume).
    expect(result.nodeLogs).toContainEqual({ nodeId: "n1", direction: "enter" });
  });

  it("a trigger wired as an edge target stays a silent no-op (registry-known, so not an 'unknown type' error)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = executeFlow(graphWithTarget("cronTrigger"), "follow.created", { channel_id: "ch1" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.nodeLogs).toContainEqual({ nodeId: "n1", direction: "enter" });
    expect(result.actions).toEqual([]);
  });
});

describe("per-side backend maps stay exhaustive over the registry (runtime mirror of the compile-time Record types)", () => {
  it("every registry reactFlowType has an executor", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      expect(getNodeExecutor(cfg.reactFlowType), `missing executor for "${cfg.reactFlowType}" (registry key "${key}")`).toBeTypeOf("function");
    }
  });

  it("keeps the legacy pre-registry 'condition' executor for old graphs", () => {
    expect(getNodeExecutor("condition")).toBeTypeOf("function");
    expect(NODE_TYPE_REGISTRY["condition"]).toBeUndefined();
  });

  it("trigger matchers exist for exactly the trigger-role registry keys", () => {
    const triggerKeys = Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, cfg]) => cfg.role === "trigger")
      .map(([key]) => key)
      .sort();
    expect(Object.keys(TRIGGER_MATCHERS).sort()).toEqual(triggerKeys);
    expect(getTriggerMatcher("wait")).toBeUndefined();
    expect(getTriggerMatcher("unknownType")).toBeUndefined();
  });

  it("NODE_EXECUTORS has no keys outside registry reactFlowTypes + legacy 'condition'", () => {
    const known = new Set(Object.values(NODE_TYPE_REGISTRY).map((cfg) => cfg.reactFlowType));
    known.add("condition");
    for (const key of Object.keys(NODE_EXECUTORS)) {
      expect(known.has(key), `executor for unregistered type "${key}"`).toBe(true);
    }
  });
});

describe("buildActionData derives hasBranches from the registry's externalApi facet", () => {
  function node(data: Record<string, unknown>) {
    return { id: "a1", type: "action", data, position: { x: 0, y: 0 } };
  }

  it("matches the facet for every action-role registry key", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (cfg.role !== "action") continue;
      const built = buildActionData(node({ actionType: key }));
      expect(built.type).toBe(key);
      expect(built.hasBranches, `hasBranches mismatch for "${key}"`).toBe(cfg.externalApi === true);
    }
  });

  it("keeps the legacy shape for unknown actionTypes: generic branchless action, no extra fields", () => {
    const built = buildActionData(node({ actionType: "mysteryAction", foo: "bar" }));
    expect(built).toEqual({ type: "mysteryAction", nodeId: "a1", hasBranches: false });
  });

  it("carries the X image attachment fields through to the action", () => {
    const built = buildActionData(node({
      actionType: "xContentAction", operation: "create-post", prompt: "p", provider: "default",
      attachImage: true, imageProvider: "openai", imagePrompt: "an abstract illustration",
    }));
    expect(built).toEqual(expect.objectContaining({
      attachImage: true, imageProvider: "openai", imagePrompt: "an abstract illustration",
    }));
  });
});
