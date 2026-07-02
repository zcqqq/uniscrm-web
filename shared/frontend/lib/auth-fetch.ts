import { URLS } from "../urls";

export async function authFetch(url: string, opts?: RequestInit): Promise<Response> {
  const res = await fetch(url, { credentials: "include", ...opts });
  if (res.status === 401) {
    window.location.href = `${URLS.web}/login`;
    throw new Error("Session expired");
  }
  return res;
}
