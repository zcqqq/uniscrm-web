// Unified timestamp display format (all modules must go through these helpers,
// enforced by scripts/time-format-audit.mjs):
//   date: M/D/YYYY (e.g. 7/24/2026) — fixed across all UI languages
//   time: HH:MM:SS, 24-hour, in the member's timezone setting
// Full timestamps render as two lines via <DateCell>; date-only business data
// (whole-day granularity) renders a single formatDate line.

// D1 columns hold either ISO-8601 ("2026-07-24T06:03:05.000Z") or SQLite
// datetime('now') output ("2026-07-24 06:03:05") — both UTC. Normalize the
// latter so every caller parses correctly.
function parseUtc(utcISO: string): Date {
  const normalized =
    utcISO.includes("T") || utcISO.endsWith("Z")
      ? utcISO
      : `${utcISO.replace(" ", "T")}Z`;
  return new Date(normalized);
}

export function formatDate(utcISO: string, timezone: string): string {
  const d = parseUtc(utcISO);
  if (isNaN(d.getTime())) return utcISO;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(d);
}

export function formatTime(utcISO: string, timezone: string): string {
  const d = parseUtc(utcISO);
  if (isNaN(d.getTime())) return utcISO;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

export function formatDateTime(utcISO: string, timezone: string): string {
  return `${formatDate(utcISO, timezone)} ${formatTime(utcISO, timezone)}`;
}
