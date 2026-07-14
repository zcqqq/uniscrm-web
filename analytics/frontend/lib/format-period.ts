import { formatCompactDate, formatCompactWeekRange } from "./format-compact-date";

/**
 * Formats a period key (bare "YYYY-MM-DD" or full ISO timestamp) for
 * display, shared between Analytics Detail (full width, plenty of room)
 * and Dashboard widgets (compact, tighter width). Week granularity renders
 * as a compressed range ("6/8-14") to make the 7-day bucket unambiguous;
 * every other granularity renders a single date via formatCompactDate.
 *
 * "hour"/"total" granularities intentionally render as a bare date, not a
 * date+time — this preserves the exact pre-existing display (which never
 * had a time component for any granularity) while only swapping out the
 * locale-dependent month-name formatting. "weekday" granularity values are
 * a raw day-of-week digit (0-6, from the backend's EXTRACT(DOW ...)), not a
 * parseable date at all — they fall through the isNaN check below to the
 * pre-existing p.slice(0, 10) fallback, unchanged.
 */
export function formatPeriod(
  p: unknown,
  granularity: string,
  timezone: string
): string {
  if (!p || typeof p !== "string") return String(p ?? "");
  try {
    const normalized = p.replace(/(\.\d{3})\d+Z$/, "$1Z");
    // Bare date strings (YYYY-MM-DD) must be parsed as UTC midnight
    const dateStr = normalized.includes("T") ? normalized : `${normalized}T00:00:00Z`;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return p.slice(0, 10);

    if (granularity === "week") {
      return formatCompactWeekRange(dateStr, timezone);
    }

    return formatCompactDate(dateStr, "day", timezone);
  } catch {
    return p.slice(0, 10);
  }
}
