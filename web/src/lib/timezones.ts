export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function getTimezoneLabel(tz: string): string {
  try {
    // time-format-ok: renders the timezone picker label ("Asia/Shanghai (UTC+8)"), not a timestamp
    const formatter = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" });
    const parts = formatter.formatToParts(new Date());
    const offset = parts.find((p) => p.type === "timeZoneName")?.value || "";
    const utcOffset = offset.replace("GMT", "UTC");
    return `${tz.replace(/_/g, " ")} (${utcOffset})`;
  } catch {
    return tz.replace(/_/g, " ");
  }
}

// Signup stores whatever IANA zone the browser reported, which is often outside the shortlist
// above (e.g. Europe/Amsterdam). A <select> whose value matches no <option> silently falls back
// to the first one — the member would see "UTC" while the DB holds their real zone, and any
// later save from this page would then write that wrong UTC back.
export function timezoneOptions(current?: string): string[] {
  if (!current || COMMON_TIMEZONES.includes(current)) return COMMON_TIMEZONES;
  return [current, ...COMMON_TIMEZONES];
}
