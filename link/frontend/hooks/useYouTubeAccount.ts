import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface YouTubeSubscription {
  channelId: string;
  channelName: string;
  thumbnailUrl: string;
  already_watching: boolean;
}

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
  const [subscriptions, setSubscriptions] = useState<YouTubeSubscription[]>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);

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

  const loadSubscriptions = useCallback(async () => {
    setLoadingSubscriptions(true);
    try {
      const data = await api.channels.youtubeSubscriptions();
      setSubscriptions(data.subscriptions);
    } catch {
      setSubscriptions([]);
    } finally {
      setLoadingSubscriptions(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (state.connected && state.syncStatus === "done") loadSubscriptions();
  }, [state.connected, state.syncStatus, loadSubscriptions]);

  // Poll status while sync is in flight (the initial subscriptions.list pagination
  // happens in a background waitUntil task on the server — see Task 4).
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
    setSubscriptions([]);
  };

  const watchChannel = async (youtubeChannelId: string) => {
    await api.channels.youtubeWatchSubscription(youtubeChannelId);
    setSubscriptions((prev) => prev.map((s) => (s.channelId === youtubeChannelId ? { ...s, already_watching: true } : s)));
  };

  return { ...state, subscriptions, loadingSubscriptions, connect, disconnect, watchChannel };
}
