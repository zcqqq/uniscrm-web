import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";
import { OAuthService } from "../services/oauth";

const VALID_LOCATIONS = ["global", "china"];

export function createSettingsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const member = await c.env.DB.prepare("SELECT preferred_location FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ preferred_location: string }>();
    return c.json({ preferred_location: member?.preferred_location ?? "global" });
  });

  router.patch("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const { preferred_location } = await c.req.json<{ preferred_location: string }>();

    if (!VALID_LOCATIONS.includes(preferred_location)) {
      return c.json({ error: "Invalid location" }, 400);
    }

    await c.env.DB.prepare("UPDATE members SET preferred_location = ? WHERE id = ?")
      .bind(preferred_location, memberId)
      .run();

    try {
      const recommend = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
      await recommend.computeForUser(memberId, preferred_location);
    } catch (e) {
      console.error("Recommendation recompute failed:", e instanceof Error ? e.message : e);
    }

    return c.json({ ok: true, preferred_location });
  });

  router.get("/linked-accounts", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    const accounts = await oauthService.getLinkedAccounts(memberId);
    return c.json({ accounts });
  });

  router.delete("/linked-accounts/:provider", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const provider = c.req.param("provider");
    if (provider !== "google" && provider !== "x") {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const oauthService = new OAuthService(c.env.DB, c.env.KV);
    await oauthService.unlinkAccount(memberId, provider);
    return c.json({ ok: true });
  });

  return router;
}
