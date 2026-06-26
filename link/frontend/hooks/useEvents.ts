import { useState, useCallback } from "react";
import { api, type XEvent } from "../lib/api";

export function useEvents(userId: string, pageSize = 100) {
  const [events, setEvents] = useState<XEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.users.events(userId, 0, pageSize);
      setEvents(data.events);
      setHasMore(data.hasMore);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [userId, pageSize]);

  const loadMore = async () => {
    const data = await api.users.events(userId, events.length, pageSize);
    setEvents([...events, ...data.events]);
    setHasMore(data.hasMore);
  };

  useState(() => { load(); });

  return { events, hasMore, loading, loadMore };
}
