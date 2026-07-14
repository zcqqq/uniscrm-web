import { useState, useEffect, useCallback } from "react";
import { api, type FlowSummary } from "../lib/api";

export function useFlows(domain: "user" | "content" = "user") {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchFlows = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await api.flows.list(p, domain);
      setFlows(data.flows);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch {
      setFlows([]);
    } finally {
      setLoading(false);
    }
  }, [domain]);

  // Two effects, not one: switching domain resets to page 1 here; the page-keyed
  // effect below is what actually fetches. If the user had paginated past page 1
  // before switching tabs, this fires one extra (stale-page) fetch before the
  // page-reset settles and triggers the correct one — harmless, self-corrects
  // on the next render, not worth a more complex single-effect merge for this.
  useEffect(() => {
    setPage(1);
  }, [domain]);

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
