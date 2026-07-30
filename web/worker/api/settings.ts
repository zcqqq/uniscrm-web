import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";
import { OAuthService } from "../services/oauth";
import { isValidTimezone } from "../services/timezone";
import { SessionService } from "../auth/session";
import { hashPassword, validatePassword, verifyPassword } from "../services/password";

const VALID_LOCATIONS = ["global", "china"];
const VALID_LANGUAGES = ["en", "zh"];

export function createSettingsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    const member = await c.env.WEB_DB.prepare("SELECT preferred_location, timezone, password_hash FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ preferred_location: string; timezone: string; password_hash: string | null }>();
    return c.json({
      preferred_location: member?.preferred_location ?? "global",
      timezone: member?.timezone ?? "UTC",
      // 前端据此决定显示「设置密码」还是「修改密码」；只回布尔值，永远不把哈希发给浏览器
      has_password: member?.password_hash != null,
    });
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

  router.post("/password", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    let body: { current_password?: string; new_password?: string };
    try {
      body = await c.req.json<{ current_password?: string; new_password?: string }>();
    } catch {
      // 请求体缺失或不是合法 JSON——跟 /auth/password-login 一样统一走 400，不让解析异常冒泡成 500。
      return c.json({ error: "Invalid request body" }, 400);
    }
    const { current_password, new_password } = body;

    const invalid = validatePassword(new_password ?? "");
    if (invalid) return c.json({ error: invalid }, 400);

    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    const member = await c.env.WEB_DB.prepare("SELECT password_hash FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ password_hash: string | null }>();
    if (!member) return c.json({ error: "Unauthorized" }, 401);

    // 从没设过密码的 member，手里这个有效 session 就是身份证明——OAuth 注册的用户正是走这条路。
    // 一旦有了密码，再改就必须先证明自己知道旧的。
    if (member.password_hash) {
      if (!current_password) return c.json({ error: "Current password is required" }, 400);
      if (!(await verifyPassword(current_password, member.password_hash))) {
        return c.json({ error: "Current password is incorrect" }, 401);
      }
    }

    const hash = await hashPassword(new_password!);
    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    await c.env.WEB_DB.prepare("UPDATE members SET password_hash = ? WHERE id = ?").bind(hash, memberId).run();

    // 改密码的典型动机就是怀疑凭证已经泄露，所以别处还登着的一律踢掉，只留当前这个。
    const sessionId = getCookie(c, "session") ?? "";
    await new SessionService(c.env.WEB_DB).destroyOthers(memberId, sessionId);

    return c.json({ ok: true });
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
