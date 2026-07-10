/**
 * Formats a period key (bare "YYYY-MM-DD" or full ISO timestamp) for display,
 * shared between Analytics Detail (full width, plenty of room) and Dashboard
 * widgets (compact, tighter width). Week granularity renders as a range
 * ("Jun 22 – Jun 28") to make the 7-day bucket unambiguous; every other
 * granularity renders a single date.
 */
export function formatPeriod(
  p: unknown,
  granularity: string,
  locale: string,
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
      const weekEnd = new Date(d.getTime() + 6 * 86400000);
      const localeTag = locale === "zh" ? "zh-CN" : "en-US";
      const fmt = (dt: Date) =>
        dt.toLocaleDateString(localeTag, {
          timeZone: "UTC",
          month: "short",
          day: "numeric",
        });
      const sameMonth = d.getUTCFullYear() === weekEnd.getUTCFullYear() && d.getUTCMonth() === weekEnd.getUTCMonth();
      if (sameMonth) {
        const startDay = d
          .toLocaleDateString(localeTag, { timeZone: "UTC", day: "numeric" })
          .replace(/\D/g, "");
        const endStr = fmt(weekEnd);
        // en-US: "Jun 14" -> take out "14" and prefix "Jun 8-"; zh-CN: "6月14日" -> insert "8-" before "14日"
        if (locale === "zh") {
          return endStr.replace(/(\d+)(?=日$)/, `${startDay}-$1`);
        }
        return endStr.replace(/(\d+)$/, `${startDay}-$1`);
      }
      return `${fmt(d)} – ${fmt(weekEnd)}`;
    }

    return d.toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { timeZone: timezone, month: "short", day: "numeric" });
  } catch {
    return p.slice(0, 10);
  }
}
