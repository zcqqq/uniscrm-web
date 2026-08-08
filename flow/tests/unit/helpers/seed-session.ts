// Seeds a valid session row into the WEB_DB test binding. flow's authMiddleware now
// resolves sessions from WEB_DB via shared/auth.ts instead of fetching web's /api/auth/me,
// so tests authenticate by inserting a row here and sending `Cookie: session=<id>`.
// vitest-pool-workers does not auto-apply web's migrations — create the table by hand,
// matching the columns shared/auth.ts selects. Use a session id unique to the calling test
// file (e.g. `sess-<tenant>`), mirroring the per-file tenant-id convention already used for
// FLOW_DB fixtures.
export async function seedSession(
  env: { WEB_DB: D1Database },
  sessionId: string,
  tenantId: number,
  memberId = "m1",
): Promise<void> {
  await env.WEB_DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
       id TEXT PRIMARY KEY,
       member_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL,
       email TEXT NOT NULL DEFAULT '',
       language TEXT NOT NULL DEFAULT 'en',
       expires_at TEXT NOT NULL
     )`
  ).run();
  const future = new Date(Date.now() + 86400000).toISOString();
  await env.WEB_DB.prepare(
    `INSERT OR REPLACE INTO sessions (id, member_id, tenant_id, email, language, expires_at) VALUES (?, ?, ?, 'test@example.com', 'en', ?)`
  ).bind(sessionId, memberId, tenantId, future).run();
}
