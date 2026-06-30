import { useState, useEffect, useCallback } from "react";
import { api, type FlowSummary } from "../lib/api";

export function useFlows() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchFlows = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await api.flows.list(p);
      setFlows(data.flows);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch {
      setFlows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFlows(page);
  }, [page, fetchFlows]);

  const createFlow = async (name?: string, graphJson?: string) => {
    const data = await api.flows.create(name, graphJson);
    return data.flow;
  };

  const deleteFlow = async (id: string) => {
    await api.flows.delete(id);
    await fetchFlows(page);
  };

  return { flows, loading, page, total, totalPages, setPage, createFlow, deleteFlow, refresh: () => fetchFlows(page) };
}
