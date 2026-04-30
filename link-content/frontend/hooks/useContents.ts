import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ContentItem } from "../lib/api";
import type { ParsedMd } from "../lib/markdown";

export function useContents() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (channelType?: string) => {
    setLoading(true);
    try {
      const res = await api.contents.list(channelType);
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const importFiles = async (parsed: ParsedMd[]) => {
    const mapped = parsed.map((p) => ({
      channel_source_id: p.filename,
      title: p.title,
      summary: p.summary,
      source_url: null,
      source_modified_at: p.fileModifiedAt,
    }));
    await api.contents.sync("LOCAL", mapped);
    await refresh();
  };

  const updateItem = async (
    id: string,
    fields: { title?: string; summary?: string; status?: string }
  ) => {
    await api.contents.update(id, fields);
    await refresh();
  };

  const deleteItem = async (id: string) => {
    await api.contents.delete(id);
    await refresh();
  };

  return { items, loading, refresh, importFiles, updateItem, deleteItem };
}
