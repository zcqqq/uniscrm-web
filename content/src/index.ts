import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { setTenantLlmCredentials, listConfiguredProviders, deleteTenantLlmCredentials } from "./services/llm-credentials";

type HonoEnv = { Bindings: Env; Variables: { tenantId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

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

// Hono's `/*` wildcard also matches the exact parent path, so a single middleware
// registration here covers both "/api/llm-credentials" and "/api/llm-credentials/:provider"
// (registering both "/api/llm-credentials" and "/api/llm-credentials/*" would run sessionAuth
// twice for the base path, double-consuming its internal fetch() Response body).
app.use("/api/llm-credentials/*", sessionAuth);

app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers = await listConfiguredProviders(c.env, tenantId);
  return c.json({ providers });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model } = await c.req.json<{ provider: "openai" | "anthropic"; apiKey: string; model: string }>();
  if (!provider || !apiKey || !model) return c.json({ error: "provider, apiKey, model required" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model);
  return c.json({ ok: true });
});

app.delete("/api/llm-credentials/:provider", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const provider = c.req.param("provider") as "openai" | "anthropic";
  await deleteTenantLlmCredentials(c.env, tenantId, provider);
  return c.json({ ok: true });
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth redirect for HTML pages
    const accept = request.headers.get("Accept") || "";
    if (accept.includes("text/html") && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/internal")) {
      const sessionCookie = getCookieValue(request, "session");
      if (!sessionCookie) {
        return Response.redirect(`${env.WEB_URL}/login`, 302);
      }
      const authRes = await fetch(`${env.WEB_URL}/api/auth/me`, {
        headers: { Cookie: `session=${sessionCookie}` },
      });
      if (!authRes.ok) {
        return Response.redirect(`${env.WEB_URL}/login`, 302);
      }
    }

    // Serve static assets first for non-API paths
    if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/internal") && !url.pathname.startsWith("/health") && env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    }

    const res = await app.fetch(request, env);
    if (res.status === 404 && accept.includes("text/html") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }
    return res;
  },
};
