import { useState, useEffect, useCallback } from "react";
import { api, type XUser } from "../lib/api";

export function useUsers(limit = 20) {
  const [users, setUsers] = useState<XUser[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await api.users.list(p, limit);
      setUsers(data.users);
      setPage(data.page);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch {
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { load(page); }, [load, page]);

  const nextPage = () => { if (page < totalPages) setPage(page + 1); };
  const prevPage = () => { if (page > 1) setPage(page - 1); };

  return { users, page, totalPages, total, loading, nextPage, prevPage };
}
