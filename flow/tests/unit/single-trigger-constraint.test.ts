import { describe, it, expect, beforeEach } from "vitest";
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
