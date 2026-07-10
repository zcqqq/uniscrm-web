import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface CreditUsageEntry {
  id: string;
  tenant_id: number;
  flow_id: string | null;
  channel_id: string | null;
  action_event_type: string;
  credit_micros: number;
  created_at: string;
}

interface CreditUsageState {
  tier: string;
  monthlyCreditMicros: number;
  usedMicros: number;
  balanceMicros: number;
  periodStart: string | null;
  periodEnd: string | null;
  entries: CreditUsageEntry[];
  total: number;
}

const PAGE_SIZE = 50;

export function useCreditUsage() {
  const [usage, setUsage] = useState<CreditUsageState | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  const refresh = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await api.billing.getCreditUsage(PAGE_SIZE, p * PAGE_SIZE);
      setUsage(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh(page);
  }, [page, refresh]);

  return { usage, loading, page, setPage, pageSize: PAGE_SIZE, refresh: () => refresh(page) };
}
