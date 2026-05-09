export interface OAuthState {
  codeVerifier: string;
  mode: "login" | "link";
  userId?: string;
}

export interface PendingOAuthData {
  provider: string;
  providerUserId: string;
}

export interface ResolveUserResult {
  userId: string;
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
    email: string | null
  ): Promise<ResolveUserResult> {
    // Check if oauth_account already exists
    const existing = await this.db
      .prepare(
        "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
      )
      .bind(provider, providerUserId)
      .first<{ user_id: string }>();

    if (existing) {
      return { userId: existing.user_id, isNew: false };
    }

    // Check if email matches an existing user
    if (email) {
      const userByEmail = await this.db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string }>();

      if (userByEmail) {
        // Auto-merge: link oauth_account to existing user
        await this.db
          .prepare(
            "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)"
          )
          .bind(provider, providerUserId, userByEmail.id, new Date().toISOString())
          .run();

        return { userId: userByEmail.id, isNew: false };
      }
    }

    // Create new user + oauth_account
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare("INSERT INTO users (id, email, preferred_location, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, email, "global", now)
      .run();

    await this.db
      .prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(provider, providerUserId, userId, now)
      .run();

    return { userId, isNew: true };
  }

  async linkAccount(
    userId: string,
    provider: string,
    providerUserId: string
  ): Promise<void> {
    // Check if already linked to a different user
    const existing = await this.db
      .prepare(
        "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?"
      )
      .bind(provider, providerUserId)
      .first<{ user_id: string }>();

    if (existing && existing.user_id !== userId) {
      throw new Error("This account is already linked to a different user");
    }

    await this.db
      .prepare(
        "INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(provider, providerUserId, userId, new Date().toISOString())
      .run();
  }

  async unlinkAccount(userId: string, provider: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?"
      )
      .bind(userId, provider)
      .run();
  }

  async getLinkedAccounts(userId: string): Promise<LinkedAccount[]> {
    const result = await this.db
      .prepare(
        "SELECT provider, created_at FROM oauth_accounts WHERE user_id = ?"
      )
      .bind(userId)
      .all<LinkedAccount>();

    return result.results;
  }

  async storePendingOAuth(pendingId: string, data: PendingOAuthData): Promise<void> {
    await this.kv.put(`pending_oauth:${pendingId}`, JSON.stringify(data), {
      expirationTtl: 300,
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
