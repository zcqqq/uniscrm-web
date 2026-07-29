// Thrown by X API client functions (fetchFollowersPage, fetchPostsPage) on a 401
// response, distinct from generic failures so callers can force a token refresh
// and retry once instead of just logging and giving up for the tick.
export class XUnauthorizedError extends Error {}

// Thrown by the same client functions when X reports the authorized account itself is locked
// or suspended (403 + code 326/63/64 — see x-freeze.ts). Distinct from XUnauthorizedError
// because retrying with a fresh token cannot help: the caller must trip the freeze breaker and
// stop calling X for this channel until the account is back.
export class XAccountFrozenError extends Error {
  constructor(readonly signal: { code: number; message: string }) {
    super(`X account frozen [${signal.code}]: ${signal.message}`);
  }
}
