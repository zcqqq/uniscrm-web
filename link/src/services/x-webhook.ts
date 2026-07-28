import { XAA_SUBSCRIPTION_SPECS } from "../../../metadata/x";

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

  // Requires app-only auth. With an OAuth 2.0 user token X answers 403 "Unsupported
  // Authentication", which lands in the `!res.ok` branch below as a silent null — indis-
  // tinguishable from "this app has no webhook yet", so the caller goes on to createWebhook
  // and only THERE learns the credential was wrong. Callers must pass an app-only Bearer.
  //
  // `matchUrl` picks the webhook registered for that exact URL instead of assuming the app
  // owns exactly one: every BYOK channel gets its own /x/webhook/<channelId>, so a tenant
  // with two channels on one X app has two webhooks, and taking data[0] would see a mismatch
  // and try to create a duplicate.
  async getWebhook(matchUrl?: string): Promise<{ webhook_id: string; url: string } | null> {
    const res = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id: string; url: string }> };
    const hooks = data.data || [];
    const hit = matchUrl ? hooks.find((w) => w.url === matchUrl) : hooks[0];
    return hit ? { webhook_id: hit.id, url: hit.url } : null;
  }

  // Paginated: the response carries `meta.next_token`, and on the shared system webhook this
  // list spans every tenant, so reading only the first page would hide existing subscriptions
  // from setupAllSubscriptions' dedup and make it create duplicates.
  async listSubscriptions(): Promise<Array<{ subscription_id: string; event_type: string; filter: { user_id: string; direction?: string } }>> {
    type Sub = { subscription_id: string; event_type: string; filter: { user_id: string; direction?: string } };
    const all: Sub[] = [];
    let token: string | undefined;
    // Bounded so a server-side pagination bug can't spin here forever.
    for (let page = 0; page < 20; page++) {
      const url = new URL("https://api.x.com/2/activity/subscriptions");
      if (token) url.searchParams.set("pagination_token", token);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.bearerToken}` },
      });
      if (!res.ok) return all;
      const data = (await res.json()) as { data?: Sub[]; meta?: { next_token?: string } };
      all.push(...(data.data || []));
      token = data.meta?.next_token;
      if (!token) break;
    }
    return all;
  }

  async createSubscription(eventType: string, userId: string, webhookId?: string, direction?: "inbound" | "outbound"): Promise<string> {
    const body: Record<string, unknown> = {
      event_type: eventType,
      // direction 只在 metadata 声明了才带上：X 的 filter.direction 是可选的方向过滤，
      // 省略时同一个 event_type 会两个方向都推。
      filter: direction ? { user_id: userId, direction } : { user_id: userId },
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

    // The create response nests the subscription one level deeper than the list response does:
    // `{data: {subscription: {subscription_id, ...}, total_subscriptions_for_instance_id}}`.
    // Reading `data.subscription_id` yielded undefined, and six successfully created
    // subscriptions were stored as `[null × 6]` — no error anywhere, just unusable ids.
    const data = (await res.json()) as {
      data?: { subscription?: { subscription_id?: string }; subscription_id?: string };
    };
    const id = data.data?.subscription?.subscription_id ?? data.data?.subscription_id;
    if (!id) {
      // Loud: the subscription exists on X's side at this point, so silently returning
      // undefined loses the only handle we have on it.
      throw new Error(`Create subscription [${eventType}] returned no subscription_id: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return id;
  }

  // `webhookId` is REQUIRED and must have been obtained by an app-only-authenticated caller.
  // This method's own token is the USER token (subscriptions to private events need user
  // context), and `/2/webhooks` refuses user tokens — so it must never try to get/create the
  // webhook itself. It used to, when webhookId was omitted, which is exactly how the BYOK
  // path failed on every authorize with 403 until 2026-07-28.
  async setupAllSubscriptions(userId: string, webhookUrl: string, webhookId: string): Promise<string[]> {
    const wId = webhookId;

    // Get existing subscriptions — scoped to THIS user. listSubscriptions() returns every
    // subscription on the shared webhook across all tenants; matching on event_type alone
    // (ignoring filter.user_id) meant the first tenant to subscribe to e.g. "follow.follow"
    // permanently blocked every later tenant from ever getting their own subscription for
    // that event type — later tenants would just get the first tenant's subscription_ids
    // handed back as if setup had succeeded for them.
    const existing = await this.listSubscriptions();
    const existingForUser = existing.filter((s) => s.filter?.user_id === userId);
    const existingTypes = new Set(existingForUser.map((s) => s.event_type));

    const subscriptionIds: string[] = existingForUser.map((s) => s.subscription_id);

    // Create missing subscriptions. An existing subscription is reused as-is even when the
    // metadata now declares a direction it was created without — X has no in-place update here
    // and this code owns no delete path, so a legacy like.create subscription keeps delivering
    // both directions until the channel is reconnected (webhook.ts attributes those correctly).
    for (const { eventType, direction } of XAA_SUBSCRIPTION_SPECS) {
      if (existingTypes.has(eventType)) continue;
      try {
        const id = await this.createSubscription(eventType, userId, wId, direction);
        subscriptionIds.push(id);
        console.log(JSON.stringify({ event: "xaa_subscription_created", eventType, direction, id }));
      } catch (e) {
        console.log(JSON.stringify({ event: "xaa_subscription_failed", eventType, error: String(e) }));
      }
    }

    return subscriptionIds;
  }
}
