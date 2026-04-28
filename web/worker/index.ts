import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

export default {
  fetch: app.fetch,
};
