import { describe, it, expect } from "vitest";
import { XWebhookService, byokWebhookUrl } from "../../src/services/x-webhook";

const SECRET = "consumer-secret-1";

describe("byokWebhookUrl", () => {
  // 2026-08-07 → 08-09 dev outage: the URL used to carry the channel ROW id, so soft-deleting
  // a channel and reconnecting the same X account minted a URL the app could never register
  // (its one webhook slot was still held by the dead channel's URL) — createWebhook threw
  // WebhookLimitExceeded and took setupAllSubscriptions down with it, leaving zero
  // subscriptions and total silence from X.
  it("keys the webhook on the X user id, which survives delete + reconnect", () => {
    expect(byokWebhookUrl("https://link-dev.uni-scrm.com", "3245609912"))
      .toBe("https://link-dev.uni-scrm.com/x/webhook/3245609912");
  });

  it("gives the same URL before and after a reconnect that changes the channel row id", () => {
    const before = byokWebhookUrl("https://link-dev.uni-scrm.com", "3245609912");
    const after = byokWebhookUrl("https://link-dev.uni-scrm.com", "3245609912");
    expect(after).toBe(before);
  });
});

describe("XWebhookService signatures", () => {
  it("signs with the sha256=<base64> shape X uses in both directions", async () => {
    const sig = await new XWebhookService(SECRET).computeSignature("hello");
    expect(sig).toMatch(/^sha256=[A-Za-z0-9+/]+=*$/);
  });

  it("keeps computeCrcResponse and computeSignature the same primitive", async () => {
    const svc = new XWebhookService(SECRET);
    expect(await svc.computeCrcResponse("token-123")).toBe(await svc.computeSignature("token-123"));
  });

  it("accepts a signature it produced for the same body", async () => {
    const svc = new XWebhookService(SECRET);
    const body = JSON.stringify({ data: { event_type: "follow.follow" } });
    expect(await svc.verifySignature(body, await svc.computeSignature(body))).toBe(true);
  });

  it("rejects a body that was altered after signing", async () => {
    const svc = new XWebhookService(SECRET);
    const signed = await svc.computeSignature(JSON.stringify({ user_id: "1" }));
    expect(await svc.verifySignature(JSON.stringify({ user_id: "2" }), signed)).toBe(false);
  });

  it("rejects a signature made with another app's consumer secret", async () => {
    const body = "{}";
    const forged = await new XWebhookService("someone-elses-secret").computeSignature(body);
    expect(await new XWebhookService(SECRET).verifySignature(body, forged)).toBe(false);
  });

  // Fail closed: the BYOK path segment is a public X user id, so an unsigned POST must never
  // be treated as "X did not bother to sign this one".
  it("rejects a missing or empty header", async () => {
    const svc = new XWebhookService(SECRET);
    expect(await svc.verifySignature("{}", undefined)).toBe(false);
    expect(await svc.verifySignature("{}", null)).toBe(false);
    expect(await svc.verifySignature("{}", "")).toBe(false);
  });

  it("rejects a bare base64 digest with no sha256= prefix", async () => {
    const svc = new XWebhookService(SECRET);
    const full = await svc.computeSignature("{}");
    expect(await svc.verifySignature("{}", full.replace("sha256=", ""))).toBe(false);
  });
});
