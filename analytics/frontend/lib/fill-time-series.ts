export function fillTimeSeries(
  data: { period: string; value: number }[],
  timeRange: string,
  granularity: string
): { period: string; value: number }[] {
  if (granularity === "total" || granularity === "hour" || granularity === "weekday") {
    return data;
  }

  const days = parseTimeRangeDays(timeRange);
  if (!days) return data;

  // Use UTC dates throughout — API periods are UTC midnight timestamps
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let start = new Date(end.getTime() - days * 86400000);

  // Backend uses DATE_TRUNC('week', ...) which aligns to Monday (ISO week).
  // Align our fill start to the same Monday boundary so generated keys match API periods.
  if (granularity === "week") {
    const dow = start.getUTCDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    start = new Date(start.getTime() - daysSinceMonday * 86400000);
  } else if (granularity === "month") {
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  }

  const dataMap = new Map<string, number>();
  for (const d of data) {
    if (!d?.period) continue;
    const key = normalizeDate(d.period);
    if (key) dataMap.set(key, (dataMap.get(key) || 0) + (d.value || 0));
  }

  const filled: { period: string; value: number }[] = [];
  const current = new Date(start);

  while (current <= end) {
    const key = current.toISOString().slice(0, 10);
    filled.push({ period: key, value: dataMap.get(key) || 0 });

    if (granularity === "week") {
      current.setUTCDate(current.getUTCDate() + 7);
    } else if (granularity === "month") {
      current.setUTCMonth(current.getUTCMonth() + 1);
    } else {
      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  return filled;
}

function normalizeDate(period: string): string {
  if (!period) return "";
  const cleaned = period.replace(/(\.\d{3})\d+Z$/, "$1Z");
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return period.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function parseTimeRangeDays(timeRange: string): number | null {
  const num = parseInt(timeRange);
  if (!isNaN(num)) return num;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  switch (timeRange) {
    case "today": return 1;
    case "yesterday": return 2;
    case "thisWeek": return today.getDay() || 7;
    case "lastWeek": return (today.getDay() || 7) + 7;
    case "thisMonth": return today.getDate();
    case "lastMonth": {
      const prev = new Date(today);
      prev.setMonth(prev.getMonth() - 1);
      return Math.round((today.getTime() - prev.getTime()) / 86400000) + today.getDate();
    }
    default: return null;
  }
}
