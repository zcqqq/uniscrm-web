import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { issueSession } from "../../worker/auth/issue-session";

describe("issueSession", () => {
  it("落下 session / tier / lang 三种 cookie，且都作用在父域上", async () => {
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })) })),
    };

    const app = new Hono();
    app.get("/go", async (c) => {
      (c.env as any) = { WEB_DB: db };
      await issueSession(c as any, { id: "m1", tenant_id: 7, email: "a@example.com", language: "zh" });
      return c.json({ ok: true });
    });

    const res = await app.request("/go");
    const cookies = res.headers.getSetCookie();

    // 跨模块共享是全靠父域 cookie 的：每个模块各自是独立 Worker、独立域名
    const sessionSet = cookies.filter((c) => c.startsWith("session=") && !c.includes("Max-Age=0"));
    expect(sessionSet).toHaveLength(1);
    expect(sessionSet[0]).toContain("Domain=uni-scrm.com");
    expect(sessionSet[0]).toContain("HttpOnly");

    expect(cookies.some((c) => c.startsWith("tier=basic"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("lang=zh"))).toBe(true);
  });

  it("language 缺省时落 en", async () => {
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })) })) };
    const app = new Hono();
    app.get("/go", async (c) => {
      (c.env as any) = { WEB_DB: db };
      await issueSession(c as any, { id: "m1", tenant_id: 7, email: "a@example.com", language: null });
      return c.json({ ok: true });
    });

    const res = await app.request("/go");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("lang=en"))).toBe(true);
  });
});
