import { describe, it, expect, vi } from "vitest";
import { XActivityService } from "../../src/services/x-webhook";

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  }));
  return calls;
}

describe("XActivityService.setupAllSubscriptions", () => {
  it("creates the caller's own subscriptions even when another user already owns those event types on the shared webhook", async () => {
    // Regression test: setupAllSubscriptions used to dedupe on event_type alone,
    // ignoring which X user_id each existing subscription belonged to. On a shared
    // system webhook, the first tenant to subscribe to e.g. "follow.follow"
    // permanently blocked every later tenant from getting their own subscription —
    // later tenants silently received the first tenant's subscription_ids back as
    // if setup had succeeded for them.
    const otherUsersSubs = [
      { subscription_id: "other-1", event_type: "follow.follow", filter: { user_id: "other-user" } },
      { subscription_id: "other-2", event_type: "follow.unfollow", filter: { user_id: "other-user" } },
      { subscription_id: "other-3", event_type: "dm.read", filter: { user_id: "other-user" } },
      { subscription_id: "other-4", event_type: "dm.received", filter: { user_id: "other-user" } },
      { subscription_id: "other-5", event_type: "post.create", filter: { user_id: "other-user" } },
      { subscription_id: "other-6", event_type: "like.create", filter: { user_id: "other-user" } },
    ];

    // First call: listSubscriptions() -> all 6 belong to "other-user".
    // Next 6 calls: createSubscription() for this-user, one per event type.
    mockFetchSequence([
      { status: 200, body: { data: otherUsersSubs } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-1" } } } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-2" } } } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-3" } } } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-4" } } } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-5" } } } },
      { status: 200, body: { data: { subscription: { subscription_id: "mine-6" } } } },
    ]);

    const service = new XActivityService("bearer-token");
    const ids = await service.setupAllSubscriptions("this-user", "https://example.com/x/webhook", "webhook-1");

    // Must NOT include any of the other user's subscription ids, and must have
    // created exactly 6 new ones (one per XAA_SUBSCRIPTION_SPECS entry).
    expect(ids).not.toContain("other-1");
    expect(ids).not.toContain("other-2");
    expect(ids.sort()).toEqual(["mine-1", "mine-2", "mine-3", "mine-4", "mine-5", "mine-6"].sort());
  });

  it("reuses this user's own existing subscription instead of recreating it", async () => {
    const thisUsersOneSub = [
      { subscription_id: "mine-existing", event_type: "follow.follow", filter: { user_id: "this-user" } },
    ];

    const createCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { event_type: string };
        createCalls.push(body.event_type);
        return Promise.resolve(new Response(JSON.stringify({ data: { subscription: { subscription_id: `new-${body.event_type}` } } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: thisUsersOneSub }), { status: 200 }));
    }));

    const service = new XActivityService("bearer-token");
    const ids = await service.setupAllSubscriptions("this-user", "https://example.com/x/webhook", "webhook-1");

    expect(ids).toContain("mine-existing");
    expect(createCalls).not.toContain("follow.follow");
  });

  it("subscribes like.create with filter.direction inbound, and every other event type without a direction", async () => {
    // X's like.create fires both when the filtered user likes a Post and when one of their
    // Posts is liked; only the latter is worth ingesting, and direction is the only way to say
    // so at subscription time. The value comes from metadata/x.ts, never a literal here.
    const bodies: Array<{ event_type: string; filter: { user_id: string; direction?: string } }> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        return Promise.resolve(new Response(JSON.stringify({ data: { subscription: { subscription_id: `new-${body.event_type}` } } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }));

    const service = new XActivityService("bearer-token");
    await service.setupAllSubscriptions("this-user", "https://example.com/x/webhook", "webhook-1");

    const like = bodies.find((b) => b.event_type === "like.create");
    expect(like?.filter).toEqual({ user_id: "this-user", direction: "inbound" });

    for (const body of bodies.filter((b) => b.event_type !== "like.create")) {
      expect(body.filter).toEqual({ user_id: "this-user" });
    }
  });

  // The create response nests one level deeper than the list response:
  // {data: {subscription: {subscription_id}}}. Reading data.subscription_id gave undefined,
  // and six real subscriptions were recorded as [null × 6] — created on X's side but with no
  // usable handle on ours, and no error to show for it.
  it("reads subscription_id out of the create response's nested `subscription` object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({
          data: { subscription: { subscription_id: "sub-123", event_type: "follow.follow" }, total_subscriptions_for_instance_id: 1 },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    }));

    const service = new XActivityService("bearer-token");
    const id = await service.createSubscription("follow.follow", "this-user", "webhook-1");

    expect(id).toBe("sub-123");
  });

  it("throws rather than returning undefined when the create response carries no subscription_id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })));

    const service = new XActivityService("bearer-token");
    await expect(service.createSubscription("follow.follow", "this-user", "webhook-1")).rejects.toThrow("no subscription_id");
  });

  // The shared system webhook accumulates subscriptions across every tenant, so the list is
  // paginated. Stopping at page 1 would hide existing subscriptions from the dedup below and
  // create duplicates for event types that are already covered.
  it("follows meta.next_token so dedup sees subscriptions beyond the first page", async () => {
    const pages = [
      { data: [{ subscription_id: "p1", event_type: "follow.follow", filter: { user_id: "this-user" } }], meta: { next_token: "tok-2" } },
      { data: [{ subscription_id: "p2", event_type: "dm.received", filter: { user_id: "this-user" } }] },
    ];
    const urls: string[] = [];
    let i = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify(pages[Math.min(i++, pages.length - 1)]), { status: 200 }));
    }));

    const service = new XActivityService("bearer-token");
    const subs = await service.listSubscriptions();

    expect(subs.map((s) => s.subscription_id)).toEqual(["p1", "p2"]);
    expect(urls[1]).toContain("pagination_token=tok-2");
  });
});
