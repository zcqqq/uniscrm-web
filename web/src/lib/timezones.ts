// i18n-ok: IANA timezone identifiers below are technical data keys, not display text — the
// human-readable label is built at render time by getTimezoneLabel().
export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago", // i18n-ok: IANA timezone identifier, not display text
  "America/Denver", // i18n-ok: IANA timezone identifier, not display text
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London", // i18n-ok: IANA timezone identifier, not display text
  "Europe/Paris", // i18n-ok: IANA timezone identifier, not display text
  "Europe/Berlin", // i18n-ok: IANA timezone identifier, not display text
  "Europe/Moscow", // i18n-ok: IANA timezone identifier, not display text
  "Africa/Cairo", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Dubai", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Kolkata", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Bangkok", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Singapore", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Shanghai", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Tokyo", // i18n-ok: IANA timezone identifier, not display text
  "Asia/Seoul", // i18n-ok: IANA timezone identifier, not display text
  "Australia/Sydney", // i18n-ok: IANA timezone identifier, not display text
  "Pacific/Auckland", // i18n-ok: IANA timezone identifier, not display text
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
