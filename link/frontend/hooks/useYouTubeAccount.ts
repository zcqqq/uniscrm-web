import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface YouTubeAccountState {
  connected: boolean;
  email?: string;
  syncStatus?: "pending" | "done" | "error";
  subscriptionCount: number;
  createdAt?: string;
  loading: boolean;
}

export function useYouTubeAccount() {
  const [state, setState] = useState<YouTubeAccountState>({ connected: false, subscriptionCount: 0, loading: true });

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.channels.youtubeStatus();
      setState({
        connected: data.connected,
        email: data.email,
        syncStatus: data.sync_status as "pending" | "done" | "error" | undefined,
        subscriptionCount: data.subscription_count || 0,
        createdAt: data.created_at,
        loading: false,
      });
    } catch {
      setState({ connected: false, subscriptionCount: 0, loading: false });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Poll status while sync is in flight (the initial subscriptions.list pagination
  // happens in a background waitUntil task on the server).
  useEffect(() => {
    if (!state.connected || state.syncStatus !== "pending") return;
    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [state.connected, state.syncStatus, loadStatus]);

  const connect = () => {
    window.location.href = "/api/auth/youtube/connect";
  };

  const disconnect = async () => {
    await api.channels.simpleDisconnect("youtube_account");
    setState({ connected: false, subscriptionCount: 0, loading: false });
  };

  return { ...state, connect, disconnect };
}
