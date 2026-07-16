import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware, internalAuthMiddleware } from "./middleware";
import { channelsRoutes } from "./routes-channels";
import { usersRoutes } from "./routes-users";
import { contentsRoutes } from "./routes-contents";
import { productsRoutes } from "./routes-products";
import { listsRoutes } from "./routes-lists";
import { internalRoutes } from "./routes-internal";
import { oauthRoutes } from "./oauth";
import { webhookRoutes } from "./webhook";
import { handleCron } from "./cron";
import { createModuleGuard } from "../../shared/plan-guard";
import { getActiveSubscriptionTier } from "../../shared/credit-service";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));
app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/public/media/:key", async (c) => {
  const object = await c.env.MEDIA_BUCKET.get(c.req.param("key"));
  if (!object) return c.notFound();
  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
  });
});

// Public: X webhook
app.route("/x", webhookRoutes());

// Public: OAuth connect/callback flows (e.g. /api/auth/x/connect, /api/auth/x/callback)
app.route("/api/auth", oauthRoutes());

// Internal: secret-authenticated endpoints
app.use("/internal/*", internalAuthMiddleware);
app.route("/internal", internalRoutes());

// Authenticated: API routes
app.use("/api/*", authMiddleware);
app.get("/api/auth/me", (c) => c.json({ member: { email: c.get("email" as never) } }));
app.post("/api/auth/logout", (c) => c.json({ ok: true }));
app.route("/api/channels", channelsRoutes());
app.route("/api/users", usersRoutes());
app.route("/api/content", contentsRoutes());

const resolveTier = async (c: any) => {
  const tenantId = c.get("tenantId" as never) as number;
  const sub = await getActiveSubscriptionTier(c.env.ADMIN_DB, tenantId);
  return sub?.tier ?? null;
};
app.use("/api/commerce/*", createModuleGuard("commerce", resolveTier));
app.use("/api/lists/*", createModuleGuard("social.lists", resolveTier));

app.route("/api/commerce", productsRoutes());
app.route("/api/lists", listsRoutes());

// SPA fallback
app.all("/*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
    return c.json({ error: "Not Found" }, 404);
  }
  const assetUrl = new URL(url.pathname, c.req.url);
  let res = await c.env.ASSETS.fetch(assetUrl.toString());
  if (!res.ok) {
    res = await c.env.ASSETS.fetch(new URL("/index.html", c.req.url).toString());
  }
  return res;
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(env));
  },
};
