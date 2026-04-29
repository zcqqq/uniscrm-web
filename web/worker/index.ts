import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createContentsRouter } from "./api/contents";
import { createRecommendationsRouter } from "./api/recommendations";
import { createWebhookRouter } from "./api/webhook";
import { authMiddleware } from "./auth/middleware";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());

app.use("/api/contents/*", authMiddleware);
app.route("/api/contents", createContentsRouter());

app.use("/api/recommendations/*", authMiddleware);
app.route("/api/recommendations", createRecommendationsRouter());

app.route("/api/webhook", createWebhookRouter());


app.all("/*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
};
