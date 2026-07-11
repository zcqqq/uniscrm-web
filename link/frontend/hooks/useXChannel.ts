import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface XChannelState {
  connected: boolean;
  username?: string;
  createdAt?: string;
  hasByok: boolean;
  loading: boolean;
}

export function useXChannel() {
  const [state, setState] = useState<XChannelState>({
    connected: false,
    hasByok: false,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.channels.xStatus();
      setState({
        connected: data.connected,
        username: data.username,
        createdAt: data.created_at,
        hasByok: !!data.has_byok,
        loading: false,
      });
    } catch {
      setState({ connected: false, hasByok: false, loading: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const connect = () => {
    window.location.href = "/api/auth/x/connect";
  };

  const disconnect = async () => {
    await api.channels.disconnectX();
    setState((prev) => ({ ...prev, connected: false, username: undefined, createdAt: undefined, loading: false }));
  };

  return { ...state, connect, disconnect, refresh: load };
}
