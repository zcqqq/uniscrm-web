import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
// The brief's test snippet named this import buildGeneratePrompt, but the actual export
// (generate-prompt.ts) is buildFlowGenerateSystemPrompt — no such buildGeneratePrompt exists.
// Using the real export name here.
import { buildFlowGenerateSystemPrompt } from "../../src/generate-prompt";

describe("changeUserProps removal", () => {
  it("is gone from the node type registry", () => {
    expect(NODE_TYPE_REGISTRY).not.toHaveProperty("changeUserProps");
  });

  it("is never offered to the flow-generating model", () => {
    expect(buildFlowGenerateSystemPrompt("user")).not.toContain("changeUserProps");
    expect(buildFlowGenerateSystemPrompt("content")).not.toContain("changeUserProps");
  });
});
