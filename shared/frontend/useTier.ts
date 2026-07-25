import { useState } from "react";
import { LOWEST_TIER, parseTierCookie } from "../plans";
import type { Tier } from "../plans";

function getTierFromCookie(): Tier {
  if (typeof document === "undefined") return LOWEST_TIER;
  return parseTierCookie(document.cookie);
}

// Always resolves to a concrete tier: a missing or unrecognized cookie yields LOWEST_TIER
// rather than "unknown", so menu and route gating stays on instead of falling open.
export function useTier(tierProp?: Tier): Tier {
  const [fetchedTier] = useState<Tier>(tierProp ?? getTierFromCookie());
  return tierProp ?? fetchedTier;
}
