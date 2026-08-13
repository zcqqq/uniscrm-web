import { Hono } from "hono";
import type { Env } from "./types";
import { generateContent } from "./services/generate";
import { generateImage } from "./services/generate-image";
import { refreshSkillContent } from "./services/skill-content";
import { SKILL_CATALOG } from "./skills/catalog";

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
    const { tenantId, provider, sourceTitle, sourceText } = await c.req.json<{
      tenantId: number;
      provider: "default" | "openai";
      sourceTitle?: string;
      sourceText?: string;
    }>();

    // 不再接受 prompt：调用方拼出的自由文本没有长度概念，2271 字的 GitHub release body
    // 曾经这样变成 2284 字的提示词把 flux（2048 上限）撞崩，还悄悄降级成纯文字帖子。
    // 换成 sourceTitle/sourceText 后，stage 1 的技能 + 适配器截断结构性地堵死这条路。
    if (!tenantId || !provider || (!sourceTitle && !sourceText)) {
      return c.json({ error: "tenantId, provider, and one of sourceTitle/sourceText required" }, 400);
    }

    try {
      const { bytes, contentType } = await generateImage(c.env, { tenantId, provider, sourceTitle, sourceText });
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

  // 部署后由 CI 调用（deploy-dev.yml / deploy-prod.yml 的 content 那一格），把预置技能的
  // 缓存刷到上游最新版本。放在这里而不是让 CI 逐个 id 去 curl：技能清单只有 SKILL_CATALOG
  // 一份，往里加一个技能不该还要记得改两个 workflow —— 忘了改就是一份永远为空的缓存，而
  // 缓存为空是静默的（generate.ts 只打一行 skill_content_cache_miss 日志照常出文）。
  //
  // 逐个技能各自 try/catch：一个技能的源 404 了，不该连累其余技能停在旧版本。全部成功才
  // 200，有任何一个失败返回 502 并列出失败项，让 CI 那一步变红——刷新失败不回滚已经部署好
  // 的代码，但必须看得见。
  router.post("/skills/refresh-all", async (c) => {
    const refreshed: string[] = [];
    const failed: { skillId: string; error: string }[] = [];
    for (const def of SKILL_CATALOG) {
      try {
        await refreshSkillContent(c.env, def.id);
        refreshed.push(def.id);
      } catch (err) {
        console.error(JSON.stringify({ event: "skill_refresh_failed", skillId: def.id, error: String(err) }));
        failed.push({ skillId: def.id, error: String(err) });
      }
    }
    return c.json({ refreshed, failed }, failed.length > 0 ? 502 : 200);
  });

  // 单个技能的刷新，供手动立即生效（改了 catalog 里的 sourceUrl、或想在不部署的情况下拉
  // 一次最新版）。Never called from the generation hot path.
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
