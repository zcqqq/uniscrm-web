import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface TwitterChannelState {
  connected: boolean;
  username?: string;
  loading: boolean;
}

export function useTwitterChannel() {
  const [state, setState] = useState<TwitterChannelState>({
    connected: false,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.channels.twitterStatus();
      setState({ connected: data.connected, username: data.username, loading: false });
    } catch {
      setState({ connected: false, loading: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const connect = () => {
    window.location.href = "/channel/twitter/connect";
  };

  const disconnect = async () => {
    await api.channels.disconnectTwitter();
    setState({ connected: false, loading: false });
  };

  return { ...state, connect, disconnect, refresh: load };
}
