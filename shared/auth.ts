// Session/tenant resolution and internal-secret auth, shared by every worker.
//
// Canonical semantics come from web's implementation (web/worker/auth/): the session
// cookie is looked up in WEB_DB's `sessions` table with the expiry check done in SQL
// (`expires_at > datetime('now')`). Sessions live in D1 ONLY — a past KV attempt caused
// silent write failures, never store sessions in KV. Every worker binds WEB_DB directly
// (module coupling through Cloudflare data components is this repo's blessed pattern),
// so no worker needs an HTTP hop to web's /api/auth/me to authenticate a request.
//
// Untyped `c`/db signatures deliberately avoid importing "hono" or workers-types here —
// shared/ has no node_modules of its own, so such imports would resolve against whichever
// consuming worker builds it, which isn't reliable (same rationale as plan-guard.ts).
// Callers pass a real Hono Context / D1Database; duck-typed at runtime.

export interface SharedSession {
  memberId: string;
  tenantId: number;
  email: string;
  language: string;
}

export interface AuthMePayload {
  member: { id: string; email: string; preferred_location: string; language: string; timezone: string };
  tenant: { id: number; email: string };
}

interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
}

// Replaces the byte-identical getCookieValue() copies that lived in content, analytics,
// insight-segment and flow. Takes the raw Cookie header (not a Request) so it is usable
// from both raw fetch handlers and Hono contexts.
export function getCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  const header = cookieHeader || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// One implementation of "who is this request?": cookie parse + D1 sessions read with the
// expiry check in SQL. Returns null for missing cookie, unknown session, or expired session.
export async function resolveSession(webDb: D1Like, cookieHeader: string | null | undefined): Promise<SharedSession | null> {
  const sessionId = getCookieValue(cookieHeader, "session");
  if (!sessionId) return null;
  const row = await webDb
    .prepare("SELECT member_id, tenant_id, email, language FROM sessions WHERE id = ? AND expires_at > datetime('now')")
    .bind(sessionId)
    .first<{ member_id: string; tenant_id: number; email: string; language: string }>();
  if (!row) return null;
  return { memberId: row.member_id, tenantId: row.tenant_id, email: row.email, language: row.language };
}

// The full /api/auth/me payload, exactly as web's route has always answered it: session
// lookup plus a fresh `members` read (language/timezone can change after login, so they must
// come from members, not from the session snapshot). Workers that used to proxy this route
// to web over HTTP now answer it locally with this. Null means 401.
export async function resolveAuthMe(webDb: D1Like, cookieHeader: string | null | undefined): Promise<AuthMePayload | null> {
  const session = await resolveSession(webDb, cookieHeader);
  if (!session) return null;
  const member = await webDb
    .prepare("SELECT id, tenant_id, email, preferred_location, language, timezone FROM members WHERE id = ?")
    .bind(session.memberId)
    .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string; timezone: string }>();
  if (!member) return null;
  return {
    member: {
      id: member.id,
      email: member.email,
      preferred_location: member.preferred_location,
      language: member.language || "en",
      timezone: member.timezone || "UTC",
    },
    tenant: { id: member.tenant_id, email: member.email },
  };
}

// Fail-closed X-Internal-Secret check, replacing the five per-worker copies. With
// INTERNAL_SECRET unset, `undefined !== undefined` would let header-less requests
// through — so an unset secret always rejects. `opts` exists only because link and
// content historically answer 403 {"error":"Forbidden"} while flow and admin answer
// 401 {"error":"Unauthorized"}; both are preserved to avoid breaking existing callers
// and tests, the default being the 401 shape.
export function createInternalAuthMiddleware(opts: { status?: number; error?: string } = {}) {
  const status = opts.status ?? 401;
  const error = opts.error ?? "Unauthorized";
  return async (c: any, next: () => Promise<void>) => {
    const secret = c.req.header("X-Internal-Secret");
    if (!c.env.INTERNAL_SECRET || secret !== c.env.INTERNAL_SECRET) {
      return c.json({ error }, status);
    }
    await next();
  };
}

// SPA login-redirect guard: HTML navigations to app pages bounce to web's /login unless the
// request carries a valid session. Replaces the four copies in content/analytics/
// insight-segment/flow's fetch handlers. Non-HTML requests and excluded path prefixes pass
// through untouched (API routes answer 401 JSON themselves; content additionally excludes
// /internal and /public via `excludedPrefixes`). Returns the redirect Response, or null when
// the request should proceed.
export async function spaLoginGuard(
  request: { headers: { get(name: string): string | null }; url: string },
  webDb: D1Like,
  webUrl: string,
  excludedPrefixes: string[] = ["/api"],
): Promise<Response | null> {
  const accept = request.headers.get("Accept") || "";
  if (!accept.includes("text/html")) return null;
  const pathname = new URL(request.url).pathname;
  if (excludedPrefixes.some((prefix) => pathname.startsWith(prefix))) return null;
  const session = await resolveSession(webDb, request.headers.get("Cookie"));
  if (!session) return Response.redirect(`${webUrl}/login`, 302);
  return null;
}
