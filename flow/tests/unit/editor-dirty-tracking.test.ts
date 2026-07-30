import { describe, it, expect, beforeEach } from "vitest";
import { useFlowEditor } from "../../frontend/store/flow-editor";

// React Flow 的 onNodesChange/onEdgesChange 不只在用户编辑时触发：挂载时它先测量每个节点的
// 尺寸、派发一批 type:"dimensions"；点选节点派发 type:"select"。这两种都不是编辑。
// 以前它们被无条件记成 isDirty，于是打开一个已保存的 flow 立刻显示 "Unsaved" —— 提示因此
// 完全失去意义，也让人以为自己改了什么。
const SAVED_NODES = [
  { id: "t1", type: "xContentTrigger", position: { x: 0, y: 0 }, data: {} },
  { id: "a1", type: "action", position: { x: 200, y: 0 }, data: { actionType: "xContentAction" } },
];
const SAVED_EDGES = [{ id: "e1", source: "t1", target: "a1" }];

function loadSavedFlow() {
  useFlowEditor
    .getState()
    .setFlow("flow-1", "Saved Flow", true, SAVED_NODES as any, SAVED_EDGES as any, "content");
}

describe("isDirty tracking", () => {
  beforeEach(loadSavedFlow);

  it("a freshly loaded saved flow is clean", () => {
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("React Flow's mount-time dimension measurements do not mark the flow dirty", () => {
    // 这一批就是打开已保存 flow 时立刻出现 "Unsaved" 的原因。
    useFlowEditor.getState().onNodesChange([
      { id: "t1", type: "dimensions", dimensions: { width: 220, height: 80 } },
      { id: "a1", type: "dimensions", dimensions: { width: 220, height: 80 } },
    ] as any);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("selecting a node does not mark the flow dirty", () => {
    useFlowEditor.getState().onNodesChange([{ id: "t1", type: "select", selected: true }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("selecting an edge does not mark the flow dirty", () => {
    useFlowEditor.getState().onEdgesChange([{ id: "e1", type: "select", selected: true }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });

  it("dragging a node to a new position DOES mark the flow dirty — positions are persisted", () => {
    useFlowEditor
      .getState()
      .onNodesChange([{ id: "t1", type: "position", position: { x: 40, y: 40 }, dragging: true }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
  });

  it("removing a node DOES mark the flow dirty", () => {
    useFlowEditor.getState().onNodesChange([{ id: "a1", type: "remove" }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
  });

  it("removing an edge DOES mark the flow dirty", () => {
    useFlowEditor.getState().onEdgesChange([{ id: "e1", type: "remove" }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
  });

  it("a non-editing change never CLEARS an existing dirty flag", () => {
    // 先真编辑一次，再来一批 select/dimensions —— 已经脏了就必须一直脏，否则用户的改动
    // 会在不提示的情况下被 Back 丢掉。
    useFlowEditor.getState().onNodesChange([{ id: "t1", type: "remove" }] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
    useFlowEditor.getState().onNodesChange([
      { id: "a1", type: "select", selected: true },
      { id: "a1", type: "dimensions", dimensions: { width: 1, height: 1 } },
    ] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
  });

  it("a mixed batch containing one real edit marks the flow dirty", () => {
    useFlowEditor.getState().onNodesChange([
      { id: "t1", type: "dimensions", dimensions: { width: 220, height: 80 } },
      { id: "a1", type: "position", position: { x: 9, y: 9 }, dragging: false },
    ] as any);
    expect(useFlowEditor.getState().isDirty).toBe(true);
  });

  it("the node/edge arrays are still updated for non-editing changes", () => {
    // 只跳过 isDirty，不能跳过 applyNodeChanges —— 否则节点测不出尺寸、选中态也不生效。
    useFlowEditor.getState().onNodesChange([{ id: "t1", type: "select", selected: true }] as any);
    expect(useFlowEditor.getState().nodes.find((n) => n.id === "t1")!.selected).toBe(true);
    expect(useFlowEditor.getState().isDirty).toBe(false);
  });
});
