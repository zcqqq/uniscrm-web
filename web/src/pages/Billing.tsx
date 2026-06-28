import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useBilling } from "../hooks/useBilling";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../../shared/frontend/ui/card";
import { Badge } from "../../../shared/frontend/ui/badge";
import { isActive, TIERS } from "../../../shared/plans";
import type { SubStatus } from "../../../shared/plans";

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

  const rawTier = subscription?.tier;
  const currentTier = rawTier === "basic" || rawTier === "pro" ? rawTier : undefined;
  const status = (subscription?.status ?? "expired") as SubStatus;
  const locked = !isActive(status);

  if (locked) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <h1 className="text-2xl font-bold text-foreground mb-2">Billing</h1>
        <div className="mt-8 p-8 border border-destructive/30 bg-destructive/5 rounded-lg text-center">
          <h2 className="text-xl font-semibold text-foreground mb-2">Your trial has expired</h2>
          <p className="text-muted-foreground mb-6">Subscribe to continue using UniSCRM.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
            {plans.map((plan) => (
              <Card key={plan.tier}>
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                  <div className="mt-2">
                    <span className="text-3xl font-bold">${(plan.price_monthly / 100).toFixed(0)}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {(TIERS[plan.tier as keyof typeof TIERS]?.descriptions ?? []).map((f) => (
                      <li key={f} className="text-sm text-muted-foreground flex gap-2">
                        <span className="text-green-500">✓</span>{f}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button className="w-full" onClick={() => subscribe(plan.tier)}>Subscribe</Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

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

      {currentTier && <Card className="mb-8">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">
                  {plans.find((p) => p.tier === currentTier)?.name ?? currentTier}{status === "trialing" ? " Trial" : ""}
                </span>
                <Badge variant={status === "active" ? "default" : "secondary"} className="text-xs">
                  {status === "trialing" ? "Trial" : status === "active" ? "Active" : "Past Due"}
                </Badge>
              </div>
              {subscription?.subscription?.current_period_end && (
                <p className="text-sm text-muted-foreground">
                  {status === "trialing" ? "Trial expires" : "Next billing date"}:{" "}
                  {new Date(subscription.subscription.current_period_end).toLocaleDateString()}
                </p>
              )}
            </div>
            {subscription?.subscription?.stripe_subscription_id && (
              <Button variant="outline" size="sm" onClick={manageSubscription}>
                Invoices & payment
              </Button>
            )}
          </div>
        </CardContent>
      </Card>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl">
        {plans.map((plan) => {
          const isCurrent = currentTier === plan.tier;
          const features = TIERS[plan.tier as keyof typeof TIERS]?.descriptions ?? [];

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
                      {status === "trialing" ? `${plan.name} Trial` : "Current Plan"}
                    </Badge>
                    {status === "trialing" && subscription?.subscription?.current_period_end && (
                      <p className="text-xs text-muted-foreground">
                        Expires: {new Date(subscription.subscription.current_period_end).toLocaleDateString()}
                      </p>
                    )}
                    {status === "trialing" && (
                      <Button className="w-full" size="sm" onClick={() => subscribe(plan.tier)}>
                        Subscribe to keep {plan.name}
                      </Button>
                    )}
                    {status === "active" && (
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
                    {currentTier === "basic" ? "Upgrade" : "Subscribe"}
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
