import type { Env } from "../types";
import { decrypt } from "./crypto";

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
  consumerSecret: string;
}

export interface ByokConfig {
  app_client_id?: string;
  app_client_secret?: string;
  app_consumer_secret?: string;
}

export async function getAppCredentials(env: Env, config: ByokConfig): Promise<AppCredentials> {
  if (!config.app_client_id || !config.app_client_secret || !config.app_consumer_secret) {
    return {
      clientId: env.X_CLIENT_ID,
      clientSecret: env.X_CLIENT_SECRET,
      consumerSecret: env.X_CONSUMER_SECRET,
    };
  }

  const masterKey = await env.ENCRYPTION_KEY.get();
  const [clientId, clientSecret, consumerSecret] = await Promise.all([
    decrypt(config.app_client_id, masterKey),
    decrypt(config.app_client_secret, masterKey),
    decrypt(config.app_consumer_secret, masterKey),
  ]);

  return { clientId, clientSecret, consumerSecret };
}
