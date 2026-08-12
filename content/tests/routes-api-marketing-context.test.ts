/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import * as generateModule from "../src/services/generate";

beforeAll(async () => {
  await seedSession(env as never, "mc2", 94);
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS skill_context (
       tenant_id INTEGER NOT NULL, skill_repo TEXT NOT NULL, content TEXT NOT NULL,
       version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, skill_repo))`
  ).run();
  // chat/draft 都经 resolveContextProvider(env, tenantId) 查询 tenant_llm_credentials 来决定
  // 用哪个 provider —— vitest-pool-workers 不会自动跑 migrations/，手建表（同
  // tests/llm-credentials.test.ts）。这里没写入任何行，查出 0 行即落回 "default"。
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_llm_credentials (
       tenant_id INTEGER NOT NULL, provider TEXT NOT NULL, encrypted_api_key TEXT,
       model TEXT NOT NULL, image_model TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, provider))`
  ).run();
});
afterEach(() => vi.restoreAllMocks());

const H = { Cookie: "session=mc2", "Content-Type": "application/json" };
const call = (path: string, init: RequestInit) =>
  worker.fetch(new Request(`https://content-dev.uni-scrm.com${path}`, { headers: H, ...init }), env);

describe("marketing context 读写", () => {
  it("没写过时返回空", async () => {
    const res = await call("/api/marketing-context", {});
    expect(await res.json()).toEqual({ content: null, version: null, updatedAt: null });
  });

  it("PUT 保存后 GET 拿得到，版本从 1 开始", async () => {
    const put = await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "# doc" }) });
    expect(await put.json()).toEqual({ version: 1 });
    const got = await (await call("/api/marketing-context", {})).json() as { content: string; version: number };
    expect(got.content).toBe("# doc");
    expect(got.version).toBe(1);
  });

  it("空正文拒绝保存", async () => {
    const res = await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "   " }) });
    expect(res.status).toBe(400);
  });

  // 乐观并发：两个标签页各改各的，后写的不该无声覆盖前一个。
  it("baseVersion 与当前不符时 409", async () => {
    await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: "# v-a" }) });
    const stale = await call("/api/marketing-context", {
      method: "PUT", body: JSON.stringify({ content: "# v-b", baseVersion: 1 }),
    });
    expect(stale.status).toBe(409);
  });
});

describe("POST /api/marketing-context/chat", () => {
  it("把对话历史拼成 prompt，用 product-marketing 技能做 system", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("下一句提问");
    const res = await call("/api/marketing-context/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [
        { role: "assistant", content: "你的产品叫什么？" },
        { role: "user", content: "UniSCRM" },
      ] }),
    });

    expect(await res.json()).toEqual({ reply: "下一句提问" });
    const params = gen.mock.calls[0][1];
    expect(params.skillId).toBe("marketingskills-product-marketing");
    expect(params.prompt).toContain("你的产品叫什么？");
    expect(params.prompt).toContain("UniSCRM");
    // 聊天契约只负责"没文件系统/别提议存文件"这类运行时事实，不再兼职吐文档——
    // 哨兵围栏方案已删（dev 实测 0/6 合规，见设计文档 §8.1）。
    expect(params.operationContext).toContain("no filesystem");
  });

  it("已有存档文档时，不把文档正文重复塞进 operationContext——generateContent 自己按 repo 注入一份，" +
     "chatMarketingContext 不应该再手动拼第二份", async () => {
    const marker = "# EXISTING-DOC-MARKER-DO-NOT-DUPLICATE";
    await call("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content: marker }) });

    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("下一句提问");
    await call("/api/marketing-context/chat", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "继续" }] }),
    });

    const params = gen.mock.calls[0][1];
    // 运行时契约仍要在，但存档文档正文不该被手动拼进来（generateContent 内部按 skillId 对应的
    // repo 自动注入同一份 skill_context 行；这里是被 mock 掉的，所以只要 operationContext 里
    // 没有出现文档正文，就证明 chatMarketingContext 自己没有再内联一份）。
    expect(params.operationContext).toContain("no filesystem");
    expect(params.operationContext).not.toContain(marker);
  });

  it("messages 为空时 400", async () => {
    const res = await call("/api/marketing-context/chat", { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/marketing-context/generate", () => {
  it("原样返回模型输出，字段名是 document", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("# 完整文档正文");
    const res = await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "生成文档" }] }),
    });

    expect(await res.json()).toEqual({ document: "# 完整文档正文" });
  });

  it("传 skillId 让 generateContent 自动注入全文技能与租户上下文", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    expect(params.skillId).toBe("marketingskills-product-marketing");
  });

  // 治理原则的回归守卫：契约里一旦出现小节名/字段名，就说明有人把技能的结构又手抄回了
  // 代码里——技能会改版，硬编码的小节列表会悄悄跟真实技能脱节且没有任何报错。
  it("契约里不出现任何技能专属词汇", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    for (const forbidden of ["Product Overview", "Brand Voice", "Target Audience", "12"]) {
      expect(params.operationContext).not.toContain(forbidden);
    }
  });

  it("messages 为空数组时不 400——用户可能起草完就直接点生成，没多说一句话", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    const res = await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
  });
});
