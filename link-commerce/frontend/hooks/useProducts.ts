import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ProductItem } from "../lib/api";

export function useProducts() {
  const [items, setItems] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.products.list();
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteItem = async (id: string) => {
    await api.products.delete(id);
    await refresh();
  };

  return { items, loading, refresh, deleteItem };
}
