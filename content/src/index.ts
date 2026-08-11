import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import { setTenantLlmCredentials, listConfiguredProviders, deleteTenantLlmCredentials, getDefaultModel, setDefaultModel } from "./services/llm-credentials";
import {
  listOpenAiModels,
  listAnthropicModels,
  listWorkersAiModels,
  OPENAI_STATIC_MODELS,
  ANTHROPIC_STATIC_MODELS,
} from "./services/model-catalog";
import { SKILL_CATALOG } from "./skills/catalog";
import { processVideoActionJob, type VideoActionQueueMessage } from "./queue-video-action";
import { createInternalAuthMiddleware, resolveAuthMe, resolveSession, spaLoginGuard } from "../../shared/auth";

export class SubtitleContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;

  override async startAndWaitForPorts(
    ...args: Parameters<Container<Env>["startAndWaitForPorts"]>
  ): Promise<void> {
    this.envVars = {
      R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: await this.env.R2_ACCESS_KEY_ID.get(),
      R2_SECRET_ACCESS_KEY: await this.env.R2_SECRET_ACCESS_KEY.get(),
      R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
    };
    return super.startAndWaitForPorts(...args);
  }
}

type HonoEnv = { Bindings: Env; Variables: { tenantId: string } };

const app = new Hono<HonoEnv>();
app.use("*", cors());

// Shared fail-closed implementation; content's historical 403 {"error":"Forbidden"}
// shape is preserved via opts (flow/admin answer 401 — see shared/auth.ts).
const internalAuthMiddleware = createInternalAuthMiddleware({ status: 403, error: "Forbidden" });

// Session resolution via shared/auth.ts against the WEB_DB binding — no HTTP hop to web.
async function sessionAuth(c: any, next: any) {
  const session = await resolveSession(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("tenantId", session.tenantId);
  await next();
}

app.use("/internal/*", internalAuthMiddleware);
app.route("/internal", internalRoutes());

app.get("/health", (c) => c.json({ status: "ok" }));

// Answered locally from WEB_DB (shared/auth.ts). content previously had no /me route at
// all, so the shared Nav/Sidebar/useLocale fetches to /api/auth/me on content pages 404'd.
app.get("/api/auth/me", async (c) => {
  const me = await resolveAuthMe(c.env.WEB_DB, c.req.raw.headers.get("Cookie"));
  if (!me) return c.json({ error: "Unauthorized" }, 401);
  return c.json(me);
});

// The media bucket's lifecycle rule expires every object after 48h (dev and prod alike), so a
// miss here is the EXPECTED state for any link older than that -- a Video Action node's analytics
// row, a published post -- not a broken URL. Say which it is instead of returning a bare 404.
const MEDIA_RETENTION_HOURS = 48;

app.get("/public/media/:key", async (c) => {
  const object = await c.env.MEDIA_BUCKET.get(c.req.param("key"));
  if (!object) {
    const message = `Videos produced by a flow are kept for ${MEDIA_RETENTION_HOURS} hours and then deleted, so this one is no longer available.`;
    if ((c.req.header("Accept") || "").includes("text/html")) {
      return c.html(`<!doctype html><meta charset="utf-8"><title>Video expired</title><h1>Video expired</h1><p>${message}</p>`, 404);
    }
    return c.text(message, 404);
  }
  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
  });
});

// Hono's `/*` wildcard also matches the exact parent path, so a single middleware
// registration here covers both "/api/llm-credentials" and "/api/llm-credentials/:provider"
// (registering both "/api/llm-credentials" and "/api/llm-credentials/*" would run sessionAuth
// twice for the base path, double-consuming its internal fetch() Response body).
app.use("/api/llm-credentials/*", sessionAuth);

app.get("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers = await listConfiguredProviders(c.env, tenantId);
  const defaultModel = await getDefaultModel(c.env, tenantId);
  return c.json({ providers, defaultModel });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model } = await c.req.json<{ provider: "openai" | "anthropic" | "default"; apiKey?: string; model: string }>();
  if (!provider || !model) return c.json({ error: "provider, model required" }, 400);
  if (provider === "default") {
    // imageModel is null for now -- Task 3 threads the real per-provider image model
    // through this route and its request body.
    await setDefaultModel(c.env, tenantId, model, null);
    return c.json({ ok: true });
  }
  if (!apiKey) return c.json({ error: "apiKey required for this provider" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model, null);
  return c.json({ ok: true });
});

app.delete("/api/llm-credentials/:provider", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const provider = c.req.param("provider") as "openai" | "anthropic";
  await deleteTenantLlmCredentials(c.env, tenantId, provider);
  return c.json({ ok: true });
});

app.use("/api/skills/*", sessionAuth);

app.get("/api/skills", async (c) => {
  const cached = await c.env.CONTENT_DB.prepare("SELECT skill_id FROM skill_content_cache").all<{ skill_id: string }>();
  const cachedIds = new Set(cached.results.map((r) => r.skill_id));
  const skills = SKILL_CATALOG.map((s) => ({ id: s.id, label: s.label, hasCachedContent: cachedIds.has(s.id) }));
  return c.json({ skills });
});

app.use("/api/llm-models", sessionAuth);

app.post("/api/llm-models", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey } = await c.req.json<{ provider: "openai" | "anthropic" | "default"; apiKey?: string }>();

  if (provider === "default") {
    try {
      return c.json({ models: await listWorkersAiModels(c.env), source: "live" });
    } catch (err) {
      console.error(JSON.stringify({ event: "llm_models_list_failed", tenantId, provider, error: String(err) }));
      return c.json({ error: "Could not fetch model list" }, 502);
    }
  }

  // BYOK providers: listing their actual models requires a valid key, so without one (or
  // if the live call fails) fall back to the curated static catalog rather than erroring --
  // the model dropdown should always be usable, key or no key.
  const staticModels = provider === "openai" ? OPENAI_STATIC_MODELS : ANTHROPIC_STATIC_MODELS;
  if (!apiKey) return c.json({ models: staticModels, source: "static" });

  try {
    const models = provider === "openai" ? await listOpenAiModels(apiKey) : await listAnthropicModels(apiKey);
    return c.json({ models, source: "live" });
  } catch (err) {
    console.error(JSON.stringify({ event: "llm_models_live_fetch_failed", tenantId, provider, error: String(err) }));
    return c.json({ models: staticModels, source: "static" });
  }
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth redirect for HTML pages
    const accept = request.headers.get("Accept") || "";
    const loginRedirect = await spaLoginGuard(request, env.WEB_DB, env.WEB_URL, ["/api", "/internal", "/public"]);
    if (loginRedirect) return loginRedirect;

    // Serve static assets first for non-API paths
    if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/internal") && !url.pathname.startsWith("/health") && !url.pathname.startsWith("/public") && env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    }

    const res = await app.fetch(request, env);
    // The SPA fallback is for client-routed app pages only. /public/* is a real resource
    // namespace, so a 404 there is a real answer that must reach the visitor -- serving
    // index.html instead silently dropped anyone opening an expired media link onto the app's
    // default page (AI Content Settings), with no hint that the video had expired.
    if (res.status === 404 && accept.includes("text/html") && !url.pathname.startsWith("/public") && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    }
    return res;
  },

  async queue(batch: MessageBatch<VideoActionQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processVideoActionJob(env, message.body);
    }
  },
};
