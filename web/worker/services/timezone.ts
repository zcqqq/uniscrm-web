export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Picks the timezone a brand-new member is created with. members.timezone is written once at
// signup and most members never open Settings, so this value is what every timestamp in the
// product renders in for them.
//
// The login page reports the browser's own IANA zone (Intl.DateTimeFormat) — the most accurate
// signal, but client-supplied, so it is validated before use. When it is missing (an entry point
// that never ran that JS, or an OAuth state predating this feature) Cloudflare's IP-derived
// request.cf.timezone stands in. UTC only when neither is usable.
export function resolveSignupTimezone(
  clientTimezone?: string | null,
  cfTimezone?: string | null
): string {
  if (clientTimezone && isValidTimezone(clientTimezone)) return clientTimezone;
  if (cfTimezone && isValidTimezone(cfTimezone)) return cfTimezone;
  return "UTC";
}

// Cloudflare fills request.cf on real edge requests; it is absent locally and in tests.
export function cfTimezone(req: Request): string | undefined {
  return (req as { cf?: { timezone?: string } }).cf?.timezone;
}
