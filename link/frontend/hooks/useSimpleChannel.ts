import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface SimpleChannelState {
  connected: boolean;
  displayName?: string;
  createdAt?: string;
  loading: boolean;
}

/**
 * Generic hook for "simple" single-connection OAuth channels: status + disconnect
 * only. The channel-specific OAuth connect/callback flow lives under
 * /api/auth/:type/* and is not part of this hook — pass its connect URL in
 * along with the DB channel_type and the config field used as the display name.
 */
export function useSimpleChannel(channelType: string, displayField: string) {
  const [state, setState] = useState<SimpleChannelState>({
    connected: false,
    loading: true,
  });

  const load = useCallback(async () => {
    try {
      const data = await api.channels.simpleStatus(channelType, displayField);
      setState({
        connected: data.connected,
        displayName: data.displayName,
        createdAt: data.created_at,
        loading: false,
      });
    } catch {
      setState({ connected: false, loading: false });
    }
  }, [channelType, displayField]);

  useEffect(() => { load(); }, [load]);

  const disconnect = async () => {
    await api.channels.simpleDisconnect(channelType);
    setState((prev) => ({ ...prev, connected: false, displayName: undefined, createdAt: undefined, loading: false }));
  };

  return { ...state, disconnect, refresh: load };
}
