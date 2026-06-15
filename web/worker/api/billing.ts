import { Hono } from "hono";
import type { Env } from "../types";
import { BillingService } from "../services/billing";

export function createBillingRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/plans", async (c) => {
    const svc = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);
    const plans = await svc.getPlans();
    return c.json({ plans });
  });

  router.get("/subscription", async (c) => {
    const tenantId = c.get("tenantId" as never) as string;
    const svc = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);
    const sub = await svc.getSubscription(tenantId);
    return c.json(sub);
  });

  router.post("/subscribe", async (c) => {
    const tenantId = c.get("tenantId" as never) as string;
    const { tier } = await c.req.json<{ tier: string }>();
    const svc = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);

    const returnUrl = `${c.env.APP_URL}/api/billing/return`;
    const cancelUrl = `${c.env.APP_URL}/billing?cancelled=true`;

    const result = await svc.createSubscription(tenantId, tier, returnUrl, cancelUrl);
    return c.json(result);
  });

  router.get("/return", async (c) => {
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.redirect("/billing?error=missing_session");
    }
    return c.redirect("/billing?success=true");
  });

  router.post("/cancel", async (c) => {
    const tenantId = c.get("tenantId" as never) as string;
    const svc = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);
    await svc.cancelSubscription(tenantId);
    return c.json({ ok: true });
  });

  router.post("/portal", async (c) => {
    const tenantId = c.get("tenantId" as never) as string;
    const svc = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);
    const returnUrl = `${c.env.APP_URL}/billing`;
    const result = await svc.createPortalSession(tenantId, returnUrl);
    return c.json(result);
  });

  return router;
}
