import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>();
app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
