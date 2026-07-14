// Non-locale-dependent, slash/dash numeric date formatting, shared by
// formatPeriod (the report's period axis/column) and AnalyticsDetail's
// DATETIME-dimension value renderer. See docs/superpowers/specs/
// 2026-07-14-datetime-display-formatting-design.md for the full rule set.

export type CompactDateUnit = "none" | "hour" | "day" | "week" | "month" | "quarter";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

interface DateParts {
  yy: number;
  M: number;
  D: number;
  h: number;
  m: number;
  s: number;
}

function getParts(iso: string, timezone: string): DateParts | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    yy: get("year") % 100,
    M: get("month"),
    D: get("day"),
    // Some environments render midnight as "24" under hour12: false.
    h: get("hour") % 24,
    m: get("minute"),
    s: get("second"),
  };
}

function currentYearInTimezone(timezone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).format(now)) % 100;
}

/**
 * Formats a single ISO timestamp as a compact, non-locale-dependent date
 * string: `M/D` (year omitted when it matches the current year) or
 * `yy/M/D`, with an `HH:MM:SS` time suffix for "hour"/"none". "month" and
 * "quarter" always include `yy` (a bare number or Q-label alone would be
 * ambiguous). "week" is not handled here — see formatCompactWeekRange.
 */
export function formatCompactDate(
  iso: string,
  unit: Exclude<CompactDateUnit, "week">,
  timezone: string,
  now: Date = new Date()
): string {
  const parts = getParts(iso, timezone);
  if (!parts) return iso;
  const currentYear = currentYearInTimezone(timezone, now);

  if (unit === "month") return `${pad2(parts.yy)}/${parts.M}`;
  if (unit === "quarter") return `${pad2(parts.yy)}/Q${Math.ceil(parts.M / 3)}`;

  const isThisYear = parts.yy === currentYear;
  const dateStr = isThisYear ? `${parts.M}/${parts.D}` : `${pad2(parts.yy)}/${parts.M}/${parts.D}`;

  if (unit === "day") return dateStr;

  // "hour" and "none" both append a full HH:MM:SS time component — hour's
  // minutes/seconds are always :00:00, by construction of the truncation.
  const timeStr = `${pad2(parts.h)}:${pad2(parts.m)}:${pad2(parts.s)}`;
  return `${dateStr} ${timeStr}`;
}

/**
 * Formats a week-granularity range: `startIso` is the week's start (Monday,
 * as produced by DATE_TRUNC('week', ...) or a period key); the end is
 * start + 6 days. Compresses to "M/D-D" within the same month, "M/D-M/D"
 * across months in the same year, and shows `yy` on both sides when the
 * range crosses a year boundary (the two ends are necessarily different
 * years, so omitting either would be ambiguous).
 */
export function formatCompactWeekRange(
  startIso: string,
  timezone: string,
  now: Date = new Date()
): string {
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return startIso;
  const end = new Date(start.getTime() + 6 * 86400000);
  const startParts = getParts(start.toISOString(), timezone);
  const endParts = getParts(end.toISOString(), timezone);
  if (!startParts || !endParts) return startIso;

  const sameYear = startParts.yy === endParts.yy;
  if (!sameYear) {
    return `${pad2(startParts.yy)}/${startParts.M}/${startParts.D}-${pad2(endParts.yy)}/${endParts.M}/${endParts.D}`;
  }

  const currentYear = currentYearInTimezone(timezone, now);
  const isThisYear = startParts.yy === currentYear;
  const prefix = isThisYear ? "" : `${pad2(startParts.yy)}/`;
  const sameMonth = startParts.M === endParts.M;

  if (sameMonth) return `${prefix}${startParts.M}/${startParts.D}-${endParts.D}`;
  return `${prefix}${startParts.M}/${startParts.D}-${endParts.M}/${endParts.D}`;
}
