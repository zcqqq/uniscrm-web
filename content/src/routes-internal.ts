import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";
import { generateImage } from "./services/generate-image";
import { refreshSkillContent } from "./services/skill-content";
import { detectFace } from "./services/vision";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/generate", async (c) => {
    const { tenantId, prompt, provider, skillId } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai" | "anthropic";
      skillId?: string;
    }>();

    if (!tenantId || !prompt || !provider) {
      return c.json({ error: "tenantId, prompt, provider required" }, 400);
    }

    try {
      const text = await generateContent(c.env, { tenantId, prompt, provider, skillId });
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
    const { tenantId, prompt, provider, skillId } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai";
      skillId?: string;
    }>();

    if (!tenantId || !prompt || !provider) {
      return c.json({ error: "tenantId, prompt, provider required" }, 400);
    }

    try {
      const { bytes, contentType } = await generateImage(c.env, { tenantId, prompt, provider, skillId });
      const key = crypto.randomUUID();
      await c.env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      return c.json({ url: `${c.env.CONTENT_URL}/public/media/${key}` });
    } catch (err) {
      console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: String(err) }));
      return c.json({ error: "Image generation failed" }, 502);
    }
  });

  // moondream's "detect" task serves as a face-detection proxy (Workers AI has no dedicated face-detection model)
  router.post("/detect-face", async (c) => {
    const { imageUrl } = await c.req.json<{ imageUrl?: string }>();
    if (!imageUrl) {
      return c.json({ error: "imageUrl required" }, 400);
    }
    try {
      const hasFace = await detectFace(c.env.AI, imageUrl);
      return c.json({ hasFace });
    } catch (err) {
      console.error(JSON.stringify({ event: "detect_face_failed", error: String(err) }));
      return c.json({ error: "Detection failed" }, 502);
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
