import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY, generatableKeysForDomain } from "../../nodeTypeRegistry";
import { ContentMetadata_X } from "../../../metadata/x-byok";

describe("NODE_TYPE_REGISTRY", () => {
  it("tags every known node type/actionType with a domain", () => {
    const expectedKeys = [
      "xTrigger", "cronTrigger", "xContentTrigger", "waitForEvent", "wait",
      "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps",
      "addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus",
    ];
    for (const key of expectedKeys) {
      expect(NODE_TYPE_REGISTRY[key], `missing registry entry for "${key}"`).toBeDefined();
    }
  });

  it("marks the three non-functional node types as not generatable", () => {
    expect(NODE_TYPE_REGISTRY.timeCondition.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.abSplit.generatable).toBe(false);
    expect(NODE_TYPE_REGISTRY.webhook.generatable).toBe(false);
  });

  it("tags the action-family entries with reactFlowType 'action'", () => {
    for (const key of ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"]) {
      expect(NODE_TYPE_REGISTRY[key].reactFlowType).toBe("action");
    }
  });

  it("gives every node type except xTrigger a display label (single source of truth for Sidebar/Node/Inspector)", () => {
    for (const [key, cfg] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (key === "xTrigger") continue; // dynamic per channelType, sourced from CHANNEL_TYPES instead
      expect(cfg.label, `missing label for "${key}"`).toBeTruthy();
    }
  });

  it("derives xContentTrigger/xContentAction Sidebar descriptions from ContentMetadata_X's flowType counts", () => {
    const triggerCount = ContentMetadata_X.filter((m) => m.flowType === "trigger").length;
    const actionCount = ContentMetadata_X.filter((m) => m.flowType === "action").length;
    expect(NODE_TYPE_REGISTRY.xContentTrigger.description).toBe(`${triggerCount} triggers`);
    expect(NODE_TYPE_REGISTRY.xContentAction.description).toBe(`${actionCount} actions`);
  });
});

describe("generatableKeysForDomain", () => {
  it("user domain: exactly the 4 types/actionTypes the frozen user prompt documents today", () => {
    expect(generatableKeysForDomain("user").sort()).toEqual(
      ["addToList", "wait", "waitForEvent", "xAction", "xTrigger"].sort()
    );
  });

  it("content domain: exactly the 5 real, functional content types", () => {
    expect(generatableKeysForDomain("content").sort()).toEqual(
      ["tiktokContentAction", "updateContentStatus", "wait", "xContentAction", "xContentTrigger"].sort()
    );
  });
});
