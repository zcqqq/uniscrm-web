import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { serveTmsAsset } from "../../src/index";

// serveTmsAsset 转发给 ASSETS.fetch 前必须剥掉 vite base "/tms" 前缀（dist 里资源的实际
// 路径是 /assets/xxx，不是 /tms/assets/xxx）；ASSETS 404 时回退到 /index.html 做 SPA 路由。
function makeApp(assetsFetch: (req: Request) => Promise<Response>) {
  const app = new Hono();
  app.get("/tms", serveTmsAsset as never);
  app.get("/tms/*", serveTmsAsset as never);
  const env = { ASSETS: { fetch: vi.fn(assetsFetch) } };
  return { app, env };
}

describe("serveTmsAsset", () => {
  it("strips the /tms prefix before forwarding to ASSETS", async () => {
    const { app, env } = makeApp(async (req) => {
      expect(new URL(req.url).pathname).toBe("/assets/index-abc123.js");
      return new Response("js-body", { status: 200 });
    });
    const res = await app.request("/tms/assets/index-abc123.js", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("js-body");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps bare /tms to root before forwarding", async () => {
    const { app, env } = makeApp(async (req) => {
      expect(new URL(req.url).pathname).toBe("/");
      return new Response("<html>root</html>", { status: 200 });
    });
    const res = await app.request("/tms", {}, env);
    expect(res.status).toBe(200);
  });

  it("falls back to /index.html when ASSETS 404s (SPA routing)", async () => {
    const { app, env } = makeApp(async (req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/index.html") return new Response("<html>spa-shell</html>", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const res = await app.request("/tms/dashboard/some-deep-route", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>spa-shell</html>");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(2);
  });

  it("passes through non-404, non-200 ASSETS responses unchanged", async () => {
    const { app, env } = makeApp(async () => new Response("boom", { status: 500 }));
    const res = await app.request("/tms/assets/broken.js", {}, env);
    expect(res.status).toBe(500);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });

  // /tms/api/* 未命中路由不该走 SPA 回退——前端把 HTML 当 JSON 解析会报出与真实原因
  // 无关的错误。ASSETS 只应被打一次（探测该路径本身），绝不该再去拉 /index.html。
  it("returns 404 JSON for an unmatched /tms/api/* path instead of the SPA shell", async () => {
    const { app, env } = makeApp(async () => new Response("not found", { status: 404 }));
    const res = await app.request("/tms/api/does-not-exist", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not Found" });
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
});
