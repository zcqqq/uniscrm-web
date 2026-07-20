import type { Env } from "../types";
import { decrypt } from "./crypto";

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  consumerSecret: string;
}

export interface ByokConfig {
  is_byok?: boolean;
  app_client_id?: string;
  app_client_secret?: string;
  app_consumer_secret?: string;
}

// BYOK channels authorize against the tenant's own X Developer App, not our shared
// one — there's no shared-trust consent screen to keep lean, and re-prompting a
// tenant for a missing scope later is exactly the friction link/CLAUDE.md says to
// avoid ("如果不指定则尽量选择最多的scope"). So this requests every scope X
// currently defines, unlike the deliberately minimal shared/x-scopes.ts used for
// the system default app.
export const X_BYOK_SCOPES = [
  "tweet.read", "tweet.write", "tweet.moderate.write", "users.email", "users.read",
  "follows.read", "follows.write", "offline.access", "space.read",
  "mute.read", "mute.write", "like.read", "like.write", "list.read", "list.write",
  "block.read", "block.write", "bookmark.read", "bookmark.write",
  "dm.read", "dm.write", "media.write",
];

export async function getAppCredentials(env: Env, config: ByokConfig): Promise<AppCredentials> {
  if (!config.is_byok) {
    return {
      clientId: env.X_CLIENT_ID,
      clientSecret: env.X_CLIENT_SECRET,
      consumerSecret: env.X_CONSUMER_SECRET,
    };
  }

  if (!config.app_client_id || !config.app_client_secret || !config.app_consumer_secret) {
    throw new Error("BYOK channel missing app credentials");
  }

  const masterKey = await env.ENCRYPTION_KEY.get();
  const [clientId, clientSecret, consumerSecret] = await Promise.all([
    decrypt(config.app_client_id, masterKey),
    decrypt(config.app_client_secret, masterKey),
    decrypt(config.app_consumer_secret, masterKey),
  ]);

  return { clientId, clientSecret, consumerSecret };
}
