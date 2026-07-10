import type { Context } from "hono";
import type { Env } from "../types";
import { CreditService } from "../../../shared/credit-service";
import { SubscriptionDB } from "../services/subscription-db";
import type { Tier } from "../../../shared/plans";

export async function creditUsageRoute(c: Context<{ Bindings: Env }>) {
  const tenantId = parseInt(c.req.param("tenantId")!, 10);
  if (!tenantId) return c.json({ error: "Invalid tenant_id" }, 400);

  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);

  const subDb = new SubscriptionDB(c.env.ADMIN_DB);
  const sub = await subDb.getByTenantId(String(tenantId));
  if (!sub || (sub.tier !== "basic" && sub.tier !== "pro")) {
    return c.json({
      tier: sub?.tier ?? "free",
      monthlyCreditMicros: 0,
      usedMicros: 0,
      balanceMicros: 0,
      periodStart: null,
      periodEnd: null,
      entries: [],
      total: 0,
    });
  }

  const creditSvc = new CreditService(c.env.ADMIN_DB);
  const balance = await creditSvc.getBalance(tenantId, sub.tier as Tier, sub.created_at);
  const { entries, total } = await creditSvc.listUsage(tenantId, { limit, offset });

  return c.json({ ...balance, entries, total });
}
