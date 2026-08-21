import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { checkoutRoute } from "../../src/routes/checkout";
import { SubscriptionDB } from "../../src/services/subscription-db";
import * as stripeService from "../../src/services/stripe";
import type { Env } from "../../src/types";

// Stripe 收银台的语言。以前这里什么都不传，Stripe 就按浏览器的 Accept-Language 猜——中文浏览器
// 看到中文收银台，付款没走完被打回我们的英文 /billing 页，用户以为「页面变成英文了」
// （2026-08-20 租户 100005）。现在由 web 侧按下单人的 member.language 指定。
describe("checkoutRoute locale", () => {
  let createSession: ReturnType<typeof vi.spyOn>;

  function makeApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.use("/*", (c, next) => {
      (c.env as unknown) = {
        WEB_DB: {
          prepare: () => ({ bind: () => ({ first: async () => ({ email: "u@example.com" }) }) }),
        },
        ADMIN_DB: {},
        STRIPE_SECRET_KEY: "sk_test_x",
        STRIPE_PRICE_BASIC: "price_basic",
        STRIPE_PRICE_PRO: "price_pro",
      };
      return next();
    });
    app.post("/create", checkoutRoute);
    return app;
  }

  async function post(body: Record<string, unknown>) {
    return makeApp().request("/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: "100005", tier: "pro", return_url: "https://r", cancel_url: "https://c", ...body }),
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(stripeService, "createStripeClient").mockReturnValue({} as never);
    vi.spyOn(stripeService, "findOrCreateCustomer").mockResolvedValue("cus_x");
    vi.spyOn(SubscriptionDB.prototype, "upsert").mockResolvedValue(undefined as never);
    createSession = vi.spyOn(stripeService, "createCheckoutSession").mockResolvedValue("https://checkout.stripe.com/x");
  });

  it("passes zh straight through", async () => {
    const res = await post({ locale: "zh" });
    expect(res.status).toBe(200);
    expect(createSession.mock.calls[0][1]).toMatchObject({ locale: "zh" });
  });

  it("passes en straight through", async () => {
    await post({ locale: "en" });
    expect(createSession.mock.calls[0][1]).toMatchObject({ locale: "en" });
  });

  // 没传就回落 "auto"（Stripe 按浏览器猜），保住老调用方的行为。
  it("falls back to auto when the caller sends no locale", async () => {
    await post({});
    expect(createSession.mock.calls[0][1]).toMatchObject({ locale: "auto" });
  });

  // Stripe 对无效 locale 是直接报错的，别把没校验过的字符串递过去。
  it("falls back to auto for a locale we do not ship", async () => {
    await post({ locale: "ja" });
    expect(createSession.mock.calls[0][1]).toMatchObject({ locale: "auto" });
    await post({ locale: "zh-TW" });
    expect(createSession.mock.calls[1][1]).toMatchObject({ locale: "auto" });
  });
});
