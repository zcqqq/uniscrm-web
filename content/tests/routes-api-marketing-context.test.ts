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

// 治理原则（设计文档 §8.4）：代码里的契约只描述我们的运行时，永远不复述技能的内容——技能
// 从公开仓库拉取、会独立改版，硬编码它当下的小节/字段会悄悄跟真实技能脱节且没有任何报错。
//
// 一份四个词的黑名单挡不住"换个说法复述"——比如把 "Product Overview" 换成
// "the Elevator Pitch section" 照样违反原则却照样通过黑名单。真正该守的是复述这件事在
// 契约字符串里必然留下的*形状*：技能文档本身就是用 markdown 小节标题（`##`）、
// `**字段名:**` 这种粗体标签、以及编号/项目符号列表来表达它的结构（参见 §8.2 表格里
// 技能文本的偏移量）——把结构誊抄回契约，几乎不可能不带上这几种形状之一，而且抄一份
// 十几节的列表，契约不可能还维持"几句话"的长度。下面这条断言链检查的是这些形状，
// 而不是猜哪几个词会被抄。
//
// 仍保留原来那几个词作为一道便宜的绊线（真复述大概率会踩到），但绊线不是防线本身——
// 下次有人想"简化"掉形状检查、只留字面量黑名单之前，请重读这段注释。
function assertNoSkillStructureRestatement(contract: string) {
  // 当前两份契约都是几句话（395 / 305 字符）；抄一份十几节的结构进来，长度会明显冒头。
  expect(contract.length).toBeLessThan(500);
  expect(contract).not.toMatch(/(^|\n)\s{0,3}#{1,6}\s/); // markdown 小节标题，如 "## Brand Voice"
  expect(contract).not.toMatch(/\*\*[^*\n]{1,60}:\*\*/); // "**Field:**" 这种粗体字段标签
  expect(contract).not.toMatch(/(^|\n)\s{0,3}(\d+[.)]|[-*•])\s/); // 编号或项目符号列表行
  for (const forbidden of ["Product Overview", "Brand Voice", "Target Audience", "12"]) {
    expect(contract).not.toContain(forbidden);
  }
}

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
    assertNoSkillStructureRestatement(params.operationContext!);
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
    assertNoSkillStructureRestatement(params.operationContext!);
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

  // 治理原则的回归守卫（负半边）：契约里一旦长出"复述技能结构"的形状——见
  // assertNoSkillStructureRestatement 的注释——就说明有人把技能的结构又手抄回了代码里。
  it("契约里不出现技能结构的复述", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    assertNoSkillStructureRestatement(params.operationContext!);
  });

  // 治理原则的回归守卫（正半边）：光是"不点名"还不够——如果连"结构听上文技能的"这句指望都
  // 没了，模型拿到的就是一份没有任何结构指望的契约，产出的文档同样没有结构。这条断言防的是
  // 把上面那条负向守卫过度收紧、连这句"交还权威"的指代也一并删掉的回归。
  it("契约仍把结构的权威交还给技能（\"跟上文的指令走\"这句指代还在）", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    expect(params.operationContext).toMatch(/structure.*above|above.*structure/i);
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
