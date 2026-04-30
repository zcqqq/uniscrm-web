import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware } from "./auth/middleware";
import { createContentsRouter } from "./api/contents";
import { createChannelsRouter, createNotionCallbackRouter } from "./api/channels";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/channels", createNotionCallbackRouter());

app.use("/api/*", authMiddleware);

app.get("/api/auth/me", (c) => {
  return c.json({ email: c.get("email" as never) });
});

app.post("/api/auth/logout", async (c) => {
  const { getCookie, deleteCookie } = await import("hono/cookie");
  const sessionId = getCookie(c, "session");
  if (sessionId) {
    await c.env.KV.delete(`session:${sessionId}`);
    deleteCookie(c, "session");
  }
  return c.json({ ok: true });
});

app.route("/api/contents", createContentsRouter());
app.route("/api/channels", createChannelsRouter());

app.all("/*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
};
