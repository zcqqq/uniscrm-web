/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import * as tenantContentModule from "../src/services/tenant-content";
import * as generateModule from "../src/services/generate";

beforeAll(async () => { await seedSession(env as never, "mc", 93); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function draft() {
  const res = await worker.fetch(
    new Request("https://content-dev.uni-scrm.com/api/marketing-context/draft", {
      method: "POST", headers: { Cookie: "session=mc", "Content-Type": "application/json" }, body: "{}",
    }),
    env
  );
  return { status: res.status, body: await res.json() as { draft: string } };
}

function stubChannels(channels: unknown[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ channels }), { status: 200 })));
}

describe("POST /api/marketing-context/draft", () => {
  it("把近期内容和渠道清单都喂给模型", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([
      { channelType: "X", title: "Shipping v2", contentText: "attribution models" },
    ]);
    stubChannels([{ channelType: "X", displayName: "UniSCRM" }, { channelType: "YOUTUBE_ACCOUNT", displayName: null }]);
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("# Product Marketing Context");

    const { status, body } = await draft();

    expect(status).toBe(200);
    expect(body.draft).toBe("# Product Marketing Context");
    const prompt = gen.mock.calls[0][1].prompt;
    expect(prompt).toContain("Shipping v2");
    expect(prompt).toContain("attribution models");
    expect(prompt).toContain("UniSCRM");
    expect(prompt).toContain("YOUTUBE_ACCOUNT");
    // 起草受 product-marketing 技能指导
    expect(gen.mock.calls[0][1].skillId).toBe("marketingskills-product-marketing");
  });

  it("只有渠道、没有内容时照样起草", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([]);
    stubChannels([{ channelType: "TIKTOK", displayName: "UniSCRM TT" }]);
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("# draft");
    expect((await draft()).body.draft).toBe("# draft");
  });

  // 新租户两个信号都空 —— 这不是错误，对话从白纸开始。
  it("两个信号都为空时返回空草稿，不报错也不调模型", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([]);
    stubChannels([]);
    const gen = vi.spyOn(generateModule, "generateContent");
    const { status, body } = await draft();
    expect(status).toBe(200);
    expect(body.draft).toBe("");
    expect(gen).not.toHaveBeenCalled();
  });

  // 渠道端点挂了不该让起草整个失败 —— 还有内容这一路信号。
  it("渠道摘要取不到时降级为只用内容", async () => {
    vi.spyOn(tenantContentModule, "listRecentTenantContent").mockResolvedValue([
      { channelType: "X", title: "T", contentText: "B" },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("link down")));
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("# draft");
    expect((await draft()).status).toBe(200);
  });

  it("未登录返回 401", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/marketing-context/draft", {
        method: "POST", headers: { Cookie: "session=bad", "Content-Type": "application/json" }, body: "{}",
      }),
      env
    );
    expect(res.status).toBe(401);
  });
});
