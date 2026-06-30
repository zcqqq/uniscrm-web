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

    if (email) {
      const memberByEmail = await this.db
        .prepare("SELECT id, tenant_id FROM members WHERE email = ?")
        .bind(email)
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
      .bind(email, now)
      .run();
    const tenant = await this.db
      .prepare("SELECT tenant_id FROM tenants WHERE email = ?")
      .bind(email)
      .first<{ tenant_id: number }>();
    const tenantId = tenant!.tenant_id;

    await this.db
      .prepare("INSERT INTO members (id, tenant_id, email, preferred_location, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(memberId, tenantId, email, "global", timezone, now)
      .run();

    await this.db
      .prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, member_id, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(provider, providerUserId, memberId, tenantId, now)
      .run();

    return { memberId, tenantId, isNew: true };
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
