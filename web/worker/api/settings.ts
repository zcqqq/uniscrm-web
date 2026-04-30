import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

const VALID_LOCATIONS = ["global", "china"];

export function createSettingsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const user = await c.env.DB.prepare("SELECT preferred_location FROM users WHERE id = ?")
      .bind(userId)
      .first<{ preferred_location: string }>();
    return c.json({ preferred_location: user?.preferred_location ?? "global" });
  });

  router.patch("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { preferred_location } = await c.req.json<{ preferred_location: string }>();

    if (!VALID_LOCATIONS.includes(preferred_location)) {
      return c.json({ error: "Invalid location" }, 400);
    }

    await c.env.DB.prepare("UPDATE users SET preferred_location = ? WHERE id = ?")
      .bind(preferred_location, userId)
      .run();

    try {
      const recommend = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
      await recommend.computeForUser(userId, preferred_location);
    } catch (e) {
      console.error("Recommendation recompute failed:", e instanceof Error ? e.message : e);
    }

    return c.json({ ok: true, preferred_location });
  });

  return router;
}
