// Which top-level sidebar groups are expanded.
//
// Every module serves the sidebar from its own Worker on its own origin (link / web / flow /
// analytics / content / insight-segment). localStorage is scoped per origin, so keeping this
// state there gave each module a private copy: clicking Social > Users would jump from flow's
// remembered set to link's, and unrelated top-level groups appeared to expand or collapse on
// their own. A cookie on the shared parent domain keeps one state for the whole product —
// the same mechanism the collapsed/expanded sidebar width already uses.

export const SIDEBAR_GROUPS_COOKIE = "sidebar-groups";

// An empty selection must be storable on its own. Encoding it as an empty cookie value would
// read back as "nothing saved", and the default group would spring open again the moment the
// member collapsed the last one.
const EMPTY = "none";

// Returns null when the member has no stored preference yet, so the caller can apply its own
// default. An explicitly empty selection comes back as [].
export function parseGroupCookie(cookie: string): string[] | null {
  const match = cookie.match(/(?:^|;\s*)sidebar-groups=([^;]*)/);
  if (!match) return null;
  if (match[1] === EMPTY) return [];
  const ids = match[1].split(",").filter(Boolean);
  return ids.length ? ids : null;
}

export function groupCookieString(groups: string[]): string {
  const value = groups.length ? groups.join(",") : EMPTY;
  return `${SIDEBAR_GROUPS_COOKIE}=${value}; path=/; max-age=31536000; secure; samesite=lax; domain=uni-scrm.com`;
}
