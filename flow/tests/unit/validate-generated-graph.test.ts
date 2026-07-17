import { describe, it, expect } from "vitest";
import { findInvalidNodeType } from "../../../shared/frontend/lib/validate-generated-graph";

describe("findInvalidNodeType", () => {
  it("returns null when every node's effective type is in the allowed set", () => {
    const nodes = [
      { type: "xContentTrigger" },
      { type: "action", data: { actionType: "xContentAction" } },
    ];
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBeNull();
  });

  it("returns the first disallowed top-level type found", () => {
    const nodes = [{ type: "xContentTrigger" }, { type: "wait" }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger"])).toBe("wait");
  });

  it("uses data.actionType (not node.type) as the effective type for action nodes", () => {
    const nodes = [
      { type: "xContentTrigger" },
      { type: "action", data: { actionType: "xAction" } },
    ];
    // "xAction" is a user-domain actionType — must be rejected even though the allowed
    // set contains the generic "action" React Flow type is never itself checked.
    expect(findInvalidNodeType(nodes, ["xContentTrigger", "xContentAction"])).toBe("xAction");
  });

  it("returns null when nodes is not an array", () => {
    expect(findInvalidNodeType(undefined, ["xContentTrigger"])).toBeNull();
    expect(findInvalidNodeType(null, ["xContentTrigger"])).toBeNull();
  });

  it("flags an action node with a missing actionType", () => {
    const nodes = [{ type: "action", data: {} }];
    expect(findInvalidNodeType(nodes, ["xContentTrigger"])).toBe("action");
  });
});
