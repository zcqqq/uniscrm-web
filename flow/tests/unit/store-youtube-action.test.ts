import { describe, it, expect } from "vitest";
import { useFlowEditor } from "../../frontend/store/flow-editor";

describe("addNode youtubeContentAction", () => {
  it("initializes default data", () => {
    useFlowEditor.getState().addNode("youtubeContentAction", { x: 0, y: 0 });
    const node = useFlowEditor.getState().nodes.find((n) => (n.data as any).actionType === "youtubeContentAction");
    expect(node).toBeTruthy();
    expect(node!.type).toBe("action");
    expect(node!.data).toMatchObject({ actionType: "youtubeContentAction", operation: "save-to-playlist", playlistId: "" });
  });
});
