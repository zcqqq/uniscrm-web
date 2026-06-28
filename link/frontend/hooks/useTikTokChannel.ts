import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface TikTokChannelState {
  connected: boolean;
  displayName?: string;
  loading: boolean;
}

export function useTikTokChannel() {
  const [state, setState] = useState<TikTokChannelState>({
    connected: false,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.channels.tiktokStatus();
      setState({ connected: data.connected, displayName: data.displayName, loading: false });
    } catch {
      setState({ connected: false, loading: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const connect = () => {
    window.location.href = "/api/auth/tiktok/connect";
  };

  const disconnect = async () => {
    await api.channels.disconnectTiktok();
    setState({ connected: false, loading: false });
  };

  return { ...state, connect, disconnect, refresh: load };
}
