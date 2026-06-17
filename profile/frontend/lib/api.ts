async function request<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export interface UserX {
  id: string;
  name: string;
  username: string;
  updated_at: string;
}

export interface List {
  id: string;
  name: string;
  user_count: number;
  created_at: string;
  updated_at: string;
}

export interface ListUser extends UserX {
  added_at: string;
}

export const api = {
  getUsers: (page = 1, limit = 20) =>
    request<{ users: UserX[]; total: number; page: number; totalPages: number }>(
      `/api/users?page=${page}&limit=${limit}`
    ),

  getLists: () =>
    request<{ lists: List[] }>("/api/lists"),

  createList: (name: string) =>
    request<{ id: string; name: string }>("/api/lists", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  deleteList: (id: string) =>
    request<{ ok: boolean }>(`/api/lists/${id}`, { method: "DELETE" }),

  getListUsers: (listId: string, page = 1) =>
    request<{ users: ListUser[]; total: number; page: number; totalPages: number }>(
      `/api/lists/${listId}/users?page=${page}`
    ),

  addUserToList: (listId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/lists/${listId}/users`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),

  removeUserFromList: (listId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/lists/${listId}/users/${userId}`, {
      method: "DELETE",
    }),
};
