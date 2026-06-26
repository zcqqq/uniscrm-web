export const ALL_XAA_EVENTS = [
  "post.create",
  "post.delete",
  "follow.follow",
  "follow.unfollow",
  "profile.update.bio",
  "profile.update.profile_picture",
  "profile.update.banner_picture",
  "profile.update.screenname",
  "profile.update.handle",
  "profile.update.geo",
  "profile.update.url",
  "profile.update.verified_badge",
  "profile.update.affiliate_badge",
  "chat.received",
  "chat.sent",
  "chat.conversation_join",
  "dm.received",
  "dm.sent",
  "dm.read",
  "dm.indicate_typing",
  "spaces.start",
  "spaces.end",
] as const;

export class XWebhookService {
  constructor(private clientSecret: string) {}

  async computeCrcResponse(crcToken: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.clientSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(crcToken));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return `sha256=${base64}`;
  }
}

export class XActivityService {
  constructor(private bearerToken: string) {}

  async createWebhook(webhookUrl: string): Promise<string> {
    const res = await fetch("https://api.x.com/2/webhooks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: webhookUrl }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Create webhook failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { data: { webhook_id: string } };
    return data.data.webhook_id;
  }

  async getWebhook(): Promise<{ webhook_id: string; url: string } | null> {
    const res = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string; url: string }> };
    return data.data?.[0] ? { webhook_id: data.data[0].id, url: data.data[0].url } : null;
  }

  async listSubscriptions(): Promise<Array<{ subscription_id: string; event_type: string; filter: { user_id: string } }>> {
    const res = await fetch("https://api.x.com/2/activity/subscriptions", {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ subscription_id: string; event_type: string; filter: { user_id: string } }> };
    return data.data || [];
  }

  async createSubscription(eventType: string, userId: string, webhookId?: string): Promise<string> {
    const body: Record<string, unknown> = {
      event_type: eventType,
      filter: { user_id: userId },
      tag: `uniscrm-${eventType}`,
    };
    if (webhookId) body.webhook_id = webhookId;

    const res = await fetch("https://api.x.com/2/activity/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Create subscription [${eventType}] failed ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { data: { subscription_id: string } };
    return data.data.subscription_id;
  }

  async setupAllSubscriptions(userId: string, webhookUrl: string, webhookId?: string): Promise<string[]> {
    // If no webhookId provided, try to get/create one (needs Bearer Token auth)
    let wId = webhookId;
    if (!wId) {
      const webhook = await this.getWebhook();
      if (webhook && webhook.url === webhookUrl) {
        wId = webhook.webhook_id;
      } else {
        wId = await this.createWebhook(webhookUrl);
      }
    }

    // Get existing subscriptions
    const existing = await this.listSubscriptions();
    const existingTypes = new Set(existing.map((s) => s.event_type));

    const subscriptionIds: string[] = existing.map((s) => s.subscription_id);

    // Create missing subscriptions
    for (const eventType of ALL_XAA_EVENTS) {
      if (existingTypes.has(eventType)) continue;
      try {
        const id = await this.createSubscription(eventType, userId, wId);
        subscriptionIds.push(id);
        console.log(JSON.stringify({ event: "xaa_subscription_created", eventType, id }));
      } catch (e) {
        console.log(JSON.stringify({ event: "xaa_subscription_failed", eventType, error: String(e) }));
      }
    }

    return subscriptionIds;
  }
}
