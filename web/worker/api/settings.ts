import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";
import { OAuthService } from "../services/oauth";

const VALID_LOCATIONS = ["global", "china"];
const VALID_LANGUAGES = ["en", "zh"];

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function createSettingsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    const member = await c.env.WEB_DB.prepare("SELECT preferred_location, timezone FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ preferred_location: string; timezone: string }>();
    return c.json({ preferred_location: member?.preferred_location ?? "global", timezone: member?.timezone ?? "UTC" });
  });

  router.patch("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const { preferred_location } = await c.req.json<{ preferred_location: string }>();

    if (!VALID_LOCATIONS.includes(preferred_location)) {
      return c.json({ error: "Invalid location" }, 400);
    }

    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    await c.env.WEB_DB.prepare("UPDATE members SET preferred_location = ? WHERE id = ?")
      .bind(preferred_location, memberId)
      .run();

    try {
      const tenantId = c.get("tenantId" as never) as number;
      const recommend = new RecommendService(c.env.WEB_DB, c.env.VECTORIZE, c.env.KV);
      await recommend.computeForUser(tenantId, preferred_location);
    } catch (e) {
      console.error("Recommendation recompute failed:", e instanceof Error ? e.message : e);
    }

    return c.json({ ok: true, preferred_location });
  });

  router.patch("/language", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const { language } = await c.req.json<{ language: string }>();

    if (!VALID_LANGUAGES.includes(language)) {
      return c.json({ error: "Invalid language" }, 400);
    }

    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    await c.env.WEB_DB.prepare("UPDATE members SET language = ? WHERE id = ?")
      .bind(language, memberId)
      .run();

    // Readable by the static help center (help.uni-scrm.com) to pick the doc language
    setCookie(c, "lang", language, {
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      maxAge: 365 * 24 * 60 * 60,
      path: "/",
      domain: "uni-scrm.com",
    });

    return c.json({ ok: true, language });
  });

  router.patch("/timezone", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const { timezone } = await c.req.json<{ timezone: string }>();

    if (!timezone || !isValidTimezone(timezone)) {
      return c.json({ error: "Invalid timezone" }, 400);
    }

    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    await c.env.WEB_DB.prepare("UPDATE members SET timezone = ? WHERE id = ?")
      .bind(timezone, memberId)
      .run();

    return c.json({ ok: true, timezone });
  });

  router.get("/linked-accounts", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    const accounts = await oauthService.getLinkedAccounts(memberId);
    return c.json({ accounts });
  });

  router.delete("/linked-accounts/:provider", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const provider = c.req.param("provider");
    if (provider !== "google" && provider !== "x") {
      return c.json({ error: "Invalid provider" }, 400);
    }
    const oauthService = new OAuthService(c.env.WEB_DB, c.env.KV);
    await oauthService.unlinkAccount(memberId, provider);
    return c.json({ ok: true });
  });

  return router;
}
