import { describe, it, expect, beforeEach, vi } from "vitest";

// addNode 落下一个 channel-bound trigger 后会 void 一次 autoFillChannelIds()（"只有一个账号
// 就自动选上"），它会真的去打 /api/channels。测试环境里那是个相对 URL，fetch 直接抛
// Invalid URL，噪音落在这个与账号无关的用例文件上。把出网这一层换掉，回一个"两个账号"的
// 列表——自动填充只在恰好一个账号时才动图，所以这里的图保持不变，用例断言的仍是纯粹的
// 单 trigger 约束。
vi.mock("../../../shared/frontend/lib/auth-fetch", () => ({
  authFetch: async () =>
    new Response(JSON.stringify([{ id: "c1", username: "a" }, { id: "c2", username: "b" }]), {
      status: 200,
      // i18n-ok: HTTP header name/value, not user-facing text
      headers: { "Content-Type": "application/json" },
    }),
}));

import { useFlowEditor } from "../../frontend/store/flow-editor";

describe("addNode: single-trigger-node constraint", () => {
  beforeEach(() => {
    useFlowEditor.setState({ nodes: [], edges: [], isDirty: false });
  });

  it("adds the first trigger node normally", () => {
    const added = useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    expect(added).toBe(true);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
    expect(useFlowEditor.getState().nodes[0].type).toBe("xTrigger");
  });

  it("rejects adding a second trigger node of the same type", () => {
    useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("xTrigger", { x: 100, y: 0 });
    expect(added).toBe(false);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
  });

  it("rejects adding a second trigger node of a different type", () => {
    useFlowEditor.getState().addNode("xContentTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("youtubeContentTrigger", { x: 100, y: 0 });
    expect(added).toBe(false);
    expect(useFlowEditor.getState().nodes).toHaveLength(1);
  });

  it("still allows adding non-trigger nodes freely alongside an existing trigger", () => {
    useFlowEditor.getState().addNode("xTrigger", { x: 0, y: 0 });
    const added = useFlowEditor.getState().addNode("wait", { x: 100, y: 0 });
    expect(added).toBe(true);
    expect(useFlowEditor.getState().nodes).toHaveLength(2);
  });
});
