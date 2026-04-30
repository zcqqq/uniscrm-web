import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { SyncResult } from "../lib/api";

export function useNotion() {
  const [connected, setConnected] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [folders, setFolders] = useState<{ id: string; title: string }[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api.notion.getStatus();
      setConnected(res.connected);
      setWorkspaceName(res.channel_name ?? null);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("notion") === "connected") {
      checkStatus();
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [checkStatus]);

  const startAuth = async () => {
    const { url } = await api.notion.getAuthUrl();
    window.location.href = url;
  };

  const loadFolders = async () => {
    const { folders: f } = await api.notion.getFolders();
    setFolders(f);

    const configRes = await api.channels.getConfig("NOTION");
    if (configRes.config && (configRes.config as { folder_ids?: string[] }).folder_ids) {
      setSelectedFolderIds((configRes.config as { folder_ids: string[] }).folder_ids);
    }
  };

  const saveSelection = async (folderIds: string[]) => {
    setSelectedFolderIds(folderIds);
    const res = await api.channels.saveConfig("NOTION", { folder_ids: folderIds });
    if ((res as { sync?: SyncResult }).sync) {
      setSyncResult((res as { sync: SyncResult }).sync);
    }
  };

  const triggerSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.notion.sync();
      setSyncResult(result);
    } finally {
      setSyncing(false);
    }
  };

  return {
    connected,
    workspaceName,
    folders,
    selectedFolderIds,
    syncing,
    syncResult,
    startAuth,
    loadFolders,
    saveSelection,
    triggerSync,
    checkStatus,
  };
}
