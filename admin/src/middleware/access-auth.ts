import type { Context, Next } from "hono";
import type { Env } from "../types";
import { fetchAccessJwks, verifyAccessJwt } from "../lib/jwt";

// /tms 下所有请求的应用层第二道防线。第一道是 Cloudflare Access 在边缘拦截。
//
// 刻意不读 `session` cookie，也不 import SessionService / TenantDB：租户会话 cookie 的
// domain 是 uni-scrm.com，它必然会到达本 worker，但在 /tms 下不得有任何语义。
export async function accessAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const audTag = c.env.ACCESS_AUD_TAG;
  const emails = (c.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // Fail closed：任何一项配置缺失都拒绝，绝不"没配就放行"。
  if (!teamDomain || !audTag || emails.length === 0) {
    console.error(JSON.stringify({
      event: "tms_access_misconfigured",
      hasTeamDomain: !!teamDomain,
      hasAudTag: !!audTag,
      emailCount: emails.length,
    }));
    return c.json({ error: "Forbidden" }, 403);
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "Forbidden" }, 403);

  let payload: Awaited<ReturnType<typeof verifyAccessJwt>>;
  try {
    // DOM lib 的 CacheStorage 接口没有 `default`（那是 workers-types 独有的扩展）；
    // 两者同时在 lib 里时 TS 只看到 DOM 那份声明，故此处断言，不改变运行时行为。
    const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
    const jwks = await fetchAccessJwks(teamDomain, cache);
    payload = await verifyAccessJwt(token, { teamDomain, audTag, jwks });
  } catch (err) {
    console.error(JSON.stringify({ event: "tms_access_verify_error", error: String(err) }));
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!payload) return c.json({ error: "Forbidden" }, 403);
  if (!emails.includes(payload.email.toLowerCase())) {
    console.warn(JSON.stringify({ event: "tms_access_email_denied", email: payload.email }));
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("adminEmail" as never, payload.email);
  await next();
}
