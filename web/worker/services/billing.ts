export interface PlanInfo {
  tier: string;
  name: string;
  price_monthly: number;
  currency: string;
}

export interface SubscriptionInfo {
  tier: string;
  status: string;
  subscription: {
    id: string;
    stripe_subscription_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: number;
  } | null;
}

export class BillingService {
  constructor(
    private adminUrl: string,
    private internalSecret: string
  ) {}

  async getPlans(): Promise<PlanInfo[]> {
    const res = await fetch(`${this.adminUrl}/internal/plans`, {
      headers: { "X-Internal-Secret": this.internalSecret },
    });
    if (!res.ok) throw new Error("Failed to fetch plans");
    const data = (await res.json()) as { plans: PlanInfo[] };
    return data.plans;
  }

  async getSubscription(tenantId: string): Promise<SubscriptionInfo> {
    const res = await fetch(`${this.adminUrl}/internal/subscription/${tenantId}`, {
      headers: { "X-Internal-Secret": this.internalSecret },
    });
    if (!res.ok) throw new Error("Failed to fetch subscription");
    return res.json() as Promise<SubscriptionInfo>;
  }

  async createSubscription(
    tenantId: string,
    tier: string,
    returnUrl: string,
    cancelUrl: string
  ): Promise<{ approval_url: string }> {
    const res = await fetch(`${this.adminUrl}/internal/subscriptions/create`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": this.internalSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: tenantId, tier, return_url: returnUrl, cancel_url: cancelUrl }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error: string };
      throw new Error(err.error);
    }
    return res.json() as Promise<{ approval_url: string }>;
  }

  async cancelSubscription(tenantId: string): Promise<void> {
    const res = await fetch(`${this.adminUrl}/internal/subscriptions/cancel`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": this.internalSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: tenantId }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error: string };
      throw new Error(err.error);
    }
  }

  async createPortalSession(tenantId: string, returnUrl: string): Promise<{ portal_url: string }> {
    const res = await fetch(`${this.adminUrl}/internal/portal/create`, {
      method: "POST",
      headers: {
        "X-Internal-Secret": this.internalSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: tenantId, return_url: returnUrl }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error: string };
      throw new Error(err.error);
    }
    return res.json() as Promise<{ portal_url: string }>;
  }
}
