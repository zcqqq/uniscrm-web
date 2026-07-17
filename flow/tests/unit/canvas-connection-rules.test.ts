import { describe, it, expect } from "vitest";
import { isValidConnection } from "../../frontend/store/flow-editor";
import type { Node } from "@xyflow/react";

function node(type: string): Node {
  return { id: "n", type, position: { x: 0, y: 0 }, data: {} };
}

describe("isValidConnection (shared by Canvas.tsx and the store's onConnect)", () => {
  it("allows xContentTrigger -> action (content domain: xContentTrigger-listPost -> xContentAction-Repost)", () => {
    expect(isValidConnection(node("xContentTrigger"), node("action"))).toBe(true);
  });

  it("allows xContentTrigger -> the other content/shared node types", () => {
    for (const targetType of ["wait", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps"]) {
      expect(isValidConnection(node("xContentTrigger"), node(targetType))).toBe(true);
    }
  });

  it("still allows the original user-domain connections", () => {
    expect(isValidConnection(node("xTrigger"), node("action"))).toBe(true);
    expect(isValidConnection(node("wait"), node("waitForEvent"))).toBe(true);
  });

  it("rejects connecting into any trigger node", () => {
    expect(isValidConnection(node("action"), node("xContentTrigger"))).toBe(false);
    expect(isValidConnection(node("action"), node("xTrigger"))).toBe(false);
    expect(isValidConnection(node("action"), node("cronTrigger"))).toBe(false);
  });

  it("rejects when source or target node is missing", () => {
    expect(isValidConnection(undefined, node("action"))).toBe(false);
    expect(isValidConnection(node("xContentTrigger"), undefined)).toBe(false);
  });
});
