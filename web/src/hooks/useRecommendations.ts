import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { useAuth } from "./useAuth";

interface RecommendationGroup {
  trend?: { id: string; title: string; platform: string; score: number; similarity: number };
  content?: { id: string; title: string; similarity: number };
  product?: { id: string; title: string; similarity: number };
  sort_score: number;
}

export function useRecommendations() {
  const { user } = useAuth();
  const [recommendations, setRecommendations] = useState<RecommendationGroup[]>([]);
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
