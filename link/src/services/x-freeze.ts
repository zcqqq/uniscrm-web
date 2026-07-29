// Account-freeze circuit breaker for X channels.
//
// When X locks or suspends the authorized personal account, it answers HTTP 403 with an
// `errors[].code` of 326 ("this account is temporarily locked"), 63 or 64 (suspended). Every
// further call made while the account is in that state risks lengthening the lock, so the first
// such response trips a per-channel breaker: the freeze is recorded on the channel and all X
// calls for it stop until the account comes back.
//
// Two deliberate constraints:
//
// 1. Only an explicit freeze code/message counts. A bare 403 must NEVER trip this — X answers
//    403 for ordinary refusals too (the bookmark endpoint does it for the retweet cap), and a
//    false positive silently pauses a live channel.
// 2. The breaker resets by itself. An hourly probe (GET /2/users/me, one call per frozen
//    channel) clears the flag as soon as the account answers again, so nothing has to be
//    un-paused by hand.
//
// State lives in channels.config JSON — no migration, and it stays orthogonal to `is_active`,
// which continues to mean "connected or not".

export interface XFreezeSignal {
  code: number;
  message: string;
}

// 326 = temporarily locked (the lock a user clears at x.com/account/access),
// 63 = user has been suspended, 64 = your account is suspended.
const FREEZE_CODES = new Set([326, 63, 64]);
const FREEZE_TEXT = /temporarily locked|account is suspended|has been suspended|account is temporarily/i;

interface XErrorBody {
  errors?: { code?: number; message?: string }[];
  detail?: string;
  title?: string;
}

/**
 * Returns the freeze signal when `status`/`body` say the authorized account is locked or
 * suspended, else null. `body` may be the raw response text or the already-parsed JSON.
 */
export function detectFreeze(status: number, body: string | unknown): XFreezeSignal | null {
  if (status !== 403) return null;

  let parsed: XErrorBody | null = null;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as XErrorBody;
    } catch {
      // Not JSON — fall back to matching the raw text below.
      return FREEZE_TEXT.test(body) ? { code: 0, message: body.slice(0, 300) } : null;
    }
  } else if (body && typeof body === "object") {
    parsed = body as XErrorBody;
  }
  if (!parsed) return null;

  for (const err of parsed.errors ?? []) {
    if (err.code != null && FREEZE_CODES.has(err.code)) {
      return { code: err.code, message: err.message ?? "" };
    }
  }

  const text = [parsed.detail, parsed.title, ...(parsed.errors ?? []).map((e) => e.message)]
    .filter(Boolean)
    .join(" ");
  return FREEZE_TEXT.test(text) ? { code: 0, message: text.slice(0, 300) } : null;
}

export interface FrozenState {
  frozenAt: string;
  code: number;
  message: string;
}

/** Reads the freeze state off a parsed channel config, or null when the channel is fine. */
export function readFrozenState(config: Record<string, unknown> | null | undefined): FrozenState | null {
  const at = config?.x_frozen_at;
  if (typeof at !== "string" || !at) return null;
  return {
    frozenAt: at,
    code: typeof config?.x_frozen_code === "number" ? (config.x_frozen_code as number) : 0,
    message: typeof config?.x_frozen_message === "string" ? (config.x_frozen_message as string) : "",
  };
}

/**
 * The single wording every caller reports — flow writes it to the node's failure_reason, so it
 * has to say which account state caused the stop, not just "X error".
 */
export function frozenReason(state: { code: number; message: string; frozenAt?: string }): string {
  const code = state.code ? ` [${state.code}]` : "";
  const since = state.frozenAt ? ` since ${state.frozenAt}` : "";
  const detail = state.message ? ` — ${state.message}` : "";
  return `channel_frozen: X locked this account${code}${since}${detail}`.slice(0, 400);
}

/**
 * Records the freeze, keeping the FIRST observed timestamp (so "frozen since" stays honest
 * across repeated hits). Written with json_set rather than read-modify-write on the whole
 * config: XTokenService rewrites config wholesale on every token refresh, and a concurrent
 * refresh would otherwise clobber the flag (or be clobbered by it).
 */
export async function markChannelFrozen(db: D1Database, channelId: string, signal: XFreezeSignal): Promise<void> {
  await db
    .prepare(
      `UPDATE channels
          SET config = json_set(config, '$.x_frozen_at', ?, '$.x_frozen_code', ?, '$.x_frozen_message', ?),
              updated_at = datetime('now')
        WHERE id = ? AND json_extract(config, '$.x_frozen_at') IS NULL`
    )
    .bind(new Date().toISOString(), signal.code, signal.message.slice(0, 300), channelId)
    .run();

  console.error(JSON.stringify({ event: "x_channel_frozen", channel_id: channelId, code: signal.code, message: signal.message }));
}

export async function clearChannelFrozen(db: D1Database, channelId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE channels
          SET config = json_remove(config, '$.x_frozen_at', '$.x_frozen_code', '$.x_frozen_message'),
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(channelId)
    .run();

  console.log(JSON.stringify({ event: "x_channel_unfrozen", channel_id: channelId }));
}

/**
 * Trips the breaker when a response carries a freeze signal. Returns the signal so the caller
 * can answer with a reason instead of a generic X error.
 */
export async function recordXApiResult(
  db: D1Database,
  channelId: string,
  status: number,
  body: string | unknown
): Promise<XFreezeSignal | null> {
  const signal = detectFreeze(status, body);
  if (signal) await markChannelFrozen(db, channelId, signal);
  return signal;
}
