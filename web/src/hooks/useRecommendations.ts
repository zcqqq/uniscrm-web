import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";

interface TrendMatch {
  trend_id: string;
  title: string;
  platform: string;
  location: string;
  similarity: number;
}

interface Recommendation {
  content_id: string;
  title: string;
  matches: TrendMatch[];
}

export function useRecommendations() {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.recommendations.get();
      setRecommendations(res.recommendations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, user?.preferred_location]);

  return { recommendations, loading, refresh };
}
