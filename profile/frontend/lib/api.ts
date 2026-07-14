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

export const api = {
  getUsers: (page = 1, limit = 20) =>
    request<{ users: UserX[]; total: number; page: number; totalPages: number }>(
      `/api/users?page=${page}&limit=${limit}`
    ),
};
