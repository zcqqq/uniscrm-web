import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface YouTubeAccountState {
  connected: boolean;
  email?: string;
  channelTitle?: string;
  syncStatus?: "pending" | "done" | "error";
  subscriptionCount: number;
  createdAt?: string;
  loading: boolean;
}

// The OAuth callback cannot render anything itself — it is a top-level redirect back into the
// SPA — so a refused connect arrives as ?youtube_error=<reason> on the landing URL. Read it
// once on mount and strip it, so the message shows on arrival but does not survive a refresh
// or outlive a later successful connect.
function takeConnectError(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const reason = params.get("youtube_error");
  if (!reason) return null;
  params.delete("youtube_error");
  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  return reason;
}

export function useYouTubeAccount() {
  const [state, setState] = useState<YouTubeAccountState>({ connected: false, subscriptionCount: 0, loading: true });
  const [connectError, setConnectError] = useState<string | null>(() => takeConnectError());

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.channels.youtubeStatus();
      setState({
        connected: data.connected,
        email: data.email,
        channelTitle: data.channel_title,
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
    setConnectError(null);
    window.location.href = "/api/auth/youtube/connect";
  };

  const disconnect = async () => {
    await api.channels.simpleDisconnect("youtube_account");
    setState({ connected: false, subscriptionCount: 0, loading: false });
  };

  return { ...state, connectError, connect, disconnect };
}
