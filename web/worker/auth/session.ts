import type { Session } from "../types";

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export class SessionService {
  constructor(private db: D1Database) {}

  async create(memberId: string, tenantId: number, email: string, language = "en"): Promise<string> {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL).toISOString();
    await this.db.prepare(
      "INSERT INTO sessions (id, member_id, tenant_id, email, language, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, memberId, tenantId, email, language, expiresAt).run();
    return id;
  }

  async get(sessionId: string): Promise<Session | null> {
    const row = await this.db.prepare(
      "SELECT member_id, tenant_id, email, language, expires_at FROM sessions WHERE id = ? AND expires_at > datetime('now')"
    ).bind(sessionId).first<{ member_id: string; tenant_id: number; email: string; language: string; expires_at: string }>();
    if (!row) return null;
    return { member_id: row.member_id, tenant_id: row.tenant_id, email: row.email, language: row.language, expires_at: row.expires_at };
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
}
