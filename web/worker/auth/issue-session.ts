import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "../types";
import { SessionService } from "./session";

export interface SessionMember {
  id: string;
  tenant_id: number;
  email: string;
  language?: string | null;
}

// 只有两条路径真正调用这个函数：auth.ts 里的 magic-link /verify 和密码登录 /password-login。
// OAuth（services/oauth.ts 的 Google 回调、X 回调、complete-profile 补邮箱那条）不走这里——那
// 三处各自发 cookie：前两处在返回的 HTML 里用内联 `document.cookie` 脚本，第三处又重复了一遍这
// 里的 setCookie 调用，且漏传了 language 参数给 sessions.create。也就是说“每条登录路径落下同一
// 组 cookie”这件事目前并不成立，OAuth 那三处是三份独立、已经会走样的实现。收拢它们是另一件有自己
// 风险的工作，这次不动；这条注释只是如实说明现状，别让后人拿一个不成立的不变量去做假设。
export async function issueSession(c: Context<{ Bindings: Env }>, member: SessionMember): Promise<string> {
  const sessions = new SessionService(c.env.WEB_DB);
  const language = member.language || "en";
  const sessionId = await sessions.create(member.id, member.tenant_id, member.email, language);

  // 先清掉早期版本可能留下的 host-only session cookie，再落父域的那个；否则浏览器会同时持有两个
  // 同名 cookie，而 host-only 的那个优先级更高。
  setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
  setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });
  // tier 这里写死 "basic" 是既有行为，本次原样保留，不在密码登录里顺手改语义。
  setCookie(c, "tier", "basic", {
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });
  // 供静态帮助中心（help.uni-scrm.com）挑文档语言
  setCookie(c, "lang", language, {
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    maxAge: 365 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });

  return sessionId;
}
