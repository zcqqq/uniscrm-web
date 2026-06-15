import { Hono } from "hono";
import type { Env } from "./types";
import { internalAuth } from "./middleware/internal-auth";
import { plansRoute } from "./routes/plans";
import { subscriptionRoute } from "./routes/subscription";
import { checkoutRoute } from "./routes/checkout";
import { cancelRoute } from "./routes/cancel";
import { portalRoute } from "./routes/portal";
import { webhookRoute } from "./routes/webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/internal/*", internalAuth);
app.get("/internal/plans", plansRoute);
app.get("/internal/subscription/:tenantId", subscriptionRoute);
app.post("/internal/subscriptions/create", checkoutRoute);
app.post("/internal/subscriptions/cancel", cancelRoute);
app.post("/internal/portal/create", portalRoute);

app.post("/webhooks/stripe", webhookRoute);

export default { fetch: app.fetch };
