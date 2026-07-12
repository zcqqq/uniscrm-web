// Thrown by X API client functions (fetchFollowersPage, fetchPostsPage) on a 401
// response, distinct from generic failures so callers can force a token refresh
// and retry once instead of just logging and giving up for the tick.
export class XUnauthorizedError extends Error {}
