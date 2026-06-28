async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
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

export const api = {
  flows: {
    list: (page = 1) =>
      request<{ flows: FlowSummary[]; total: number; page: number; totalPages: number }>(
        `/api/flows?page=${page}`
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
  },
  lists: {
    list: () =>
      request<{ lists: { id: string; name: string; user_count: number }[] }>(`/api/lists`),
  },
};
