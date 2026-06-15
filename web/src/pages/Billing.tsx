import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useBilling } from "../hooks/useBilling";

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
    return (
      <div className="min-h-screen flex items-center justify-center">Loading...</div>
    );
  }

  const currentTier = subscription?.tier ?? "free";

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-2">Billing</h1>
      <p className="text-gray-500 mb-8">Manage your subscription plan</p>

      {success && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md text-green-800">
          Subscription activated successfully!
        </div>
      )}
      {cancelled && (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-800">
          Subscription was not completed.
        </div>
      )}

      {subscription?.status === "cancelled" && (
        <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-md text-gray-700">
          Your subscription has been cancelled.
          {subscription.subscription?.current_period_end && (
            <span> Access continues until {new Date(subscription.subscription.current_period_end).toLocaleDateString()}.</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => {
          const isCurrent = currentTier === plan.tier;
          const features = TIER_FEATURES[plan.tier] ?? [];

          return (
            <div
              key={plan.tier}
              className={`border rounded-lg p-6 flex flex-col ${isCurrent ? "border-blue-500 ring-2 ring-blue-100" : "border-gray-200"}`}
            >
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <div className="mt-2 mb-4">
                <span className="text-3xl font-bold">
                  ${(plan.price_monthly / 100).toFixed(0)}
                </span>
                <span className="text-gray-500">/mo</span>
              </div>

              <ul className="flex-1 space-y-2 mb-6">
                {features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                    <span className="text-green-500 mt-0.5">&#10003;</span>
                    {f}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <div className="text-center">
                  <span className="inline-block px-4 py-2 bg-blue-50 text-blue-700 rounded-md text-sm font-medium">
                    Current Plan
                  </span>
                  {plan.tier !== "free" && subscription?.status === "active" && (
                    <>
                      <button
                        onClick={manageSubscription}
                        className="mt-3 block w-full text-sm text-blue-600 hover:text-blue-800"
                      >
                        Manage subscription
                      </button>
                      <button
                        onClick={cancel}
                        className="mt-2 block w-full text-sm text-red-600 hover:text-red-800"
                      >
                        Cancel subscription
                      </button>
                    </>
                  )}
                </div>
              ) : plan.tier === "free" ? null : (
                <button
                  onClick={() => subscribe(plan.tier)}
                  className="w-full py-2 px-4 bg-black text-white rounded-md hover:bg-gray-800 text-sm font-medium"
                >
                  {currentTier === "free" ? "Subscribe" : "Switch to " + plan.name}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
