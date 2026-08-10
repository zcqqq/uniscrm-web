import { XAA_SUBSCRIPTION_SPECS } from "../../../metadata/x";

// A BYOK channel's webhook URL is keyed by its X user id, never by the channel row id.
// X allows only a handful of webhooks per app (this dev app: one), and deleting a channel
// and reconnecting the same account mints a NEW row id — so a channel-id URL could never be
// registered again: the stale URL held the app's only slot, createWebhook answered
// WebhookLimitExceeded, and that throw skipped setupAllSubscriptions entirely, leaving the
// channel with zero subscriptions and X delivering nothing (dev, 2026-08-07 → 08-09).
// The X user id survives reconnects, so the same URL is reused and getWebhook finds it.
export function byokWebhookUrl(origin: string, xUserId: string): string {
  return `${origin}/x/webhook/${xUserId}`;
}

// Constant-time string compare — a plain === on a signature leaks, byte by byte, how much of
// a forged value was right.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class XWebhookService {
  constructor(private clientSecret: string) {}

  // `sha256=<base64 HMAC-SHA256>` — the one shape X uses for both directions: our CRC answer
  // (message = crc_token) and its own event signatures (message = the raw POST body).
  async computeSignature(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.clientSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return `sha256=${base64}`;
  }

  async computeCrcResponse(crcToken: string): Promise<string> {
    return this.computeSignature(crcToken);
  }

  // Verifies X's `x-twitter-webhooks-signature` header against the RAW request body — parsing
  // and re-serializing the JSON first would change the bytes and fail every time.
  // https://docs.x.com/x-api/webhooks/quickstart
  //
  // Fails closed on a missing header: the BYOK path segment is the X user id, which is public,
  // so the URL alone no longer gates who may POST events for an account.
  async verifySignature(rawBody: string, header: string | undefined | null): Promise<boolean> {
    if (!header) return false;
    return timingSafeEqual(await this.computeSignature(rawBody), header);
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

    // X's webhook object keys the id as `id` (same shape the list endpoint returns), NOT
    // `webhook_id`. Reading `webhook_id` yielded undefined, which `createSubscription`'s
    // `if (webhookId)` then silently swallowed — X created six subscriptions bound to NO
    // webhook ("stream only" in the portal), so they were valid, listed, and undeliverable.
    // Same failure class as the create-response shape bug documented in createSubscription;
    // `webhook_id` is kept as a fallback in case X ever answers with the older key.
    const data = (await res.json()) as { data?: { id?: string; webhook_id?: string } };
    const id = data.data?.id ?? data.data?.webhook_id;
    if (!id) {
      // Loud: the webhook now exists on X's side, and returning undefined loses the only
      // handle on it — and the caller would go on to create stream-only subscriptions.
      throw new Error(`Create webhook returned no id: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return id;
  }

  // Requires app-only auth. With an OAuth 2.0 user token X answers 403 "Unsupported
  // Authentication", which lands in the `!res.ok` branch below as a silent null — indis-
  // tinguishable from "this app has no webhook yet", so the caller goes on to createWebhook
  // and only THERE learns the credential was wrong. Callers must pass an app-only Bearer.
  //
  // `matchUrl` picks the webhook registered for that exact URL instead of assuming the app
  // owns exactly one: every BYOK channel gets its own /x/webhook/<xUserId>, so a tenant
  // with two channels on one X app has two webhooks, and taking data[0] would see a mismatch
  // and try to create a duplicate.
  // The raw `/2/webhooks` list, every field X returns (getWebhook narrows it to id+url and
  // drops the rest — including whatever X reports about validity, which is exactly what you
  // need when subscriptions exist but nothing is being delivered).
  async listWebhooksRaw(): Promise<{ status: number; body: unknown }> {
    const res = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: text.slice(0, 500) };
    }
  }

  async getWebhook(matchUrl?: string): Promise<{ webhook_id: string; url: string } | null> {
    const res = await fetch("https://api.x.com/2/webhooks", {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    // 诊断日志（2026-08-09）：这个方法把「查询失败」和「不存在」都抹成 null，调用方一律
    // 当成「没有 webhook」去 createWebhook，于是撞上 WebhookLimitExceeded 并让整个订阅
    // 建立流程中止 —— dev 频道 70ee0fcb 因此两天零订阅。先把真实状态码与 X 侧现有的
    // webhook 列表打出来，再决定怎么修。只记 id/url，不记任何凭证。
    if (!res.ok) {
      const body = await res.text();
      console.log(JSON.stringify({ event: "xaa_get_webhook_failed", status: res.status, matchUrl, body: body.slice(0, 300) }));
      return null;
    }
    const data = (await res.json()) as { data?: Array<{ id: string; url: string }> };
    const hooks = data.data || [];
    const hit = matchUrl ? hooks.find((w) => w.url === matchUrl) : hooks[0];
    console.log(JSON.stringify({
      event: "xaa_get_webhook_listed",
      matchUrl,
      matched: hit?.id ?? null,
      registered: hooks.map((w) => ({ id: w.id, url: w.url })),
    }));
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

  // webhookId is REQUIRED. Omitting it does not fail — X creates a subscription bound to no
  // webhook at all ("stream only"), which lists as perfectly valid and delivers nothing to
  // any URL, forever. That is exactly what an undefined id from createWebhook produced on
  // 2026-08-09, and it cost a day of chasing X's side of the wire. Fail closed instead.
  async createSubscription(eventType: string, userId: string, webhookId: string, direction?: "inbound" | "outbound"): Promise<string> {
    if (!webhookId) {
      throw new Error(`Create subscription [${eventType}] refused: no webhook id — a webhook-less subscription is stream-only and never reaches this app`);
    }
    const body: Record<string, unknown> = {
      event_type: eventType,
      // direction 只在 metadata 声明了才带上：X 的 filter.direction 是可选的方向过滤，
      // 省略时同一个 event_type 会两个方向都推。
      filter: direction ? { user_id: userId, direction } : { user_id: userId },
      tag: `uniscrm-${eventType}`,
      webhook_id: webhookId,
    };

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
      data?: { subscription?: { subscription_id?: string; filter?: unknown }; subscription_id?: string };
    };
    // 把请求的 filter 和 X 回显的 filter 并排记下来。dev 上 2026-08-09 14:23 建的 like.create
    // 明明带了 direction:"inbound"，列表接口回来却没有 direction —— 分不清是 X 忽略了这个
    // 字段、还是只是不回显。这条日志是唯一能分清的地方，而两者的处理方式完全相反。
    console.log(JSON.stringify({
      event: "xaa_subscription_create_echo",
      eventType,
      requested: body.filter,
      echoed: data.data?.subscription?.filter ?? null,
    }));
    const id = data.data?.subscription?.subscription_id ?? data.data?.subscription_id;
    if (!id) {
      // Loud: the subscription exists on X's side at this point, so silently returning
      // undefined loses the only handle we have on it.
      throw new Error(`Create subscription [${eventType}] returned no subscription_id: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return id;
  }

  // filter.direction 是唯一没法原地改的字段：PUT /2/activity/subscriptions/{id} 只接受
  // tag 和 webhook_id（docs.x.com/x-api/activity/update-x-activity-subscription），所以方向
  // 漂移只能删了重建，这个方法就是重建的前半步。
  //
  // 注意认证方式：DELETE 和 /2/webhooks 一样只收 app-only，用户 token 会被 403
  // "Unsupported Authentication ... Supported authentication types are [OAuth 2.0
  // Application-Only]"（2026-08-09 dev 实测）。而 POST 建订阅恰恰相反，必须要用户上下文。
  // 所以这个实例的 token 必须是 app-only bearer，不能是 setupAllSubscriptions 手上那个。
  async deleteSubscription(subscriptionId: string): Promise<void> {
    const res = await fetch(`https://api.x.com/2/activity/subscriptions/${subscriptionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });

    // 404 = 这条订阅已经不在了，正是我们想要的终态。当成失败会让整轮修复卡在一条早就
    // 被手工删掉的订阅上。
    if (res.status === 404) return;
    if (!res.ok) {
      throw new Error(`Delete subscription [${subscriptionId}] failed ${res.status}: ${await res.text()}`);
    }
    // X 会用 HTTP 200 + data.deleted:false 表示没删成。放过它，调用方就会以为可以安全重建，
    // 于是同一个 event_type 出现两条订阅——旧那条继续推我们不想要的方向。
    const data = (await res.json().catch(() => ({}))) as { data?: { deleted?: boolean } };
    if (data.data?.deleted === false) {
      throw new Error(`Delete subscription [${subscriptionId}] returned deleted:false`);
    }
  }

  // `webhookId` is REQUIRED and must have been obtained by an app-only-authenticated caller.
  // This method's own token is the USER token (subscriptions to private events need user
  // context), and `/2/webhooks` refuses user tokens — so it must never try to get/create the
  // webhook itself. It used to, when webhookId was omitted, which is exactly how the BYOK
  // path failed on every authorize with 403 until 2026-07-28.
  async setupAllSubscriptions(userId: string, webhookUrl: string, webhookId: string): Promise<string[]> {
    // Refuse the whole run rather than per-subscription: without a webhook id every
    // subscription below would be created stream-only, and stream-only subscriptions look
    // healthy from every angle (listed, valid, correct filter) while delivering nothing.
    // Better to leave subscription_ids empty so the hourly repair keeps retrying.
    if (!webhookId) {
      throw new Error(`setupAllSubscriptions refused for ${userId}: no webhook id for ${webhookUrl}`);
    }
    const wId = webhookId;

    // Get existing subscriptions — scoped to THIS user. listSubscriptions() returns every
    // subscription on the shared webhook across all tenants; matching on event_type alone
    // (ignoring filter.user_id) meant the first tenant to subscribe to e.g. "follow.follow"
    // permanently blocked every later tenant from ever getting their own subscription for
    // that event type — later tenants would just get the first tenant's subscription_ids
    // handed back as if setup had succeeded for them.
    const existing = await this.listSubscriptions();
    const existingForUser = existing.filter((s) => s.filter?.user_id === userId);
    // 诊断日志（2026-08-09）：listSubscriptions 在 !res.ok 时静默返回已收集的部分结果，
    // 分不清「这个用户没订阅」和「列表根本没读到」。先把两个计数打出来。
    console.log(JSON.stringify({
      event: "xaa_setup_subscriptions_start",
      userId, webhookId, total: existing.length, forUser: existingForUser.length,
    }));

    const existingTypes = new Set(existingForUser.map((s) => s.event_type));
    const subscriptionIds: string[] = existingForUser.map((s) => s.subscription_id);

    // 存量订阅一律按 event_type 复用，**不比对 direction** —— 不是不想比，是比不了：
    // GET /2/activity/subscriptions 返回的 filter 里根本没有 direction 字段，哪怕这条订阅
    // 创建时明确带了它（2026-08-09 dev 实测：15:26:06 新建的 like.create 请求里
    // direction:"inbound"，创建响应回显了 direction，列表接口却查不到）。
    // 拿列表当真相去做「方向漂移检测」，会把一条完全正确的订阅每轮都删了重建，永不收敛。
    //
    // 代价是 metadata 改了 direction 之后存量订阅不会自动跟上（X 也没有原地改 filter 的接口，
    // PUT 只收 tag/webhook_id）。要换方向得显式重建：
    // POST /internal/x/repair-subscriptions?channelId=..&rebuild=<event_type>。
    // prod 那条 like.create 建于 2026-07-23，比 metadata 声明 inbound 早 5 天，就是这么一直
    // 两个方向都推的；兜底在 webhook.ts —— outbound 的赞在入库前就被丢掉。
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
