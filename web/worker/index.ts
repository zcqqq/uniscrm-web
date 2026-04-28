import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createContentsRouter } from "./api/contents";
import { authMiddleware } from "./auth/middleware";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());

app.use("/api/contents/*", authMiddleware);
app.route("/api/contents", createContentsRouter());

export default {
  fetch: app.fetch,
};
