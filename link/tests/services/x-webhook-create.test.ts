import { describe, it, expect, vi, afterEach } from "vitest";
import { XActivityService } from "../../src/services/x-webhook";

// 2026-08-09: createWebhook read `data.data.webhook_id`, but X keys the webhook object as
// `id` (the same shape /2/webhooks returns when listing). It therefore returned undefined,
// createSubscription's `if (webhookId)` quietly dropped the field, and X created six
// subscriptions bound to NO webhook — "stream only" in the portal. They listed as valid, had
// the right filters, and delivered nothing to any URL. Nothing in the system said a word.

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
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

afterEach(() => vi.unstubAllGlobals());

describe("XActivityService.createWebhook", () => {
  it("reads the id X actually returns (`id`), not `webhook_id`", async () => {
    mockFetch([{ status: 200, body: { data: { id: "2086377085342236672", url: "https://x/y", valid: true } } }]);
    expect(await new XActivityService("b").createWebhook("https://x/y")).toBe("2086377085342236672");
  });

  it("still accepts the older `webhook_id` key if X ever answers with it", async () => {
    mockFetch([{ status: 200, body: { data: { webhook_id: "legacy-1" } } }]);
    expect(await new XActivityService("b").createWebhook("https://x/y")).toBe("legacy-1");
  });

  // Loud, not undefined: the webhook exists on X at this point, and an undefined id is what
  // silently produced six undeliverable subscriptions.
  it("throws when the response carries no id at all", async () => {
    mockFetch([{ status: 200, body: { data: { url: "https://x/y" } } }]);
    await expect(new XActivityService("b").createWebhook("https://x/y")).rejects.toThrow(/no id/);
  });
});

describe("XActivityService.createSubscription — webhook binding", () => {
  it("always sends webhook_id in the body", async () => {
    const calls = mockFetch([{ status: 200, body: { data: { subscription: { subscription_id: "s1" } } } }]);
    await new XActivityService("b").createSubscription("follow.follow", "u1", "wh-1");

    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.webhook_id).toBe("wh-1");
    expect(body.filter).toEqual({ user_id: "u1" });
  });

  it("keeps the direction filter alongside the webhook binding", async () => {
    const calls = mockFetch([{ status: 200, body: { data: { subscription: { subscription_id: "s1" } } } }]);
    await new XActivityService("b").createSubscription("like.create", "u1", "wh-1", "inbound");

    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.webhook_id).toBe("wh-1");
    expect(body.filter).toEqual({ user_id: "u1", direction: "inbound" });
  });

  // A stream-only subscription is indistinguishable from a healthy one when listed, so this
  // must fail before it reaches X, not after.
  it("refuses to create a webhook-less (stream-only) subscription", async () => {
    const calls = mockFetch([{ status: 200, body: { data: { subscription: { subscription_id: "s1" } } } }]);
    await expect(new XActivityService("b").createSubscription("follow.follow", "u1", "" as string))
      .rejects.toThrow(/stream-only/);
    expect(calls).toHaveLength(0);
  });
});

describe("XActivityService.setupAllSubscriptions — webhook binding", () => {
  it("refuses the whole run without a webhook id, so the hourly repair keeps retrying", async () => {
    const calls = mockFetch([{ status: 200, body: { data: [] } }]);
    await expect(new XActivityService("b").setupAllSubscriptions("u1", "https://x/y", "" as string))
      .rejects.toThrow(/no webhook id/);
    // Not even the list call goes out — nothing about this run can half-succeed.
    expect(calls).toHaveLength(0);
  });

  it("binds every created subscription to the webhook it was given", async () => {
    const calls = mockFetch([
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: { subscription: { subscription_id: "s" } } } },
    ]);
    await new XActivityService("b").setupAllSubscriptions("u1", "https://x/y", "wh-42");

    const creates = calls.filter((c) => c.init?.method === "POST");
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) {
      expect(JSON.parse(String(c.init!.body)).webhook_id).toBe("wh-42");
    }
  });
});
