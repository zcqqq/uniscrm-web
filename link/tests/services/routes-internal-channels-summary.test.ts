/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

beforeAll(async () => {
  // vitest-pool-workers doesn't auto-apply migrations/ (no <BINDING>_MIGRATIONS binding, no
  // setupFiles hook calling applyD1Migrations) -- create the table by hand, matching
  // migrations/0001_initial_schema.sql, mirroring the established pattern in
  // content/tests/llm-credentials.test.ts and flow/tests/unit/queue-content.test.ts.
  await env.LINK_DB.prepare(
    `CREATE TABLE IF NOT EXISTS channels (
       id TEXT PRIMARY KEY,
       channel_type TEXT NOT NULL,
       config TEXT NOT NULL DEFAULT '{}',
       source_channel_id TEXT,
       access_token TEXT,
       tenant_id INTEGER,
       member_id TEXT,
       is_active INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await env.LINK_DB.prepare("DELETE FROM channels WHERE tenant_id IN (9101, 9102)").run();
  const ins = (id: string, type: string, tenant: number, cfg: unknown) =>
    env.LINK_DB.prepare(
      "INSERT INTO channels (id, channel_type, config, tenant_id, is_active) VALUES (?, ?, ?, ?, 1)"
    ).bind(id, type, JSON.stringify(cfg), tenant).run();
  await ins("c-x", "X", 9101, { x_name: "UniSCRM", x_username: "uniscrm", access_token: "AT-SECRET", refresh_token: "RT-SECRET", app_client_secret: "CS-SECRET" });
  await ins("c-yt", "YOUTUBE_ACCOUNT", 9101, { channel_title: "UniSCRM TV", access_token: "AT-SECRET" });
  await ins("c-tt", "TIKTOK", 9101, { display_name: "UniSCRM TT", access_token: "AT-SECRET" });
  await ins("c-other", "X", 9102, { x_name: "SomeoneElse" });
});

async function summary(tenantId: number) {
  const res = await worker.fetch(
    new Request(`https://link-dev.uni-scrm.com/internal/channels/summary?tenantId=${tenantId}`, {
      headers: { "X-Internal-Secret": "dev-internal-secret" },
    }),
    env
  );
  return { status: res.status, text: await res.text() };
}

describe("GET /internal/channels/summary", () => {
  it("按渠道类型取显示名", async () => {
    const { status, text } = await summary(9101);
    expect(status).toBe(200);
    const body = JSON.parse(text) as { channels: { channelType: string; displayName: string | null }[] };
    expect(body.channels).toEqual(expect.arrayContaining([
      { channelType: "X", displayName: "UniSCRM" },
      { channelType: "YOUTUBE_ACCOUNT", displayName: "UniSCRM TV" },
      { channelType: "TIKTOK", displayName: "UniSCRM TT" },
    ]));
    expect(body.channels).toHaveLength(3);
  });

  // 这条是本端点存在的全部理由：config 里装着 access_token / refresh_token /
  // app_client_secret，而这个返回体会被喂进 LLM 提示词。泄一个字段就是泄凭证。
  it("绝不泄露 config 或其中任何凭证字段", async () => {
    const { text } = await summary(9101);
    for (const leak of ["AT-SECRET", "RT-SECRET", "CS-SECRET", "access_token", "refresh_token", "app_client_secret", "config"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("按租户隔离", async () => {
    const body = JSON.parse((await summary(9102)).text) as { channels: { displayName: string | null }[] };
    expect(body.channels).toEqual([{ channelType: "X", displayName: "SomeoneElse" }]);
  });

  it("没有渠道时返回空数组", async () => {
    expect(JSON.parse((await summary(9103)).text)).toEqual({ channels: [] });
  });

  it("缺少 tenantId 时 400", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/channels/summary", {
        headers: { "X-Internal-Secret": "dev-internal-secret" },
      }),
      env
    );
    expect(res.status).toBe(400);
  });
});
