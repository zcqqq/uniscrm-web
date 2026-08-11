import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { internalRoutes } from "./routes-internal";
import {
  setTenantLlmCredentials,
  listConfiguredProviders,
  deleteTenantLlmCredentials,
  getDefaultModel,
  setDefaultModel,
  getDefaultImageModel,
} from "./services/llm-credentials";
import {
  listOpenAiModels,
  listAnthropicModels,
  listWorkersAiModels,
  listWorkersAiImageModels,
  listOpenAiImageModels,
  listAnthropicImageModels,
  OPENAI_STATIC_MODELS,
  ANTHROPIC_STATIC_MODELS,
  OPENAI_STATIC_IMAGE_MODELS,
  ANTHROPIC_STATIC_IMAGE_MODELS,
} from "./services/model-catalog";
import { SKILL_CATALOG, MARKETING_SKILLS_REPO } from "./skills/catalog";
import {
  draftMarketingContext,
  chatMarketingContext,
  type ChatMessage,
} from "./services/marketing-context";
import { getSkillContextRow, setSkillContext } from "./services/skill-context";
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
  const defaultImageModel = await getDefaultImageModel(c.env, tenantId);
  return c.json({ providers, defaultModel, defaultImageModel });
});

app.put("/api/llm-credentials", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { provider, apiKey, model, imageModel } = await c.req.json<{
    provider: "openai" | "anthropic" | "default"; apiKey?: string; model: string; imageModel?: string | null;
  }>();
  if (!provider || !model) return c.json({ error: "provider, model required" }, 400);
  if (provider === "default") {
    await setDefaultModel(c.env, tenantId, model, imageModel ?? null);
    return c.json({ ok: true });
  }
  if (!apiKey) return c.json({ error: "apiKey required for this provider" }, 400);
  await setTenantLlmCredentials(c.env, tenantId, provider, apiKey, model, imageModel ?? null);
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
  const { provider, apiKey, kind } = await c.req.json<{
    provider: "openai" | "anthropic" | "default";
    apiKey?: string;
    kind?: "text" | "image";
  }>();
  const wantsImage = kind === "image";

  if (provider === "default") {
    try {
      const models = wantsImage ? await listWorkersAiImageModels(c.env) : await listWorkersAiModels(c.env);
      return c.json({ models, source: "live" });
    } catch (err) {
      console.error(JSON.stringify({ event: "llm_models_list_failed", tenantId, provider, kind: kind ?? "text", error: String(err) }));
      return c.json({ error: "Could not fetch model list" }, 502);
    }
  }

  // BYOK providers: listing their actual models requires a valid key, so without one (or
  // if the live call fails) fall back to the curated static catalog rather than erroring --
  // the model dropdown should always be usable, key or no key.
  const staticModels = wantsImage
    ? (provider === "openai" ? OPENAI_STATIC_IMAGE_MODELS : ANTHROPIC_STATIC_IMAGE_MODELS)
    : (provider === "openai" ? OPENAI_STATIC_MODELS : ANTHROPIC_STATIC_MODELS);
  if (!apiKey) return c.json({ models: staticModels, source: "static" });

  try {
    const models = wantsImage
      ? (provider === "openai" ? await listOpenAiImageModels(apiKey) : await listAnthropicImageModels(apiKey))
      : (provider === "openai" ? await listOpenAiModels(apiKey) : await listAnthropicModels(apiKey));
    return c.json({ models, source: "live" });
  } catch (err) {
    console.error(JSON.stringify({ event: "llm_models_live_fetch_failed", tenantId, provider, kind: kind ?? "text", error: String(err) }));
    return c.json({ models: staticModels, source: "static" });
  }
});

app.use("/api/image-providers", sessionAuth);

// flow 的图片 provider 下拉的唯一数据源。规则：default 恒在（其图片模型是初始配置值，
// 不是兜底）；BYOK provider 当且仅当同时有 key 与非空 image_model 时列出——没配图片
// 模型的 provider 在 flow 里就是选不到，而不是选了之后运行时才失败。
app.get("/api/image-providers", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const providers: { provider: string; model: string }[] = [
    { provider: "default", model: await getDefaultImageModel(c.env, tenantId) },
  ];
  for (const row of await listConfiguredProviders(c.env, tenantId)) {
    if (row.imageModel) providers.push({ provider: row.provider, model: row.imageModel });
  }
  return c.json({ providers });
});

// `/*` 通配注册——同上一条注释：只注册一次通配形式，不要再加裸路径
// "/api/marketing-context"，否则 sessionAuth 会跑两次并二次消费其内部 fetch() 的 Response body。
// Task 6 在这条注册之下加 GET/PUT /api/marketing-context，同样受这一次注册覆盖。
app.use("/api/marketing-context/*", sessionAuth);

app.post("/api/marketing-context/draft", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  try {
    return c.json({ draft: await draftMarketingContext(c.env, tenantId) });
  } catch (err) {
    console.error(JSON.stringify({ event: "marketing_context_draft_failed", tenantId, error: String(err) }));
    return c.json({ error: "Draft failed" }, 502);
  }
});

app.get("/api/marketing-context", async (c) => {
  const row = await getSkillContextRow(c.env, Number(c.get("tenantId")), MARKETING_SKILLS_REPO);
  return c.json({ content: row?.content ?? null, version: row?.version ?? null, updatedAt: row?.updatedAt ?? null });
});

app.put("/api/marketing-context", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { content, baseVersion } = await c.req.json<{ content: string; baseVersion?: number }>();
  if (!content || !content.trim()) return c.json({ error: "content required" }, 400);

  // 乐观并发：两个标签页各改各的时，后写的不该无声覆盖前一个。
  const current = await getSkillContextRow(c.env, tenantId, MARKETING_SKILLS_REPO);
  if (baseVersion !== undefined && current && current.version !== baseVersion) {
    return c.json({ error: "version conflict", currentVersion: current.version }, 409);
  }

  return c.json(await setSkillContext(c.env, tenantId, MARKETING_SKILLS_REPO, content));
});

app.post("/api/marketing-context/chat", async (c) => {
  const tenantId = Number(c.get("tenantId"));
  const { messages } = await c.req.json<{ messages: ChatMessage[] }>();
  if (!Array.isArray(messages) || messages.length === 0) return c.json({ error: "messages required" }, 400);
  try {
    return c.json({ reply: await chatMarketingContext(c.env, tenantId, messages) });
  } catch (err) {
    console.error(JSON.stringify({ event: "marketing_context_chat_failed", tenantId, error: String(err) }));
    return c.json({ error: "Chat failed" }, 502);
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
