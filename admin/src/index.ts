import { Hono } from "hono";
import type { Env } from "./types";
import { internalAuth } from "./middleware/internal-auth";
import { plansRoute } from "./routes/plans";
import { subscriptionRoute } from "./routes/subscription";
import { checkoutRoute } from "./routes/checkout";
import { cancelRoute } from "./routes/cancel";
import { portalRoute } from "./routes/portal";
import { webhookRoute } from "./routes/webhook";
import { TenantProvisioning } from "./services/tenant-provisioning";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/internal/*", internalAuth);
app.get("/internal/plans", plansRoute);
app.get("/internal/subscription/:tenantId", subscriptionRoute);
app.post("/internal/subscriptions/create", checkoutRoute);
app.post("/internal/subscriptions/cancel", cancelRoute);
app.post("/internal/portal/create", portalRoute);

app.post("/internal/tenants/:tenantId/provision-db", async (c) => {
  const tenantId = parseInt(c.req.param("tenantId"), 10);
  if (!tenantId) return c.json({ error: "Invalid tenant_id" }, 400);
  const provisioning = new TenantProvisioning(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, c.env.DB);
  const existing = await provisioning.getTenantDbId(tenantId);
  if (existing) return c.json({ d1_database_id: existing });
  const dbId = await provisioning.provisionDatabase(tenantId);
  return c.json({ d1_database_id: dbId }, 201);
});

app.post("/webhooks/stripe", webhookRoute);

export default { fetch: app.fetch };
