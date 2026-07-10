// Credit accounting is done in integer "micros" (1,000,000 micros = $1) to avoid
// floating point rounding errors (data accuracy > everything else per project convention).
export const MICROS_PER_DOLLAR = 1_000_000;

export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * MICROS_PER_DOLLAR);
}

export function microsToDollars(micros: number): number {
  return micros / MICROS_PER_DOLLAR;
}

function daysInMonth(year: number, month: number): number {
  // month is 0-indexed (JS Date convention)
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Computes the current monthly credit period [start, end) for a tenant, anchored to the
 * day-of-month (and time) of `anchorIso` (typically the subscription's created_at, in UTC).
 * The period rolls forward on the same calendar day each month; if the target month is
 * shorter than the anchor day, it clamps to the last day of that month, then "jumps back"
 * to the anchor day as soon as a month long enough occurs again.
 * Example: anchor day 31 -> Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 ...
 */
export function getCreditPeriod(anchorIso: string, now: Date = new Date()): { start: Date; end: Date } {
  const anchor = new Date(anchorIso);
  const anchorY = anchor.getUTCFullYear();
  const anchorM = anchor.getUTCMonth();
  const anchorD = anchor.getUTCDate();
  const anchorTimeMs =
    anchor.getUTCHours() * 3_600_000 +
    anchor.getUTCMinutes() * 60_000 +
    anchor.getUTCSeconds() * 1_000 +
    anchor.getUTCMilliseconds();

  function periodBoundary(k: number): Date {
    const totalMonth = anchorM + k;
    const year = anchorY + Math.floor(totalMonth / 12);
    const month = ((totalMonth % 12) + 12) % 12;
    const day = Math.min(anchorD, daysInMonth(year, month));
    return new Date(Date.UTC(year, month, day) + anchorTimeMs);
  }

  let k = (now.getUTCFullYear() - anchorY) * 12 + (now.getUTCMonth() - anchorM);
  while (periodBoundary(k) > now) k--;
  while (periodBoundary(k + 1) <= now) k++;

  return { start: periodBoundary(k), end: periodBoundary(k + 1) };
}
