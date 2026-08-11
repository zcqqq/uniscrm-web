import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";
import { generateImage } from "./services/generate-image";
import { refreshSkillContent } from "./services/skill-content";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/generate", async (c) => {
    const { tenantId, prompt, provider, skillId, operationContext } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai" | "anthropic";
      skillId?: string;
      operationContext?: string;
    }>();

    if (!tenantId || !prompt || !provider) {
      return c.json({ error: "tenantId, prompt, provider required" }, 400);
    }

    try {
      const text = await generateContent(c.env, { tenantId, prompt, provider, skillId, operationContext });
      return c.json({ text });
    } catch (err) {
      if (String(err).includes("No") && String(err).includes("credentials configured")) {
        return c.json({ error: String(err) }, 400);
      }
      console.error(JSON.stringify({ event: "generate_failed", tenantId, provider, error: String(err) }));
      return c.json({ error: "Generation failed" }, 502);
    }
  });

  router.post("/generate-image", async (c) => {
    const { tenantId, prompt, provider } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai";
    }>();

    if (!tenantId || !prompt || !provider) {
      return c.json({ error: "tenantId, prompt, provider required" }, 400);
    }

    try {
      const { bytes, contentType } = await generateImage(c.env, { tenantId, prompt, provider });
      const key = crypto.randomUUID();
      await c.env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      return c.json({ url: `${c.env.CONTENT_URL}/public/media/${key}` });
    } catch (err) {
      const message = String(err);
      // 配置问题（没选图片模型 / 没有 key）是 400：调用方据此知道这是用户配置错、
      // 不是模型抽风，不值得重试。
      if (message.includes("No image model configured") || message.includes("credentials configured")) {
        return c.json({ error: message }, 400);
      }
      console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: message }));
      return c.json({ error: "Image generation failed" }, 502);
    }
  });

  // Manual, developer-triggered refresh of a skill's cached content from its source
  // (e.g. a public GitHub repo). Never called from the generation hot path.
  router.post("/skills/:id/refresh", async (c) => {
    const skillId = c.req.param("id");
    try {
      await refreshSkillContent(c.env, skillId);
      return c.json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ event: "skill_refresh_failed", skillId, error: String(err) }));
      return c.json({ error: String(err) }, 502);
    }
  });

  return router;
}
