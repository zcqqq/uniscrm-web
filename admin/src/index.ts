import { Hono } from "hono";
import type { Env } from "./types";
import { internalAuth } from "./middleware/internal-auth";
import { plansRoute } from "./routes/plans";
import { subscriptionRoute } from "./routes/subscription";
import { creditUsageRoute } from "./routes/credit-usage";
import { checkoutRoute } from "./routes/checkout";
import { cancelRoute } from "./routes/cancel";
import { portalRoute } from "./routes/portal";
import { webhookRoute } from "./routes/webhook";
import { activateTrialRoute } from "./routes/activate-trial";
import { TenantProvisioning } from "./services/tenant-provisioning";
import { SubscriptionDB } from "./services/subscription-db";
import { accessAuth } from "./middleware/access-auth";
import { tmsXUsageRoute } from "./routes/tms-x-usage";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/internal/*", internalAuth);
app.get("/internal/plans", plansRoute);
app.get("/internal/subscription/:tenantId", subscriptionRoute);
app.get("/internal/credit-usage/:tenantId", creditUsageRoute);
app.post("/internal/subscriptions/create", checkoutRoute);
app.post("/internal/subscriptions/cancel", cancelRoute);
app.post("/internal/subscriptions/activate-trial", activateTrialRoute);
app.post("/internal/portal/create", portalRoute);

app.post("/internal/tenants/:tenantId/provision-db", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId"), 10);
  if (!tenantId) return c.json({ error: "Invalid tenant_id" }, 400);
  const env = c.env.ENVIRONMENT === "production" ? "production" as const : "dev" as const;
  const provisioning = new TenantProvisioning(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, c.env.WEB_DB, env);
  const existing = await provisioning.getTenantDbId(tenantId);
  if (existing) return c.json({ d1_database_id: existing });
  const dbId = await provisioning.provisionDatabase(tenantId);
  return c.json({ d1_database_id: dbId }, 201);
});

app.post("/webhooks/stripe", webhookRoute);

// TMS 管理控制台。第一道防线是 Cloudflare Access（边缘），accessAuth 是第二道。
// 一条就够：实测（hono ^4.7.0）"/tms/*" 同时匹配裸 "/tms" 和它下面的所有路径。
// 反过来只挂 "/tms" 才是洞 —— 那样 /tms/api/x-usage 完全不过中间件。
// 曾经写成 "/tms" + "/tms/*" 两条，结果裸 "/tms" 每次请求把 JWKS 拉取和验签跑两遍。
app.use("/tms/*", accessAuth);
app.get("/tms/api/x-usage", tmsXUsageRoute);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const db = new SubscriptionDB(env.ADMIN_DB);
    const expired = await db.expireNonStripeSubscriptions(env.LINK_DB);
    if (expired > 0) {
      console.log(JSON.stringify({ event: "subscriptions_expired", count: expired }));
    }
  },
};
