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

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export interface ShopifyProduct {
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

export const api = {
  products: {
    list: () => request<{ items: ProductItem[] }>("/products"),
    delete: (id: string) => request(`/products/${id}`, { method: "DELETE" }),
  },
  shopify: {
    getAuthUrl: (shop: string) =>
      request<{ url: string }>(`/channels/shopify/auth?shop=${encodeURIComponent(shop)}`),
    getStatus: () =>
      request<{ connected: boolean; channel_name?: string }>("/channels/shopify/status"),
    getProducts: () =>
      request<{ products: ShopifyProduct[] }>("/channels/shopify/products"),
    sync: (productIds: string[]) =>
      request<SyncResult>("/channels/shopify/sync", {
        method: "POST",
        body: JSON.stringify({ product_ids: productIds }),
      }),
  },
  link: {
    add: (title: string, url: string) =>
      request<{ product: ProductItem }>("/channels/link/add", {
        method: "POST",
        body: JSON.stringify({ title, url }),
      }),
  },
};
