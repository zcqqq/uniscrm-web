import { useState } from "react";
import type { Tier } from "../plans";

function getTierFromCookie(): Tier | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|; )tier=([^;]*)/);
  const v = match?.[1];
  return v === "basic" || v === "pro" ? v : undefined;
}

export function useTier(tierProp?: Tier): Tier | undefined {
  const [fetchedTier] = useState<Tier | undefined>(tierProp ?? getTierFromCookie());
  return tierProp ?? fetchedTier;
}
