import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";

export function internalRoutes() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/generate", async (c) => {
    const { tenantId, skillId, material, targetPlatform } = await c.req.json<{
      tenantId: number;
      skillId: string;
      material: { title?: string; content_text?: string; summary?: string };
      targetPlatform: "X" | "TIKTOK";
    }>();

    if (!tenantId || !skillId || !targetPlatform) {
      return c.json({ error: "tenantId, skillId, targetPlatform required" }, 400);
    }

    try {
      const text = await generateContent(c.env, { tenantId, skillId, material: material || {}, targetPlatform });
      return c.json({ text });
    } catch (err) {
      if (String(err).includes("Unknown skill")) {
        return c.json({ error: String(err) }, 400);
      }
      console.error(JSON.stringify({ event: "generate_failed", tenantId, skillId, error: String(err) }));
      return c.json({ error: "Generation failed" }, 502);
    }
  });

  return router;
}
