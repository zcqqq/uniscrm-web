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
import { TRIGGER_TYPES, type TriggerFieldDefinition } from "../config/trigger-fields";

export interface FlowEditorState {
  flowId: string | null;
  flowName: string;
  flowEnabled: boolean;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;

  setFlow: (id: string, name: string, enabled: boolean, nodes: Node[], edges: Edge[]) => void;
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
  getAvailableFieldsForNode: (nodeId: string) => TriggerFieldDefinition[];
  toGraphJson: () => string;
}

function isValidConnection(source: Node | undefined, target: Node | undefined): boolean {
  if (!source || !target) return false;
  const sourceType = source.type;
  const targetType = target.type;
  if (targetType === "trigger") return false;
  if (sourceType === "trigger" && targetType === "condition") return true;
  if (sourceType === "condition" && targetType === "condition") return true;
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
    const triggerDef = TRIGGER_TYPES.find((t) => t.type === type);
    const nodeType = triggerDef ? "trigger" : "condition";
    const label = triggerDef?.label || "Condition";

    const data: Record<string, unknown> = nodeType === "trigger"
      ? { triggerType: type, label }
      : { field: "", operator: "==", value: "" };

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

  getAvailableFieldsForNode: (nodeId) => {
    const { nodes, edges } = get();
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = nodes.find((n) => n.id === current);
      if (node?.type === "trigger") {
        const triggerType = node.data.triggerType as string;
        const def = TRIGGER_TYPES.find((t) => t.type === triggerType);
        return def?.contextFields || [];
      }

      const incomingEdges = edges.filter((e) => e.target === current);
      for (const edge of incomingEdges) {
        queue.push(edge.source);
      }
    }

    return [];
  },

  toGraphJson: () => {
    const { nodes, edges } = get();
    return JSON.stringify({ nodes, edges });
  },
}));
