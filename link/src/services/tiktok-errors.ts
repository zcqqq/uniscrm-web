// Thrown by TikTok API client functions (fetchVideoListPage) when TikTok reports
// body.error.code === "access_token_invalid", distinct from generic failures so
// callers can force a token refresh and retry once instead of just logging and
// giving up for the tick. Mirrors XUnauthorizedError (x-errors.ts).
export class TikTokUnauthorizedError extends Error {}
