import type { Env } from "../types";
import { XActivityService, byokWebhookUrl } from "./x-webhook";
import { XTokenService } from "./x-token";
import type { AppCredentials } from "./app-credentials";

// The one place that (re)establishes a channel's X Account Activity subscriptions. Extracted
// out of the hourly cron so the manual endpoint runs the SAME code — a repair that only works
// when triggered by hand proves nothing about the path that actually runs unattended.
//
// Two different credentials by design: `/2/webhooks` only accepts app-only auth (a user token
// gets 403 "Unsupported Authentication"), while `/2/activity/subscriptions` needs user context
// for private events. Passing the user token to both is what broke BYOK setup until 2026-07-28.
export async function ensureXSubscriptions(
  env: Env,
  channelId: string,
  // Only the two fields this actually reads — callers hold differently-shaped views of the
  // same config blob (cron's is all-optional, the route's is the full ChannelConfig).
  config: { x_user_id?: string; is_byok?: boolean },
  creds: AppCredentials,
  userAccessToken: string,
): Promise<{ ok: true; webhookId: string; webhookUrl: string; subscriptionIds: string[] } | { ok: false; error: string }> {
  if (!config.x_user_id) return { ok: false, error: "channel has no x_user_id — it has not been authorized yet" };
  if (!creds.bearerToken) return { ok: false, error: `channel ${channelId} has no app-only bearer token — cannot register its webhook` };

  // BYOK gets a per-account URL keyed by the X user id (stable across reconnects); the system
  // app has exactly one shared webhook and no path segment.
  const webhookUrl = config.is_byok
    ? byokWebhookUrl(env.LINK_URL, config.x_user_id)
    : `${env.LINK_URL}/x/webhook`;

  const bearerService = new XActivityService(creds.bearerToken);
  let webhook = await bearerService.getWebhook(webhookUrl);
  if (!webhook) {
    const whId = await bearerService.createWebhook(webhookUrl);
    webhook = { webhook_id: whId, url: webhookUrl };
  }

  const userService = new XActivityService(userAccessToken);
  const subscriptionIds = await userService.setupAllSubscriptions(config.x_user_id, webhookUrl, webhook.webhook_id);

  const tokenService = new XTokenService(env.LINK_DB, creds.clientId, creds.clientSecret);
  await tokenService.updateConfig(channelId, {
    subscription_ids: subscriptionIds,
    subscription_error: null,
    subscription_setup_at: new Date().toISOString(),
  });

  return { ok: true, webhookId: webhook.webhook_id, webhookUrl, subscriptionIds };
}
