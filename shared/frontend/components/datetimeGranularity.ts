export type DatetimeGranularity = "none" | "hour" | "day" | "week" | "month" | "quarter";

// Suggests an initial granularity from a field's actual [min, max]
// timestamp span — used only to pre-select a radio the first time the
// popover opens for a dimension with no saved choice yet. Once the user
// picks (or confirms) an option, it becomes a fixed, persisted choice like
// any other config field; this function is never consulted again for that
// report.
//
// Kept in its own dependency-free .ts module (rather than inline in
// DatetimeDimensionPopover.tsx) so it can be unit-tested without pulling in
// the component's Radix Popover import chain, which the
// @cloudflare/vitest-pool-workers runtime cannot resolve (known issue:
// https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution).
export function suggestGranularity(min: string | null, max: string | null): DatetimeGranularity {
  if (!min || !max) return "none";
  const spanMs = new Date(max).getTime() - new Date(min).getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return "none";
  const day = 86400000;
  if (spanMs <= 2 * day) return "hour";
  if (spanMs <= 60 * day) return "day";
  if (spanMs <= 365 * day) return "week";
  if (spanMs <= 2 * 365 * day) return "month";
  return "quarter";
}
