import type { Env } from "../types";
import { decrypt } from "./crypto";

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  consumerSecret: string;
  // App-only Bearer. `POST /2/webhooks` rejects an OAuth 2.0 user token outright
  // ("Unsupported Authentication ... Supported authentication types are [OAuth 1.0a User
  // Context, OAuth 2.0 Application-Only]"), so webhook registration needs this and nothing
  // else will do — the three fields above are all user-context or HMAC material. Optional
  // because BYOK channels created before 2026-07-28 have no stored bearer; callers must
  // handle its absence rather than assume it.
  bearerToken?: string;
}

export interface ByokConfig {
  is_byok?: boolean;
  app_client_id?: string;
  app_client_secret?: string;
  app_consumer_secret?: string;
  app_bearer_token?: string;
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
      bearerToken: env.X_BEARER_TOKEN,
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
  // Not in the required set above: a channel saved before the field existed still authorizes,
  // refreshes tokens and answers CRC fine — only webhook registration is unavailable to it.
  const bearerToken = config.app_bearer_token
    ? await decrypt(config.app_bearer_token, masterKey)
    : undefined;

  return { clientId, clientSecret, consumerSecret, bearerToken };
}
