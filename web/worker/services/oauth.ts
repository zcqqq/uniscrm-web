import { normalizeEmail } from "./email-identity";

export interface OAuthState {
  codeVerifier: string;
  mode: "login" | "link" | "channel";
  userId?: string;
  trial?: string;
  timezone?: string;
}

export interface PendingOAuthData {
  provider: string;
  providerUserId: string;
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: string;
  // Carried over from OAuthState so the member finally created in /auth/verify-code keeps the
  // zone captured when the user clicked "Continue with X", not a hardcoded default.
  timezone?: string;
}

export interface ResolveUserResult {
  memberId: string;
  tenantId: number;
  isNew: boolean;
}

export interface LinkedAccount {
  provider: string;
  created_at: string;
}

export class OAuthService {
  constructor(
    private db: D1Database,
    private kv: KVNamespace
  ) {}

  async storeState(state: string, data: OAuthState): Promise<void> {
    await this.kv.put(`oauth_state:${state}`, JSON.stringify(data), {
      expirationTtl: 300,
    });
  }

  async getState(state: string): Promise<OAuthState | null> {
    const raw = await this.kv.get(`oauth_state:${state}`);
    if (!raw) return null;
    await this.kv.delete(`oauth_state:${state}`);
    return JSON.parse(raw) as OAuthState;
  }

  async resolveUser(
    provider: string,
    providerUserId: string,
    email: string | null,
    timezone = "UTC"
  ): Promise<ResolveUserResult> {
    const existing = await this.db
      .prepare(
        "SELECT member_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
      )
      .bind(provider, providerUserId)
      .first<{ member_id: string }>();

    if (existing) {
      const member = await this.db
        .prepare("SELECT tenant_id FROM members WHERE id = ?")
        .bind(existing.member_id)
        .first<{ tenant_id: number }>();
      return { memberId: existing.member_id, tenantId: member!.tenant_id, isNew: false };
    }

    const normalizedEmail = email ? normalizeEmail(email) : null;

    if (normalizedEmail) {
      const memberByEmail = await this.db
        .prepare("SELECT id, tenant_id FROM members WHERE email = ?")
        .bind(normalizedEmail)
        .first<{ id: string; tenant_id: number }>();

      if (memberByEmail) {
        await this.db
          .prepare(
            "INSERT INTO oauth_accounts (provider, provider_user_id, member_id, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(provider, providerUserId, memberByEmail.id, memberByEmail.tenant_id, new Date().toISOString())
          .run();

        return { memberId: memberByEmail.id, tenantId: memberByEmail.tenant_id, isNew: false };
      }
    }

    const memberId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare("INSERT INTO tenants (email, created_at) VALUES (?, ?)")
      .bind(normalizedEmail, now)
      .run();
    const tenant = await this.db
      .prepare("SELECT tenant_id FROM tenants WHERE email = ?")
      .bind(normalizedEmail)
      .first<{ tenant_id: number }>();
    const tenantId = tenant!.tenant_id;

    let winnerId: string = memberId;
    let winnerTenantId: number = tenantId;
    let isNew = true;
    try {
      await this.db
        .prepare("INSERT INTO members (id, tenant_id, email, preferred_location, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(memberId, tenantId, normalizedEmail, "global", timezone, now)
        .run();
    } catch (e) {
      // members.email 上的唯一索引堵住了上面那次「按邮箱查无此人」与这次 INSERT 之间的窗口。并发
      // 走到这里的两个请求（两个 OAuth 登录，或者一个 OAuth 一个 magic link）用同一个邮箱时，慢的
      // 这个请求会到这里；重新读出先赢的那一行继续走完登录，而不是把 500 丢给用户。上面那条
      // tenants INSERT 已经落库了，会留下一行没人引用的 tenant——在这个极窄的竞态里宁可留个孤儿
      // 行，也不能让同一个邮箱存在两个 member。isNew 必须报 false：调用方（oauth.ts 的三个回调）
      // 靠这个字段决定要不要再发一遍 provision-db / activate-trial，输的一方绝不能重新触发。
      const raced = await this.db
        .prepare("SELECT id, tenant_id FROM members WHERE email = ?")
        .bind(normalizedEmail)
        .first<{ id: string; tenant_id: number }>();
      if (!raced) throw e;
      winnerId = raced.id;
      winnerTenantId = raced.tenant_id;
      isNew = false;
    }

    await this.db
      .prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, member_id, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(provider, providerUserId, winnerId, winnerTenantId, now)
      .run();

    return { memberId: winnerId, tenantId: winnerTenantId, isNew };
  }

  async linkAccount(
    memberId: string,
    tenantId: number,
    provider: string,
    providerUserId: string
  ): Promise<void> {
    const existing = await this.db
      .prepare(
        "SELECT member_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
      )
      .bind(provider, providerUserId)
      .first<{ member_id: string }>();

    if (existing && existing.member_id !== memberId) {
      throw new Error("This account is already linked to a different user");
    }

    await this.db
      .prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, member_id, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(provider, providerUserId, memberId, tenantId, new Date().toISOString())
      .run();
  }

  async unlinkAccount(memberId: string, provider: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM oauth_accounts WHERE member_id = ? AND provider = ?"
      )
      .bind(memberId, provider)
      .run();
  }

  async getLinkedAccounts(memberId: string): Promise<LinkedAccount[]> {
    const result = await this.db
      .prepare(
        "SELECT provider, created_at FROM oauth_accounts WHERE member_id = ?"
      )
      .bind(memberId)
      .all<LinkedAccount>();

    return result.results;
  }

  async storePendingOAuth(pendingId: string, data: PendingOAuthData): Promise<void> {
    await this.kv.put(`pending_oauth:${pendingId}`, JSON.stringify(data), {
      expirationTtl: 600,
    });
  }

  async getPendingOAuth(pendingId: string): Promise<PendingOAuthData | null> {
    const raw = await this.kv.get(`pending_oauth:${pendingId}`);
    if (!raw) return null;
    return JSON.parse(raw) as PendingOAuthData;
  }

  async deletePendingOAuth(pendingId: string): Promise<void> {
    await this.kv.delete(`pending_oauth:${pendingId}`);
  }
}
