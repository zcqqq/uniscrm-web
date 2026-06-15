import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface Plan {
  tier: string;
  name: string;
  price_monthly: number;
  currency: string;
}

interface SubscriptionState {
  tier: string;
  status: string;
  subscription: {
    id: string;
    current_period_end: string | null;
    cancel_at_period_end: number;
  } | null;
}

export function useBilling() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [plansRes, subRes] = await Promise.all([
      api.billing.getPlans(),
      api.billing.getSubscription(),
    ]);
    setPlans(plansRes.plans);
    setSubscription(subRes);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const subscribe = async (tier: string) => {
    const { approval_url } = await api.billing.subscribe(tier);
    window.location.href = approval_url;
  };

  const cancel = async () => {
    await api.billing.cancel();
    await refresh();
  };

  const manageSubscription = async () => {
    const { portal_url } = await api.billing.portal();
    window.location.href = portal_url;
  };

  return { plans, subscription, loading, subscribe, cancel, manageSubscription, refresh };
}
