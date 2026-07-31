import type { Context, Next } from "hono";
import type { Env } from "../types";
import { fetchAccessJwks, verifyAccessJwt } from "../lib/jwt";

// /tms 下所有请求的应用层第二道防线。第一道是 Cloudflare Access 在边缘拦截。
//
// 刻意不读 `session` cookie，也不 import SessionService / TenantDB：租户会话 cookie 的
// domain 是 uni-scrm.com，它必然会到达本 worker，但在 /tms 下不得有任何语义。
export async function accessAuth(c: Context<{ Bindings: Env }>, next: Next) {
  // 幂等守卫：当同一中间件同时挂在精确路径（"/tms"）和通配路径（"/tms/*"）上时，
  // Hono 对裸路径 "/tms" 的请求会把两次挂载都算作匹配，导致本函数在同一请求里
  // 被串联执行两遍。若上一遍已经验证通过并写入 adminEmail，直接放行，避免重复
  // 拉取 JWKS / 重复验签（生产环境只是多一次网络请求，无害；但足以让本函数
  // 不必要地重复做同一件事）。
  if (c.get("adminEmail" as never)) return next();

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
    const cache = typeof caches !== "undefined" ? caches.default : undefined;
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
