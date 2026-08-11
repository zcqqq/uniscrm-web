import { create } from "zustand";
import {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type Connection,
  type ReactFlowInstance,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
} from "@xyflow/react";
import { api } from "../lib/api";
import {
  NODE_TYPE_REGISTRY,
  VALID_CONNECTION_SOURCE_TYPES,
  VALID_CONNECTION_TARGET_TYPES,
  type FlowDomain,
} from "../../nodeTypeRegistry";

export interface FlowEditorState {
  flowId: string | null;
  flowName: string;
  flowEnabled: boolean;
  // Which domain this flow belongs to. Comes from the flow row (or, for an unsaved new flow,
  // from the ?domain= param) — never inferred from the nodes currently on the canvas, so
  // deleting the trigger can't silently reclassify the flow. See migration 0014.
  flowDomain: FlowDomain;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;
  errorNodeIds: string[];
  // Set once by Canvas.tsx's onInit. Lets Sidebar.tsx compute canvas-viewport-relative
  // positions (e.g. "center of what's currently visible") for tap-to-add, without Canvas
  // having to expose a dedicated action for every future caller.
  reactFlowInstance: ReactFlowInstance | null;

  setFlow: (id: string | null, name: string, enabled: boolean, nodes: Node[], edges: Edge[], domain: FlowDomain) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;
  addNode: (type: string, position: { x: number; y: number }) => boolean;
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
  // i18n-ok: "Promise<void>" is a TS return type, not text — audit's regex false-matches "=> Promise<"
  autoFillChannelIds: () => Promise<void>;
  setErrorNodeIds: (ids: string[]) => void;
  setReactFlowInstance: (instance: ReactFlowInstance | null) => void;
}

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
// Legal source/target sets derive from the registry's roles (nodeTypeRegistry.ts): every known
// type may be a source, everything but a trigger may be a target, unknown types are neither —
// same semantics the hand-written validSources/validTargets arrays had.
export function isValidConnection(source: Node | undefined, target: Node | undefined): boolean {
  if (!source || !target) return false;
  return VALID_CONNECTION_SOURCE_TYPES.includes(source.type ?? "")
    && VALID_CONNECTION_TARGET_TYPES.includes(target.type ?? "");
}

// React Flow 的 onNodesChange/onEdgesChange 不只在用户编辑时触发：挂载时它会先测量每个节点
// 的尺寸并派发一批 type:"dimensions"，点选节点派发 type:"select"。这两种都不是编辑，却曾经
// 被无条件记成 isDirty —— 结果打开一个已保存的 flow 立刻显示 "Unsaved"，这个提示因此完全
// 失去意义（也让人误以为自己动过什么，进而担心覆盖）。
// 只有真正会改变 graph_json 的变更才算脏：position（节点坐标是持久化的）、add/remove/replace。
// 用 union 的 type 字面量而不是判断字段有无，改动 React Flow 版本时才会在类型上暴露出来。
const EDITING_CHANGE_TYPES = ["position", "add", "remove", "replace"];

function isEditingChange(change: { type?: string }): boolean {
  return EDITING_CHANGE_TYPES.includes(change.type ?? "");
}

export const useFlowEditor = create<FlowEditorState>((set, get) => ({
  flowId: null,
  // Must stay byte-identical to the backend/DB default — see flow/src/index.ts's
  // POST /api/flows fallback and every tenant DB migration's
  // `name TEXT NOT NULL DEFAULT 'Untitled Flow'`. This is a persisted data value, not display
  // copy — translating only the frontend copy would make flow names differ depending on
  // i18n-ok: whether the default came from the frontend or the backend/DB.
  flowName: "Untitled Flow",
  flowEnabled: false,
  flowDomain: "user",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,
  errorNodeIds: [],
  reactFlowInstance: null,

  setFlow: (id, name, enabled, nodes, edges, domain) =>
    set({ flowId: id, flowName: name, flowEnabled: enabled, flowDomain: domain, nodes, edges, isDirty: false, selectedNodeId: null, errorNodeIds: [] }),

  onNodesChange: (changes) =>
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes),
      isDirty: state.isDirty || changes.some(isEditingChange),
    })),

  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
      isDirty: state.isDirty || changes.some(isEditingChange),
    })),

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
    // Default node data and the key → reactFlowType mapping both come from the registry —
    // formerly a hand-written per-type switch here. Unknown keys keep returning false.
    const cfg = NODE_TYPE_REGISTRY[type];
    if (!cfg) return false;
    if (cfg.role === "trigger" && get().nodes.some((n) => NODE_TYPE_REGISTRY[n.type!]?.role === "trigger")) {
      return false;
    }

    const node: Node = {
      id: crypto.randomUUID(),
      type: cfg.reactFlowType,
      position,
      data: cfg.defaultData(),
    };
    set((state) => ({ nodes: [...state.nodes, node], isDirty: true }));

    if (ACTION_CHANNEL_TYPE[type]) {
      void get().autoFillChannelIds();
    }
    return true;
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
  setReactFlowInstance: (instance) => set({ reactFlowInstance: instance }),

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
        // listCached 现在会在取数失败时 reject。自动填充是加载 flow 时的尽力而为，
        // 取不到就当"不知道有哪些账号"跳过这一类，绝不能把整个 flow 的加载带崩，
        // 也不能凭空判定"只有一个账号"去改图。
        channelsByType[ct] = await api.channels.listCached(ct).catch(() => []);
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
