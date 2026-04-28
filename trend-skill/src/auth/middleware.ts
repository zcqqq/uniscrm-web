import type { AuthResult, AuthError, Tier } from "../types";

export async function resolveAuth(
  apiKey: string | undefined,
  db: D1Database
): Promise<AuthResult | AuthError> {
  if (!apiKey) {
    return { tier: "anonymous", identifier: "anonymous" };
  }

  const row = await db
    .prepare("SELECT key, tier, is_active, expires_at FROM api_keys WHERE key = ?")
    .bind(apiKey)
    .first<{ key: string; tier: Tier; is_active: number; expires_at: string | null }>();

  if (!row) {
    return { error: "Invalid API key", status: 401 };
  }

  if (!row.is_active) {
    return { error: "API key deactivated", status: 403 };
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { error: "API key expired", status: 403 };
  }

  return { tier: row.tier, identifier: row.key };
}
