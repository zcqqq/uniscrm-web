import { URLS } from "../urls";

export async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(url, { credentials: "include", ...opts });
  if (res.status === 401) {
    window.location.href = `${URLS.web}/login`;
    // i18n-ok: redirect 已经触发，页面即将跳转，这条 Error 只在控制台可见，不会渲染给用户
    throw new Error("Session expired");
  }
  return res;
}
