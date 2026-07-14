export function formatDateTime(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(utcISO));
}

export function formatDate(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    dateStyle: "medium",
  }).format(new Date(utcISO));
}

// timeStyle: "medium" includes seconds (vs "short", which only shows HH:MM).
export function formatTime(utcISO: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    timeStyle: "medium",
  }).format(new Date(utcISO));
}
