import { create } from "zustand";
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";

export interface FlowEditorState {
  flowId: string | null;
  flowName: string;
  flowEnabled: boolean;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;

  setFlow: (id: string | null, name: string, enabled: boolean, nodes: Node[], edges: Edge[]) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;
  addNode: (type: string, position: { x: number; y: number }) => void;
  updateNodeData: (nodeId: string, data: Record<string, unknown>) => void;
  deleteSelectedNode: () => void;
  setSelectedNode: (nodeId: string | null) => void;
  setFlowName: (name: string) => void;
  setFlowEnabled: (enabled: boolean) => void;
  markClean: () => void;
  toGraphJson: () => string;
}

const ACTION_TYPES = ["addToList", "xAction"];

function isValidConnection(source: Node | undefined, target: Node | undefined): boolean {
  if (!source || !target) return false;
  const targetType = target.type;
  const sourceType = source.type;
  if (targetType === "xTrigger") return false;
  const validTargets = ["action", "wait", "waitForEvent"];
  const validSources = ["xTrigger", "wait", "waitForEvent", "action"];
  if (validSources.includes(sourceType!) && validTargets.includes(targetType!)) return true;
  return false;
}

export const useFlowEditor = create<FlowEditorState>((set, get) => ({
  flowId: null,
  flowName: "Untitled Flow",
  flowEnabled: false,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,

  setFlow: (id, name, enabled, nodes, edges) =>
    set({ flowId: id, flowName: name, flowEnabled: enabled, nodes, edges, isDirty: false, selectedNodeId: null }),

  onNodesChange: (changes) =>
    set((state) => ({ nodes: applyNodeChanges(changes, state.nodes), isDirty: true })),

  onEdgesChange: (changes) =>
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges), isDirty: true })),

  onConnect: (connection) => {
    const { nodes } = get();
    const source = nodes.find((n) => n.id === connection.source);
    const target = nodes.find((n) => n.id === connection.target);
    if (!isValidConnection(source, target)) return;
    set((state) => ({
      edges: addEdge({ ...connection, id: crypto.randomUUID() }, state.edges),
      isDirty: true,
    }));
  },

  addNode: (type, position) => {
    let nodeType: string;
    let data: Record<string, unknown>;

    if (type === "xTrigger") {
      nodeType = "xTrigger";
      data = { channelType: "X", eventType: "", channelId: "" };
    } else if (type === "wait") {
      nodeType = "wait";
      data = { duration: 0, unit: "minutes" };
    } else if (type === "waitForEvent") {
      nodeType = "waitForEvent";
      data = { eventType: "", channelId: "", duration: 1, unit: "days", conditions: [] };
    } else if (ACTION_TYPES.includes(type)) {
      nodeType = "action";
      if (type === "addToList") {
        data = { actionType: type, listId: "", listName: "" };
      } else if (type === "xAction") {
        data = { actionType: type, xEvent: "", channelId: "" };
      }
    } else {
      return;
    }

    const node: Node = {
      id: crypto.randomUUID(),
      type: nodeType,
      position,
      data,
    };
    set((state) => ({ nodes: [...state.nodes, node], isDirty: true }));
  },

  updateNodeData: (nodeId, data) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
      isDirty: true,
    })),

  deleteSelectedNode: () => {
    const { selectedNodeId, nodes, edges } = get();
    if (!selectedNodeId) return;
    set({
      nodes: nodes.filter((n) => n.id !== selectedNodeId),
      edges: edges.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId),
      selectedNodeId: null,
      isDirty: true,
    });
  },

  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),

  setFlowName: (name) => set({ flowName: name, isDirty: true }),

  setFlowEnabled: (enabled) => set({ flowEnabled: enabled, isDirty: true }),

  markClean: () => set({ isDirty: false }),

  replaceGraph: (nodes: any[], edges: any[]) => set({ nodes, edges, isDirty: true }),

  toGraphJson: () => {
    const { nodes, edges } = get();
    return JSON.stringify({ nodes, edges });
  },
}));
