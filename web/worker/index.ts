import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createOAuthRouter } from "./api/oauth";
import { PendingTaskService } from "./services/pending-tasks";
import { executePendingTask } from "./services/task-executor";

import { createRecommendationsRouter } from "./api/recommendations";
import { createWebhookRouter } from "./api/webhook";
import { createSettingsRouter } from "./api/settings";
import { createBillingRouter } from "./api/billing";
import { authMiddleware } from "./auth/middleware";
import { createModuleGuard } from "../../shared/plan-guard";
import { BillingService } from "./services/billing";
import type { Tier } from "../../shared/plans";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());
app.route("/api/auth", createOAuthRouter());

app.use("/api/recommendations/*", authMiddleware);
app.use("/api/recommendations/*", createModuleGuard("content.recommendations", async (c) => {
  const tenantId = c.get("tenantId" as never) as number;
  const billing = new BillingService(c.env.ADMIN_URL, c.env.INTERNAL_SECRET);
  try {
    const sub = await billing.getSubscription(String(tenantId));
    return sub.tier === "basic" || sub.tier === "pro" ? (sub.tier as Tier) : null;
  } catch {
    return null;
  }
}));
app.route("/api/recommendations", createRecommendationsRouter());

app.use("/api/settings/*", authMiddleware);
app.use("/api/settings", authMiddleware);
app.route("/api/settings", createSettingsRouter());

app.route("/api/webhook", createWebhookRouter());

app.use("/api/billing/*", authMiddleware);
app.use("/api/billing", authMiddleware);
app.route("/api/billing", createBillingRouter());



app.all("/*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  }
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const tasks = new PendingTaskService(env.WEB_DB);
    const pending = await tasks.getRetryable(new Date().toISOString());
    for (const task of pending) {
      if (task.retry_count >= 5) {
        console.error(
          `CRITICAL: Task ${task.id} (${task.task_type}) exhausted after 5 retries. Payload: ${task.payload}`
        );
        continue;
      }
      await executePendingTask(env, tasks, task.id);
    }
  },
};
