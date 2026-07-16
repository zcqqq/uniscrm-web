import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error || res.statusText);
  }
  return res.json();
}

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  status: string;
  trigger_count: number;
  member_id: string;
  member_email: string;
  created_at: string;
  updated_at: string;
}

export interface FlowDetail extends FlowSummary {
  graph_json: string;
  tenant_id: string;
}

export interface ChannelOption {
  id: string;
  username: string;
}

// Per-channelType cache so the "auto-fill the only connected account" logic (template load,
// manual node add, Inspector open) doesn't fire a redundant /api/channels request each time.
const channelListCache: Record<string, Promise<ChannelOption[]>> = {};

export const api = {
  flows: {
    list: (page = 1, domain: "user" | "content" = "user") =>
      request<{ flows: FlowSummary[]; total: number; page: number; totalPages: number }>(
        `/api/flows?page=${page}&domain=${domain}`
      ),
    create: (name?: string, graph_json?: string) =>
      request<{ flow: { id: string; name: string } }>("/api/flows", {
        method: "POST",
        body: JSON.stringify({ name, graph_json }),
      }),
    get: (id: string) => request<{ flow: FlowDetail }>(`/api/flows/${id}`),
    update: (id: string, data: { name?: string; description?: string; graph_json?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>(`/api/flows/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/flows/${id}`, { method: "DELETE" }),
    publish: (id: string) =>
      request<{ ok: boolean }>(`/api/flows/${id}/publish`, { method: "POST" }),
    unpublish: (id: string) =>
      request<{ ok: boolean }>(`/api/flows/${id}/unpublish`, { method: "POST" }),
    analytics: (id: string) =>
      request<{ nodes: Record<string, { enter: number; exit: number }> }>(`/api/flows/${id}/analytics`),
    nodeLogs: (flowId: string, nodeId: string) =>
      request<{ logs: { user_id: string; name: string | null; created_at: string }[] }>(
        `/api/flows/${flowId}/nodes/${nodeId}/logs`
      ),
    generate: (prompt: string, currentGraph: { nodes: any[]; edges: any[] }) =>
      request<{ nodes: any[]; edges: any[] }>("/api/flows/generate", {
        method: "POST",
        body: JSON.stringify({ prompt, currentGraph }),
      }),
  },
  channels: {
    list: (channelType: string) =>
      request<ChannelOption[]>(`/api/channels?type=${channelType}`),
    listCached: (channelType: string) => {
      if (!channelListCache[channelType]) {
        channelListCache[channelType] = request<ChannelOption[]>(`/api/channels?type=${channelType}`).catch(() => []);
      }
      return channelListCache[channelType];
    },
    xLists: (channelId: string) =>
      request<{ lists: { id: string; name: string }[] }>(`/api/channels/${channelId}/x-lists`),
  },
  lists: {
    list: () =>
      request<{ lists: { id: string; name: string; user_count: number }[] }>(`/api/lists`),
  },
  llmProviders: {
    list: (): Promise<{ providers: { provider: string; model: string }[] }> => request("/api/llm-providers"),
  },
};
