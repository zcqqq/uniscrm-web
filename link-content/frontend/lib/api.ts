const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error: string }).error);
  }
  return res.json() as Promise<T>;
}

export interface ContentItem {
  id: string;
  user_id: string;
  channel_type: string;
  channel_source_id: string;
  title: string;
  summary: string | null;
  status: string;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export interface OverflowInfo {
  needsConfirmation: true;
  overflow: number;
  wouldDelete: { id: string; title: string; created_at: string }[];
}

export interface ChannelItem {
  channel_source_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

export const api = {
  contents: {
    list: (channelType?: string) =>
      request<{ items: ContentItem[] }>(
        `/contents${channelType ? `?channel_type=${channelType}` : ""}`
      ),
    sync: (channelType: string, items: ChannelItem[], confirmed?: boolean) =>
      request<SyncResult | OverflowInfo>("/contents/sync", {
        method: "POST",
        body: JSON.stringify({ channel_type: channelType, items, confirmed }),
      }),
    update: (id: string, fields: Record<string, unknown>) =>
      request(`/contents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      }),
    delete: (id: string) =>
      request(`/contents/${id}`, { method: "DELETE" }),
  },
  notion: {
    getAuthUrl: () =>
      request<{ url: string }>("/channels/notion/auth"),
    getStatus: () =>
      request<{ connected: boolean; channel_name?: string }>("/channels/notion/status"),
    getFolders: () =>
      request<{ folders: { id: string; title: string }[] }>("/channels/notion/folders"),
    sync: (confirmed?: boolean) =>
      request<SyncResult | OverflowInfo>("/channels/notion/sync", {
        method: "POST",
        body: JSON.stringify({ confirmed }),
      }),
  },
  channels: {
    getConfig: (type: string) =>
      request<{ config: Record<string, unknown> | null }>(`/channels/${type}/config`),
    saveConfig: (type: string, config: Record<string, unknown>) =>
      request(`/channels/${type}/config`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
  },
};
