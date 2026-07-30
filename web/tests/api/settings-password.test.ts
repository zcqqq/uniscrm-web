import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createSettingsRouter } from "../../worker/api/settings";
import * as password from "../../worker/services/password";

function makeApp(memberRow: any) {
  const statements: { sql: string; args: any[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: any[]) => {
        statements.push({ sql, args });
        return {
          first: vi.fn(async () => (sql.includes("FROM members WHERE id") ? memberRow : null)),
          run: vi.fn(async () => ({})),
        };
      }),
    })),
  };
  const app = new Hono();
  app.use("/*", (c, next) => {
    (c.env as any) = { WEB_DB: db };
    c.set("memberId" as never, "m1" as never);
    c.set("tenantId" as never, 7 as never);
    return next();
  });
  app.route("/settings", createSettingsRouter());
  return { app, db, statements };
}

function post(app: Hono, body: object) {
  return app.request("/settings/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=sess-current" },
    body: JSON.stringify(body),
  });
}

const WITH_PASSWORD = { preferred_location: "global", timezone: "UTC", password_hash: "pbkdf2$sha256$600000$c2FsdA==$aGFzaA==" };
const WITHOUT_PASSWORD = { preferred_location: "global", timezone: "UTC", password_hash: null };

describe("POST /settings/password", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // 从没设过密码的 member 拿有效 session 就是身份证明，不需要再提供旧密码
  it("从没设过密码时不带 current_password 也能设置", async () => {
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITHOUT_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass" });

    expect(res.status).toBe(200);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(true);
  });

  it("已有密码时缺 current_password 被拒", async () => {
    const { app } = makeApp(WITH_PASSWORD);
    const res = await post(app, { new_password: "brandnewpass" });
    expect(res.status).toBe(400);
  });

  it("已有密码时 current_password 错误被拒", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(WITH_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass", current_password: "wrongpassword" });

    expect(res.status).toBe(401);
  });

  it("已有密码且 current_password 正确时修改成功", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITH_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass", current_password: "oldpassword1" });

    expect(res.status).toBe(200);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(true);
  });

  // 改密码的典型动机就是怀疑凭证泄露，别处还登着的必须踢掉
  it("成功后删掉该 member 的其它 session，保留当前这个", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITH_PASSWORD);

    await post(app, { new_password: "brandnewpass", current_password: "oldpassword1" });

    const del = statements.find((s) => s.sql.startsWith("DELETE FROM sessions WHERE member_id"));
    expect(del).toBeDefined();
    expect(del!.args).toEqual(["m1", "sess-current"]);
  });

  it("新密码不合规时返回 400 且不写库", async () => {
    const { app, statements } = makeApp(WITHOUT_PASSWORD);

    const res = await post(app, { new_password: "short" });

    expect(res.status).toBe(400);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(false);
  });
});

describe("GET /settings", () => {
  it("has_password 反映该 member 是否设过密码", async () => {
    const withPw = makeApp(WITH_PASSWORD);
    const a = await withPw.app.request("/settings", { headers: { Cookie: "session=sess-current" } });
    expect(((await a.json()) as any).has_password).toBe(true);

    const withoutPw = makeApp(WITHOUT_PASSWORD);
    const b = await withoutPw.app.request("/settings", { headers: { Cookie: "session=sess-current" } });
    expect(((await b.json()) as any).has_password).toBe(false);
  });
});
