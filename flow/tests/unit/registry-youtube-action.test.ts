import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";

describe("youtubeContentAction registry entry", () => {
  it("is a content-domain action node", () => {
    const e = NODE_TYPE_REGISTRY.youtubeContentAction;
    expect(e).toBeTruthy();
    expect(e.reactFlowType).toBe("action");
    expect(e.domain).toBe("content");
    expect(e.role).toBe("action");
    expect(e.generatable).toBe(true);
    expect(e.label).toBe("YouTube Action");
  });

  it("prompt fragment lists both operations", () => {
    const f = NODE_TYPE_REGISTRY.youtubeContentAction.promptFragment || "";
    expect(f).toContain("save-to-playlist");
    expect(f).toContain("rate-like");
  });
});
