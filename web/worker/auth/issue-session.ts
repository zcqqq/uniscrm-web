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

// 进入产品的每一条路径——magic link、OAuth、密码登录——都必须落下完全相同的一组 cookie。集中在
// 这一个函数里，是防止三条路径各自演化、日后行为对不上的唯一办法。
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
