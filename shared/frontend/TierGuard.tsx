import { useEffect } from "react";
import { canAccessModule } from "../plans";
import { useTier } from "./useTier";
import { URLS } from "./urls";

interface TierGuardProps {
  module: string;
  children: React.ReactNode;
}

export function TierGuard({ module, children }: TierGuardProps) {
  const tier = useTier();
  const allowed = tier ? canAccessModule(tier, module) : true;

  useEffect(() => {
    if (!allowed) {
      window.location.href = `${URLS.web}/billing`;
    }
  }, [allowed]);

  if (!allowed) return null;
  return <>{children}</>;
}
