import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

const BASE = "/api/segments";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await authFetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export interface Segment {
  id: string;
  name: string;
  nl_query: string;
  conditions_json: string;
  sql_query: string;
  user_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SegmentUser {
  id: string;
  name: string;
  username: string;
  profile_image_url: string;
}

export const api = {
  listSegments: (page = 1) =>
    request<{ segments: Segment[]; total: number; page: number; totalPages: number }>(
      `${BASE}?page=${page}`
    ),

  getSegment: (id: string) => request<{ segment: Segment }>(`${BASE}/${id}`),

  createSegment: (name: string, nl_query: string) =>
    request<{ segment: Segment }>(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, nl_query }),
    }),

  preview: (nl_query: string) =>
    request<{ conditions: unknown; sql_query: string; estimated_count: number }>(
      `${BASE}/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nl_query }),
      }
    ),

  compute: (id: string) =>
    request<{ segment: { id: string; status: string; user_count: number } }>(
      `${BASE}/${id}/compute`,
      { method: "POST" }
    ),

  getUsers: (id: string, page = 1) =>
    request<{ users: SegmentUser[]; total: number; page: number; totalPages: number }>(
      `${BASE}/${id}/users?page=${page}`
    ),

  deleteSegment: (id: string) =>
    request<{ ok: boolean }>(`${BASE}/${id}`, { method: "DELETE" }),
};
