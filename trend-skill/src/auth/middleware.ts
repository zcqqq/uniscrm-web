import type { ApiKeyRecord, Tier } from "../types";

export type AuthContext =
  | { tier: "anonymous" | Tier; identifier: string | null }
  | { error: string; status: number };

export async function resolveAuth(
  apiKey: string | undefined,
  db: D1Database
): Promise<AuthContext> {
  if (!apiKey) {
    return { tier: "anonymous", identifier: null };
  }

  const record = await db
    .prepare("SELECT * FROM api_keys WHERE key = ?")
    .bind(apiKey)
    .first<ApiKeyRecord>();

  if (!record) {
    return { error: "Invalid API key", status: 401 };
  }

  if (!record.is_active) {
    return { error: "API key deactivated", status: 403 };
  }

  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return { error: "API key expired", status: 403 };
  }

  return { tier: record.tier, identifier: record.key };
}
