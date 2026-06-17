import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface XChannelState {
  connected: boolean;
  username?: string;
  loading: boolean;
}

export function useXChannel() {
  const [state, setState] = useState<XChannelState>({
    connected: false,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.channels.xStatus();
      setState({ connected: data.connected, username: data.username, loading: false });
    } catch {
      setState({ connected: false, loading: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const connect = () => {
    window.location.href = "/channel/x/connect";
  };

  const disconnect = async () => {
    await api.channels.disconnectX();
    setState({ connected: false, loading: false });
  };

  return { ...state, connect, disconnect, refresh: load };
}
