import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, {
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

// Social types
export interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url: string;
  updated_at: string;
  raw_data?: string;
  socials?: string;
  maigret_status?: string;
  created_at?: string;
}

export interface XEvent {
  id: string;
  event_type: string;
  event_time: string;
  raw_data: string;
  created_at: string;
}

// Content types
export interface ContentItem {
  id: string;
  channel_type: string;
  source_content_id: string;
  title: string;
  summary: string | null;
  status: string;
  source_url: string | null;
  source_updated_at: string | null;
  raw_data: string;
  created_at: string;
  updated_at: string;
}

// Commerce types
export interface ProductItem {
  id: string;
  user_id: string;
  channel_type: string;
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShopifyProduct {
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

// Shared types
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
  source_content_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_updated_at: string | null;
  raw_data?: Record<string, unknown>;
}

// Lists types
export interface ListItem {
  id: string;
  name: string;
  user_count: number;
  created_at: string;
  updated_at: string;
}

export interface ListUser {
  id: string;
  name: string | null;
  username: string | null;
  added_at: string;
}

export const api = {
  // Social
  channels: {
    xStatus: () =>
      request<{ connected: boolean; username?: string; channel_id?: string; created_at?: string; has_byok?: boolean }>("/channels/x/status"),
    disconnectX: () =>
      request<{ ok: boolean }>("/channels/x", { method: "DELETE" }),
    byokCreate: (credentials: { channel_id?: string; client_id: string; client_secret: string; consumer_secret: string }) =>
      request<{ channel_id: string; webhook_url: string; redirect_url: string }>("/channels/x/byok", {
        method: "POST",
        body: JSON.stringify(credentials),
      }),
    byokList: () =>
      request<Array<{ id: string; username: string | null; x_user_id: string | null; authorized: boolean; created_at: string }>>("/channels/x/byok"),
    byokDelete: (channelId: string) =>
      request<{ ok: boolean }>(`/channels/x/byok/${channelId}`, { method: "DELETE" }),
    // Generic simple OAuth channel (single-connection): status/disconnect for any channel type
    simpleStatus: (type: string, displayField: string) =>
      request<{ connected: boolean; displayName?: string; channel_id?: string; created_at?: string }>(
        `/channels/${type}/status?field=${displayField}`
      ),
    simpleDisconnect: (type: string) =>
      request<{ ok: boolean }>(`/channels/${type}`, { method: "DELETE" }),
    getConfig: (type: string) =>
      request<{ config: Record<string, unknown> | null }>(`/channels/${type}/config`),
    saveConfig: (type: string, config: Record<string, unknown>) =>
      request(`/channels/${type}/config`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
  },
  users: {
    list: () =>
      request<{ users: XUser[] }>(`/users`),
    get: (id: string) =>
      request<{ user: XUser }>(`/users/${id}`),
    events: (id: string, offset = 0, limit = 100) =>
      request<{ events: XEvent[]; hasMore: boolean }>(`/users/${id}/events?offset=${offset}&limit=${limit}`),
  },

  // Content
  contents: {
    list: (channelType?: string) =>
      request<{ items: ContentItem[] }>(`/content/items${channelType ? `?channel_type=${channelType}` : ""}`),
    sync: (channelType: string, items: ChannelItem[], confirmed?: boolean) =>
      request<SyncResult | OverflowInfo>("/content/items/sync", {
        method: "POST",
        body: JSON.stringify({ channel_type: channelType, items, confirmed }),
      }),
    update: (id: string, fields: Record<string, unknown>) =>
      request(`/content/items/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
    delete: (id: string) =>
      request(`/content/items/${id}`, { method: "DELETE" }),
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

  // Commerce
  products: {
    list: () => request<{ items: ProductItem[] }>("/commerce/products"),
    delete: (id: string) => request(`/commerce/products/${id}`, { method: "DELETE" }),
    sync: (productIds: string[], confirmed?: boolean) =>
      request<SyncResult | OverflowInfo>("/commerce/products/sync", {
        method: "POST",
        body: JSON.stringify({ product_ids: productIds, confirmed }),
      }),
    addLink: (title: string, url: string, confirmed?: boolean) =>
      request<{ product: ProductItem } | OverflowInfo>("/commerce/products/link/add", {
        method: "POST",
        body: JSON.stringify({ title, url, confirmed }),
      }),
  },
  shopify: {
    getAuthUrl: (shop: string) =>
      request<{ url: string }>(`/channels/shopify/auth?shop=${encodeURIComponent(shop)}`),
    getStatus: () =>
      request<{ connected: boolean; channel_name?: string }>("/channels/shopify/status"),
    getProducts: () =>
      request<{ products: ShopifyProduct[] }>("/channels/shopify/products"),
  },

  // Lists
  lists: {
    list: () =>
      request<{ lists: ListItem[] }>("/lists"),
    create: (name: string) =>
      request<{ id: string; name: string }>("/lists", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      request(`/lists/${id}`, { method: "DELETE" }),
    getUsers: (id: string, page = 1) =>
      request<{ users: ListUser[]; total: number; page: number; totalPages: number }>(`/lists/${id}/users?page=${page}`),
    addUser: (listId: string, userId: string) =>
      request(`/lists/${listId}/users`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    removeUser: (listId: string, userId: string) =>
      request(`/lists/${listId}/users/${userId}`, { method: "DELETE" }),
  },
};
