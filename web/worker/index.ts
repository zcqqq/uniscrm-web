import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createOAuthRouter } from "./api/oauth";

import { createRecommendationsRouter } from "./api/recommendations";
import { createWebhookRouter } from "./api/webhook";
import { createSettingsRouter } from "./api/settings";
import { authMiddleware } from "./auth/middleware";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());
app.route("/api/auth", createOAuthRouter());

app.use("/api/recommendations/*", authMiddleware);
app.route("/api/recommendations", createRecommendationsRouter());

app.use("/api/settings/*", authMiddleware);
app.use("/api/settings", authMiddleware);
app.route("/api/settings", createSettingsRouter());

app.route("/api/webhook", createWebhookRouter());



app.all("/*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  }
  return res;
});

export default {
  fetch: app.fetch,
};
