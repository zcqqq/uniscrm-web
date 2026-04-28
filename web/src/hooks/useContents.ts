import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ParsedMd } from "../lib/markdown";

interface ContentItem {
  id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: string;
  file_modified_at: string | null;
  created_at: string;
}

export function useContents() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.contents.list();
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const importFiles = async (parsed: ParsedMd[]) => {
    const mapped = parsed.map((p) => ({
      filename: p.filename,
      title: p.title,
      summary: p.summary,
      file_modified_at: p.fileModifiedAt,
    }));
    await api.contents.import(mapped);
    await refresh();
  };

  const updateItem = async (id: string, fields: { title?: string; summary?: string; status?: string }) => {
    await api.contents.update(id, fields);
    await refresh();
  };

  const deleteItem = async (id: string) => {
    await api.contents.delete(id);
    await refresh();
  };

  return { items, loading, refresh, importFiles, updateItem, deleteItem };
}
