import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { channelsRoutes } from "../src/routes-channels";
import { productsRoutes } from "../src/routes-products";

// 渠道连接归租户所有（2026-08-08 产品决定）：Notion/Shopify 的连接查询按 tenant_id，
// 不再按 member_id —— 同租户的第二个成员必须看到同一个连接，而不是「未连接」。
// json_extract 过滤选中的是「连接行」（含 access_token），排除同 channel_type 下
// 只存 folder_ids 的配置行（PUT /:type/config 写入的那种）。

function buildApp(env: Record<string, unknown>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenantId" as never, 42 as never);
    c.set("memberId" as never, "member-abc" as never);
    await next();
  });
  app.route("/api/channels", channelsRoutes());
  app.route("/api/commerce", productsRoutes());
  return { app, env };
}

function mockLinkDb(row: unknown) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(row) }),
    }),
  };
}

function connectionLookup(linkDb: ReturnType<typeof mockLinkDb>) {
  const sql = linkDb.prepare.mock.calls[0][0] as string;
  const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
  return { sql, bindArgs };
}

describe("channel connection ownership is tenant-scoped", () => {
  it("GET /notion/status queries by tenant_id and selects the connection row (has access_token)", async () => {
    const linkDb = mockLinkDb({ config: JSON.stringify({ access_token: "t", channel_name: "WS" }) });
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/notion/status", {}, env);

    expect(await res.json()).toEqual({ connected: true, channel_name: "WS" });
    const { sql, bindArgs } = connectionLookup(linkDb);
    expect(sql).toContain("tenant_id = ?");
    expect(sql).not.toContain("member_id");
    expect(sql).toContain("json_extract(config, '$.access_token') IS NOT NULL");
    expect(bindArgs).toEqual([42]);
  });

  it("GET /shopify/status is served by the generic tenant-scoped /:type/status route", async () => {
    const linkDb = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "ch-1", config: JSON.stringify({ display_name: "shop.example" }), created_at: "2026-01-01" }),
        }),
      }),
    };
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/shopify/status", {}, env);

    expect(await res.json()).toMatchObject({ connected: true, displayName: "shop.example" });
    const sql = linkDb.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("tenant_id = ?");
    expect(sql).not.toContain("member_id");
    const bindArgs = (linkDb.prepare.mock.results[0].value.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bindArgs).toEqual([42, "SHOPIFY"]);
  });

  it("GET /shopify/products queries the connection by tenant_id, not member_id", async () => {
    const linkDb = mockLinkDb(null);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/shopify/products", {}, env);

    expect(res.status).toBe(401);
    const { sql, bindArgs } = connectionLookup(linkDb);
    expect(sql).toContain("tenant_id = ?");
    expect(sql).not.toContain("member_id");
    expect(bindArgs).toEqual([42]);
  });

  it("GET /notion/folders rejects with 401 when the tenant has no connection row", async () => {
    const linkDb = mockLinkDb(null);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request("/api/channels/notion/folders", {}, env);

    expect(res.status).toBe(401);
    const { bindArgs } = connectionLookup(linkDb);
    expect(bindArgs).toEqual([42]);
  });

  it("POST /api/commerce/sync looks up the Shopify connection by tenant_id", async () => {
    const linkDb = mockLinkDb(null);
    const { app, env } = buildApp({ LINK_DB: linkDb });

    const res = await app.request(
      "/api/commerce/sync",
      { method: "POST", body: JSON.stringify({ product_ids: ["p1"] }), headers: { "Content-Type": "application/json" } },
      env
    );

    expect(res.status).toBe(401);
    const { sql, bindArgs } = connectionLookup(linkDb);
    expect(sql).toContain("tenant_id = ?");
    expect(sql).not.toContain("member_id");
    expect(bindArgs).toEqual([42]);
  });
});
