// OAuth state storage — D1, not KV. KV is Cloudflare's globally eventually-consistent store:
// the /authorize request that writes a state and the /callback request that reads it back
// almost always land on different edge colos, and when the OAuth round trip is fast (the user
// already consented — no consent screen), the read can beat the write's cross-colo propagation.
// That produced a false "Invalid or expired state" on an otherwise legitimate login — retrying
// only "fixed" it because the retry walked a fresh authorize→callback round trip that happened
// to land after propagation caught up. D1 has one authoritative copy, so there is no such
// window. Same lesson as sessions (see shared/auth.ts's top-of-file comment): investigated for
// tenant 100005's 2026-08-21 signup failure report.
//
// tenant 100005's report was actually a FIRST-time Google signup (account chooser + consent
// screen, possibly the unverified-app warning) — the slow path, not the fast one the KV race
// above needs. A plain TTL-exceeded round trip is an equally live alternative explanation the
// D1 move alone would not fix, since D1 expires on the same clock. The TTL below is set with
// that in mind rather than trusting the KV story exclusively — a leaked, unconsumed state is
// single-use and tied to a PKCE code_verifier, so a longer window costs nothing.
//
// Untyped D1Like signature for the same reason as shared/auth.ts: shared/ has no node_modules of
// its own, so importing "@cloudflare/workers-types" here wouldn't resolve reliably against every
// consuming worker's build. Callers pass a real D1Database; duck-typed at runtime.

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

// Matches pending_oauth's existing TTL (web/worker/services/oauth.ts) rather than the old
// oauth_state KV entry's 300s — see the tenant-100005 note above.
const DEFAULT_TTL_SECONDS = 600;

// Stores an OAuth state blob with an expiry. Opportunistically prunes rows already past their
// expiry on the same write — cheap, and avoids a dedicated cron cleanup job for a table that
// only ever holds a handful of rows (one per in-flight OAuth redirect).
//
// expires_at is computed by SQLite itself (datetime('now', '+N seconds')), not by formatting a
// JS Date to ISO and binding it: `expires_at > datetime('now')` compares as plain text, and an
// ISO string ("...T12:00:00.000Z") is lexicographically GREATER than SQLite's own datetime()
// output ("...  12:00:00") for any same-day timestamp purely because 'T' > ' ' — a JS-side
// expiry would then never compare as expired until the calendar date itself rolls over,
// silently keeping every state alive far past its real TTL. Letting SQLite generate
// both sides guarantees identical formatting.
export async function storeOAuthState(db: D1Like, state: string, data: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  await db.prepare("DELETE FROM oauth_states WHERE expires_at <= datetime('now')").bind().run();
  // ttlSeconds is negative only in tests (simulating an already-expired row) — Number's own
  // toString() already carries the "-" for those, so prefixing "+" unconditionally would
  // produce the malformed modifier "+-1 seconds", which datetime() silently evaluates to NULL
  // (caught by the NOT NULL constraint, not a validation error — this shipped broken once).
  const sign = ttlSeconds < 0 ? "" : "+";
  await db
    .prepare("INSERT INTO oauth_states (state, data, expires_at) VALUES (?, ?, datetime('now', ?))")
    .bind(state, JSON.stringify(data), `${sign}${ttlSeconds} seconds`)
    .run();
}

// Reads and consumes (deletes) a state blob in one round trip via DELETE ... RETURNING — atomic,
// so unlike the KV get-then-delete this replaces, there is no window where two concurrent
// callback requests for the same state could both read it before either deletes it. Returns
// null for a missing, already-consumed, or expired state.
export async function consumeOAuthState<T = unknown>(db: D1Like, state: string): Promise<T | null> {
  const row = await db
    .prepare("DELETE FROM oauth_states WHERE state = ? AND expires_at > datetime('now') RETURNING data")
    .bind(state)
    .first<{ data: string }>();
  return row ? (JSON.parse(row.data) as T) : null;
}
