import { generatePeriodKeys, normalizeDate } from "./fill-time-series";
import type { IntervalPeriodStats } from "./api";

export type IntervalPeriodSlot = { period: string; stats: IntervalPeriodStats | null };

/**
 * Fills gaps in interval-analysis period stats so the chart always shows a
 * complete time axis (e.g. exactly 5 weekly slots for "Last 30 days" + Week),
 * mirroring how fillTimeSeries zero-fills Event Analytics data. Periods with
 * no pairs keep their period key (for axis labeling) but `stats: null`, so
 * the box plot can skip drawing a box for that column instead of rendering a
 * fabricated zero-value stat.
 */
export function fillIntervalPeriods(
  data: IntervalPeriodStats[],
  timeRange: string,
  granularity: string
): IntervalPeriodSlot[] {
  const keys = generatePeriodKeys(timeRange, granularity);
  if (!keys) return data.map((d) => ({ period: d.period, stats: d }));

  const dataMap = new Map<string, IntervalPeriodStats>();
  for (const d of data) {
    if (!d?.period) continue;
    const key = normalizeDate(d.period);
    if (key) dataMap.set(key, d);
  }

  return keys.map((key) => ({ period: key, stats: dataMap.get(key) || null }));
}
