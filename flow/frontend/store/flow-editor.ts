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
import { api } from "../lib/api";
import { CONTENT_X_TRIGGER_MODE_LIST_POSTS } from "../../nodeTypeRegistry";

export interface FlowEditorState {
  flowId: string | null;
  flowName: string;
  flowEnabled: boolean;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;
  errorNodeIds: string[];

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
  replaceGraph: (nodes: Node[], edges: Edge[]) => void;
  // Auto-fills data.channelId on any action node whose actionType is in ACTION_CHANNEL_TYPE
  // and still has no channelId, provided the tenant has exactly one connected account for
  // that channelType. No-ops (and skips the API call) if nothing needs filling.
  autoFillChannelIds: () => Promise<void>;
  setErrorNodeIds: (ids: string[]) => void;
}

const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "tiktokContentAction"];

// Action types that operate on a specific channel account (need `data.channelId`), mapped to
// the channelType used to fetch that account list. Add an entry here whenever a new
// channel-scoped action is introduced (e.g. a future "tiktokAction" -> "TIKTOK").
export const ACTION_CHANNEL_TYPE: Record<string, string> = {
  xAction: "X",
  tiktokContentAction: "TIKTOK",
};

// Shared by the store's onConnect below and by Canvas.tsx's isValidConnection prop
// (React Flow gates connection drags with that prop before onConnect ever runs) --
// keep this the single copy so the two never drift apart again.
export function isValidConnection(source: Node | undefined, target: Node | undefined): boolean {
  if (!source || !target) return false;
  const targetType = target.type;
  const sourceType = source.type;
  if (targetType === "xTrigger" || targetType === "cronTrigger" || targetType === "xContentTrigger" || targetType === "youtubeContentTrigger") return false;
  const validTargets = ["action", "wait", "waitForEvent", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps"];
  const validSources = ["xTrigger", "cronTrigger", "xContentTrigger", "youtubeContentTrigger", "wait", "waitForEvent", "action", "timeCondition", "userPropsCondition", "abSplit", "webhook", "changeUserProps"];
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
  errorNodeIds: [],

  setFlow: (id, name, enabled, nodes, edges) =>
    set({ flowId: id, flowName: name, flowEnabled: enabled, nodes, edges, isDirty: false, selectedNodeId: null, errorNodeIds: [] }),

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
      errorNodeIds: [],
    }));
  },

  addNode: (type, position) => {
    let nodeType: string;
    let data: Record<string, unknown>;

    if (type === "xTrigger") {
      nodeType = "xTrigger";
      data = { channelType: "X", eventType: "", channelId: "" };
    } else if (type === "cronTrigger") {
      nodeType = "cronTrigger";
      data = { scheduleType: "", dailyTime: "09:00", cronExpr: "", intervalValue: 60, intervalUnit: "minutes" };
    } else if (type === "wait") {
      nodeType = "wait";
      data = { duration: 0, unit: "minutes" };
    } else if (type === "waitForEvent") {
      nodeType = "waitForEvent";
      data = { eventType: "", channelId: "", duration: 1, unit: "days", conditions: [] };
    } else if (type === "timeCondition") {
      nodeType = "timeCondition";
      data = { timeFrom: "", timeTo: "", daysOfWeek: [] };
    } else if (type === "userPropsCondition") {
      nodeType = "userPropsCondition";
      data = { conditions: [] };
    } else if (type === "abSplit") {
      nodeType = "abSplit";
      data = { mode: "random", percentA: 50, conditions: [] };
    } else if (type === "webhook") {
      nodeType = "webhook";
      data = { url: "", method: "POST", headers: {}, body: "" };
    } else if (type === "changeUserProps") {
      nodeType = "changeUserProps";
      data = { updates: [] };
    } else if (ACTION_TYPES.includes(type)) {
      nodeType = "action";
      if (type === "addToList") {
        data = { actionType: type, listId: "", listName: "" };
      } else if (type === "xAction") {
        data = { actionType: type, xEvent: "", channelId: "" };
      } else if (type === "xContentAction") {
        data = { actionType: type, prompt: "", provider: "default" };
      } else if (type === "tiktokContentAction") {
        data = {
          actionType: type, channelId: "", prompts: {},
          textProvider: "default", textSkillId: "none",
          imageCount: 1, imageProvider: "default", imageSkillId: "none",
        };
      } else {
        throw new Error(`Unexpected action type: ${type}`);
      }
    } else if (type === "xContentTrigger") {
      nodeType = "xContentTrigger";
      data = { channelId: "", mode: CONTENT_X_TRIGGER_MODE_LIST_POSTS, listId: "", listName: "", conditions: [] };
    } else if (type === "youtubeContentTrigger") {
      nodeType = "youtubeContentTrigger";
      data = { channelId: "", channelName: "", conditions: [] };
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

    if (ACTION_CHANNEL_TYPE[type]) {
      void get().autoFillChannelIds();
    }
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

  setErrorNodeIds: (ids) => set({ errorNodeIds: ids }),

  setFlowName: (name) => set({ flowName: name, isDirty: true }),

  setFlowEnabled: (enabled) => set({ flowEnabled: enabled, isDirty: true }),

  markClean: () => set({ isDirty: false }),

  replaceGraph: (nodes: Node[], edges: Edge[]) => set({ nodes, edges, isDirty: true }),

  autoFillChannelIds: async () => {
    const neededTypes = new Set<string>();
    for (const n of get().nodes) {
      if (n.type !== "action") continue;
      const actionType = (n.data as Record<string, unknown>).actionType as string;
      const channelType = ACTION_CHANNEL_TYPE[actionType];
      if (channelType && !(n.data as Record<string, unknown>).channelId) neededTypes.add(channelType);
    }
    if (neededTypes.size === 0) return;

    const channelsByType: Record<string, { id: string; username: string }[]> = {};
    await Promise.all(
      Array.from(neededTypes).map(async (ct) => {
        channelsByType[ct] = await api.channels.listCached(ct);
      })
    );

    let changed = false;
    const nodes = get().nodes.map((n) => {
      if (n.type !== "action") return n;
      const data = n.data as Record<string, unknown>;
      const channelType = ACTION_CHANNEL_TYPE[data.actionType as string];
      if (!channelType || data.channelId) return n;
      const channels = channelsByType[channelType];
      if (channels?.length !== 1) return n;
      changed = true;
      return { ...n, data: { ...data, channelId: channels[0].id } };
    });
    if (changed) set({ nodes, isDirty: true });
  },

  toGraphJson: () => {
    const { nodes, edges } = get();
    return JSON.stringify({ nodes, edges });
  },
}));
