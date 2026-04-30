import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ShopifyProduct, SyncResult } from "../lib/api";

export function useShopify() {
  const [connected, setConnected] = useState(false);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api.shopify.getStatus();
      setConnected(res.connected);
      setChannelName(res.channel_name ?? null);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("shopify") === "connected") {
      checkStatus();
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [checkStatus]);

  const startAuth = async (shop: string) => {
    const { url } = await api.shopify.getAuthUrl(shop);
    window.location.href = url;
  };

  const loadProducts = async () => {
    const { products: p } = await api.shopify.getProducts();
    setProducts(p);
  };

  const toggleProduct = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === products.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(products.map((p) => p.channel_source_id));
    }
  };

  const triggerSync = async () => {
    if (selectedIds.length === 0) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.shopify.sync(selectedIds);
      setSyncResult(result);
    } finally {
      setSyncing(false);
    }
  };

  return {
    connected,
    channelName,
    products,
    selectedIds,
    syncing,
    syncResult,
    startAuth,
    loadProducts,
    toggleProduct,
    toggleAll,
    triggerSync,
  };
}
