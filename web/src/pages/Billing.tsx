import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useBilling } from "../hooks/useBilling";
import { useAuth } from "../hooks/useAuth";
import { formatDate } from "../../../shared/frontend/lib/format-time";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "../../../shared/frontend/ui/card";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Alert, AlertDescription } from "../../../shared/frontend/ui/alert";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { isActive, getTierDescriptions } from "../../../shared/plans";
import type { SubStatus } from "../../../shared/plans";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export function Billing() {
  const T = useT();
  useEffect(() => { document.title = T({ en: "Billing — UniSCRM", zh: "账单 — UniSCRM" }); }, [T]);
  const { plans, subscription, loading, subscribe, cancel, manageSubscription, refresh } = useBilling();
  const { member } = useAuth();
  const timezone = member?.timezone || "UTC";
  const [searchParams] = useSearchParams();
  const success = searchParams.get("success");
  const cancelled = searchParams.get("cancelled");

  useEffect(() => {
    if (success || cancelled) {
      window.history.replaceState({}, "", "/billing");
    }
  }, [success, cancelled]);

  // Stripe's webhook updates the subscription asynchronously and can land after
  // the browser is already redirected back here, so the first fetch on mount may
  // still show the pre-upgrade (trialing) status. Poll briefly until it catches up.
  useEffect(() => {
    if (!success || subscription?.status !== "trialing") return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      refresh();
      if (attempts >= 5) clearInterval(interval);
    }, 1500);
    return () => clearInterval(interval);
  }, [success, subscription?.status, refresh]);

  useEffect(() => {
    if (subscription?.tier === "basic" || subscription?.tier === "pro") {
      document.cookie = `tier=${subscription.tier};path=/;max-age=${30*24*60*60};secure;samesite=lax;domain=uni-scrm.com`;
    }
  }, [subscription?.tier]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const rawTier = subscription?.tier;
  const currentTier = rawTier === "basic" || rawTier === "pro" ? rawTier : undefined;
  const status = (subscription?.status ?? "expired") as SubStatus;
  const locked = !isActive(status);

  if (locked) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <PageHeader title={T({ en: "Billing", zh: "账单" })} />
        <div className="mt-8 p-8 border border-destructive/30 bg-destructive/5 rounded-lg text-center">
          <h2 className="text-xl font-semibold text-foreground mb-2">{T({ en: "Your trial has expired", zh: "试用已到期" })}</h2>
          <p className="text-muted-foreground mb-6">{T({ en: "Subscribe to continue using UniSCRM.", zh: "订阅以继续使用 UniSCRM。" })}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
            {plans.map((plan) => (
              <Card key={plan.tier}>
                <CardHeader>
                  <CardTitle>{T(plan.name)}</CardTitle>
                  <div className="mt-2">
                    <span className="text-3xl font-bold">${(plan.price_monthly / 100).toFixed(0)}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {getTierDescriptions(plan.tier as "basic" | "pro").map((f, i) => (
                      <li key={i} className={`text-sm flex gap-2 ${f.isHeader ? "text-foreground font-medium mb-1" : "text-muted-foreground"}`}>
                        {!f.isHeader && <span className="text-primary">✓</span>}{T(f.text)}
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button className="w-full" onClick={() => subscribe(plan.tier)}>{T({ en: "Subscribe", zh: "订阅" })}</Button>
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
      <PageHeader title={T({ en: "Billing", zh: "账单" })} description={T({ en: "Manage your subscription plan", zh: "管理你的订阅套餐" })} />

      {success && (
        <Alert className="mb-6 border-primary/30 bg-primary/5 text-primary">
          <AlertDescription>{T({ en: "Subscription activated successfully!", zh: "订阅已成功开通！" })}</AlertDescription>
        </Alert>
      )}
      {cancelled && (
        <Alert className="mb-6 border-muted-foreground/30 bg-muted text-muted-foreground">
          <AlertDescription>{T({ en: "Subscription was not completed.", zh: "订阅未完成。" })}</AlertDescription>
        </Alert>
      )}

      {currentTier && <Card className="mb-8">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-foreground">
                  {(() => {
                    const currentPlanName = plans.find((p) => p.tier === currentTier)?.name;
                    return currentPlanName ? T(currentPlanName) : currentTier;
                  })()}{status === "trialing" ? T({ en: " Trial", zh: " 试用" }) : ""}
                </span>
                <Badge variant={status === "active" ? "default" : "secondary"} className="text-xs">
                  {status === "trialing" ? T({ en: "Trial", zh: "试用" }) : status === "active" ? T({ en: "Active", zh: "已激活" }) : T({ en: "Past Due", zh: "已逾期" })}
                </Badge>
              </div>
              {subscription?.subscription?.current_period_end && (
                <p className="text-sm text-muted-foreground">
                  {status === "trialing" ? T({ en: "Trial expires", zh: "试用到期" }) : T({ en: "Next billing date", zh: "下次账单日期" })}:{" "}
                  {formatDate(subscription.subscription.current_period_end, timezone)}
                </p>
              )}
            </div>
            {subscription?.subscription?.stripe_subscription_id && (
              <Button variant="outline" size="sm" onClick={manageSubscription}>
                {T({ en: "Invoices & payment", zh: "账单与付款" })}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl">
        {plans.map((plan) => {
          const isCurrent = currentTier === plan.tier;
          const features = getTierDescriptions(plan.tier as "basic" | "pro");
          const planName = T(plan.name);

          return (
            <Card key={plan.tier} className={isCurrent ? "border-primary ring-1 ring-primary/20" : ""}>
              <CardHeader>
                <CardTitle className="text-lg">{planName}</CardTitle>
                <div className="mt-2">
                  <span className="text-3xl font-bold text-foreground">
                    ${(plan.price_monthly / 100).toFixed(0)}
                  </span>
                  <span className="text-muted-foreground">/mo</span>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <ul className="space-y-2">
                  {features.map((f, i) => (
                    <li key={i} className={`flex items-start gap-2 text-sm ${f.isHeader ? "text-foreground font-medium mb-1" : "text-muted-foreground"}`}>
                      {!f.isHeader && <span className="text-primary mt-0.5">✓</span>}
                      {T(f.text)}
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter className="flex-col gap-2">
                {isCurrent ? (
                  <>
                    <Badge variant="secondary" className="bg-primary/10 text-primary border-0">
                      {status === "trialing" ? `${planName}${T({ en: " Trial", zh: " 试用" })}` : T({ en: "Current Plan", zh: "当前套餐" })}
                    </Badge>
                    {status === "trialing" && subscription?.subscription?.current_period_end && (
                      <p className="text-xs text-muted-foreground">
                        {T({ en: "Expires", zh: "到期" })}: {formatDate(subscription.subscription.current_period_end, timezone)}
                      </p>
                    )}
                    {status === "trialing" && (
                      <Button className="w-full" size="sm" onClick={() => subscribe(plan.tier)}>
                        {T({ en: "Subscribe to keep", zh: "续订以保留" })} {planName}
                      </Button>
                    )}
                    {status === "active" && (
                      <>
                        <Button variant="ghost" size="sm" onClick={manageSubscription}>
                          {T({ en: "Manage subscription", zh: "管理订阅" })}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={cancel}>
                          {T(C.cancel)}
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  <Button className="w-full" onClick={() => subscribe(plan.tier)}>
                    {currentTier === "basic" ? T({ en: "Upgrade", zh: "升级" }) : T({ en: "Subscribe", zh: "订阅" })}
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
