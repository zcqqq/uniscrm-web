import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useBilling } from "../hooks/useBilling";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../../shared/frontend/ui/card";
import { Badge } from "../../../shared/frontend/ui/badge";

const TIER_FEATURES: Record<string, string[]> = {
  free: ["Basic recommendations", "1 linked account", "Community support"],
  pro: ["Advanced recommendations", "5 linked accounts", "Priority support", "Content analytics"],
  enterprise: ["Unlimited recommendations", "Unlimited accounts", "Dedicated support", "Custom integrations", "API access"],
};

export function Billing() {
  const { plans, subscription, loading, subscribe, cancel, manageSubscription } = useBilling();
  const [searchParams] = useSearchParams();
  const success = searchParams.get("success");
  const cancelled = searchParams.get("cancelled");

  useEffect(() => {
    if (success || cancelled) {
      window.history.replaceState({}, "", "/billing");
    }
  }, [success, cancelled]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  const currentTier = subscription?.tier ?? "free";

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold text-foreground mb-2">Billing</h1>
      <p className="text-muted-foreground mb-8">Manage your subscription plan</p>

      {success && (
        <div className="mb-6 p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-md text-green-800 dark:text-green-200 text-sm">
          Subscription activated successfully!
        </div>
      )}
      {cancelled && (
        <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded-md text-yellow-800 dark:text-yellow-200 text-sm">
          Subscription was not completed.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => {
          const isCurrent = currentTier === plan.tier;
          const features = TIER_FEATURES[plan.tier] ?? [];

          return (
            <Card key={plan.tier} className={isCurrent ? "border-primary ring-1 ring-primary/20" : ""}>
              <CardHeader>
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                <div className="mt-2">
                  <span className="text-3xl font-bold text-foreground">
                    ${(plan.price_monthly / 100).toFixed(0)}
                  </span>
                  <span className="text-muted-foreground">/mo</span>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-2">
                  {features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="text-green-500 dark:text-green-400 mt-0.5">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter className="flex-col gap-2">
                {isCurrent ? (
                  <>
                    <Badge variant="secondary" className="bg-primary/10 text-primary border-0">
                      {subscription?.status === "trialing" ? "Pro Trial" : "Current Plan"}
                    </Badge>
                    {subscription?.status === "trialing" && subscription.subscription?.current_period_end && (
                      <p className="text-xs text-muted-foreground">
                        Expires: {new Date(subscription.subscription.current_period_end).toLocaleDateString()}
                      </p>
                    )}
                    {plan.tier !== "free" && subscription?.status === "trialing" && (
                      <Button className="w-full" size="sm" onClick={() => subscribe(plan.tier)}>
                        Subscribe to keep Pro
                      </Button>
                    )}
                    {plan.tier !== "free" && subscription?.status === "active" && (
                      <>
                        <Button variant="ghost" size="sm" onClick={manageSubscription}>
                          Manage subscription
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={cancel}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  <Button className="w-full" onClick={() => subscribe(plan.tier)}>
                    Subscribe
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
