const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

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

export const api = {
  channels: {
    twitterStatus: () =>
      request<{ connected: boolean; username?: string; channel_id?: string }>("/channels/twitter/status"),
    disconnectTwitter: () =>
      request<{ ok: boolean }>("/channels/twitter", { method: "DELETE" }),
  },
  users: {
    list: (page = 1, limit = 20) =>
      request<{ users: XUser[]; total: number; page: number; totalPages: number }>(`/users?page=${page}&limit=${limit}`),
    get: (id: string) =>
      request<{ user: XUser }>(`/users/${id}`),
    events: (id: string, offset = 0, limit = 100) =>
      request<{ events: XEvent[]; hasMore: boolean }>(`/users/${id}/events?offset=${offset}&limit=${limit}`),
  },
};
