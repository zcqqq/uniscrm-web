import type { Session } from "../types";

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export class SessionService {
  constructor(private kv: KVNamespace) {}

  async create(userId: string, email: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const session: Session = {
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + SESSION_TTL * 1000).toISOString(),
    };
    await this.kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: SESSION_TTL,
    });
    return sessionId;
  }

  async get(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(`session:${sessionId}`);
    if (!data) return null;
    return JSON.parse(data) as Session;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
  }
}
