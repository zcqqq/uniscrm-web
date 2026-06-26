export function formatDateTime(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(utcISO));
}

export function formatDate(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
  }).format(new Date(utcISO));
}

export function formatTime(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    timeStyle: "short",
  }).format(new Date(utcISO));
}
