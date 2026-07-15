import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { SKILL_CATALOG } from "./skills";
import { getTenantLlmCredentials, setTenantLlmCredentials, hasTenantLlmCredentials } from "./services/llm-credentials";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

async function internalAuthMiddleware(c: any, next: any) {
  const secret = c.req.header("X-Internal-Secret");
  if (secret !== c.env.INTERNAL_SECRET) {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
}

async function sessionAuth(c: any, next: any) {
  const cookie = c.req.raw.headers.get("Cookie") || "";
  const res = await fetch(`${c.env.WEB_URL}/api/auth/me`, { headers: { Cookie: cookie } });
  if (!res.ok) return c.json({ error: "Unauthorized" }, 401);
  const data = (await res.json()) as { member?: { id?: string }; tenant?: { id?: string } };
  if (!data.member?.id || !data.tenant?.id) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", data.tenant.id);
  await next();
}

app.use("/internal/*", internalAuthMiddleware);
app.route("/internal", internalRoutes());

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/api/skills", (c) => {
  return c.json({ skills: SKILL_CATALOG.map((s) => ({ id: s.id, label: s.label })) });
});

app.use("/api/llm-credentials", sessionAuth);

app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const credentials = await hasTenantLlmCredentials(c.env, tenantId);
  return c.json({ credentials });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey } = await c.req.json<{ provider: "openai" | "anthropic"; apiKey: string }>();
  if (!provider || !apiKey) return c.json({ error: "provider and apiKey required" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey);
  return c.json({ ok: true });
});

export default app;
