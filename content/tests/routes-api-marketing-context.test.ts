/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { seedSession } from "./helpers/seed-session";
import * as generateModule from "../src/services/generate";
import * as skillContentModule from "../src/services/skill-content";
import { buildChatContract, buildDocumentContract } from "../src/services/marketing-context";

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
// 这套违规有两条路径，只有一条是单元测试管得着的：
//
// 1. 自动化路径——代码从技能内容里读出小节名，拼进契约字符串。这条路径可以被结构性地
//    堵死，见下面 describe("执行契约的结构保证")：两个契约函数零参数、两次调用输出完全
//    相同，就说明它们不可能读了什么东西再插值进去。这是本文件里唯一"关死"的一条路径。
//
// 2. 手写措辞路径——有人把技能当前的小节直接抄成大白话塞进契约里（"记得覆盖 Elevator
//    Pitch 和 Pricing Model"），不带任何 markdown 记号。assertNoSkillStructureRestatement
//    只是这条路径上的粗糙绊线，挡的是"直接复制技能文档的 markdown 语法"这种最省事的抄法
//    ——小节标题、粗体字段标签、编号/项目符号列表，以及随之而来的长度暴涨。它挡不住换一种
//    说法的改写：单元测试没有"技能现在有哪些小节"这个事实可比对（技能内容活在 D1 里、从
//    会变的公开仓库拉取，测试运行时不知道它长什么样），没有基准就没法判断一句大白话是不是
//    "复述"。把长度阈值收紧到能卡住几十字符的改写，只会留下几乎不留余量的窗口——下一次
//    合理的措辞调整就会绊到，这种"狼来了"的守卫最终会被下一个人删掉，等于什么都没守住。
//    这条路径真正的防线是 §8.4 的原则本身 + code review，不是这个测试文件。
//
// 换句话说：下面这条断言链只证明"没有人复制粘贴技能的 markdown 结构"，不证明"契约没有
// 任何形式复述技能内容"——后者对单元测试不可达。不要把这条守卫的覆盖范围想大了。
function assertNoSkillStructureRestatement(contract: string) {
  expect(contract.length).toBeLessThan(500);
  expect(contract).not.toMatch(/(^|\n)\s{0,3}#{1,6}\s/); // markdown 小节标题，如 "## Brand Voice"
  expect(contract).not.toMatch(/\*\*[^*\n]{1,60}:\*\*/); // "**Field:**" 这种粗体字段标签
  expect(contract).not.toMatch(/(^|\n)\s{0,3}(\d+[.)]|[-*•])\s/); // 编号或项目符号列表行
  for (const forbidden of ["Product Overview", "Brand Voice", "Target Audience", "12"]) {
    expect(contract).not.toContain(forbidden);
  }
}

describe("执行契约的结构保证", () => {
  // 这是"契约不可能读技能内容再插值"这个属性唯一能被机械验证的角度：零参数 + 两次调用
  // 输出相同，排除了"从某处读小节名/字段名再拼进字符串"这条代码路径。想动态注入技能的
  // 结构，就必须先给函数加参数或引入某种隐藏状态——那会是显眼的 diff，逃不过 review。
  it("buildChatContract / buildDocumentContract 都是零参数、无副作用的常量输出", () => {
    for (const fn of [buildChatContract, buildDocumentContract]) {
      expect(fn.length).toBe(0);
      expect(fn()).toBe(fn());
    }
  });
});

// 正半边：光"不点名"还不够——如果契约连"结构听上文（技能）的"这句指望都没有，模型拿到的
// 就是一份没有任何结构指望的契约，产出同样没有结构。两份契约现在都靠同一句指代性措辞
// （"following the structure the instructions above describe"）把结构的权威交还给注入的
// 技能内容：buildChatContract 用它来定义"一次问一节"里的"节"是谁的节，buildDocumentContract
// 用它来定义最终文档该长成什么样。用一个共享断言，对称地守住两处。
function assertHandsBackStructuralAuthority(contract: string) {
  expect(contract).toMatch(/structure.*above|above.*structure/i);
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
    assertHandsBackStructuralAuthority(params.operationContext!);
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
    assertHandsBackStructuralAuthority(params.operationContext!);
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

  // 治理原则的回归守卫（正半边，见 assertHandsBackStructuralAuthority 的注释）。
  it("契约仍把结构的权威交还给技能（\"跟上文的指令走\"这句指代还在）", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    assertHandsBackStructuralAuthority(params.operationContext!);
  });

  it("messages 为空数组时不 400——用户可能起草完就直接点生成，没多说一句话", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    const res = await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
  });

  // 本次修的 bug：真实流程是「帮我起草」把草稿落进编辑框（从不落库）→ 聊几句 → 点「生成
  // 文档」。之前 generateMarketingContextDocument 只传 skillId，靠 generateContent 自动去
  // D1 读"已保存"的那一行——编辑框里的草稿从未保存过，模型完全看不到它。断言请求体里的
  // document 字段被原样转发进 currentDocument，这是 generateContent 用来代替 D1 读取的参数
  // （见 generate.ts）。
  it("请求体里的 document 转发为 currentDocument，取代 generateContent 默认的 D1 读取", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [], document: "# 编辑框里还没保存的草稿" }),
    });

    const params = gen.mock.calls[0][1];
    expect(params.currentDocument).toBe("# 编辑框里还没保存的草稿");
  });

  // 空情形：新租户第一次打开这个卡片，编辑框是空的、也没起草过。document 字段缺省时
  // 必须落到空串而不是 undefined——undefined 会让 generate.ts 落回默认的 D1 读取路径，
  // 那正是本次要避免的双重来源。空串则明确表示"当前没有文档"，让模型从零开始写第一份。
  it("document 缺省时 currentDocument 落到空串，而不是回退去读 D1", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("doc");
    await call("/api/marketing-context/generate", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });

    const params = gen.mock.calls[0][1];
    expect(params.currentDocument).toBe("");
  });
});

// 上面这个 describe 全程 mock 掉了 generateContent，只能证明"参数被转发"，证不出"模型最终
// 只看到一份文档"——真正的双重注入 bug 发生在 generateContent 内部（skillId 对应的 repo 会
// 让它自己再去 D1 读一次）。这里不 mock generateContent，只 mock 技能正文（避免依赖
// skill_content_cache 表/网络），换真实的 skill_context D1 表 + 一个能读到发给模型的完整
// system prompt 的 AI.run 桩，端到端验证进入模型的"当前文档"有且只有一份。
describe("POST /api/marketing-context/generate — 端到端：只有一份「当前文档」抵达模型", () => {
  const GEN_H = { Cookie: "session=mc-gen", "Content-Type": "application/json" };
  const callWithAi = (path: string, init: RequestInit, aiRun: (...args: unknown[]) => unknown) =>
    worker.fetch(
      new Request(`https://content-dev.uni-scrm.com${path}`, { headers: GEN_H, ...init }),
      { ...env, AI: { run: aiRun } } as never
    );

  beforeAll(async () => {
    await seedSession(env as never, "mc-gen", 96);
  });

  it("浏览器里未保存的草稿是模型看到的唯一「当前文档」——D1 里的旧存档不会被并列注入", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL BODY");
    // D1 里存着一份旧版本：用户之前保存过，但此刻编辑框里已经是另一份还没保存的草稿。
    await env.CONTENT_DB.prepare(
      `INSERT INTO skill_context (tenant_id, skill_repo, content, version, updated_at)
       VALUES (96, 'coreyhaines31/marketingskills', '# SAVED-OLD-VERSION', 1, ?)`
    ).bind(new Date().toISOString()).run();

    const systemPrompts: string[] = [];
    const aiRun = vi.fn(async (_model: string, opts: { messages: { role: string; content: string }[] }) => {
      systemPrompts.push(opts.messages.find((m) => m.role === "system")?.content ?? "");
      return { response: "generated doc" };
    });

    const res = await callWithAi(
      "/api/marketing-context/generate",
      { method: "POST", body: JSON.stringify({ messages: [], document: "# BROWSER-DRAFT-UNSAVED" }) },
      aiRun
    );

    expect(res.status).toBe(200);
    const sys = systemPrompts[0];
    expect(sys).toContain("# BROWSER-DRAFT-UNSAVED");
    expect(sys).not.toContain("SAVED-OLD-VERSION");
    // 不只是"出现过"，还要求恰好出现一次——排除"浏览器版本 + D1 版本"两份都被拼进去的回归。
    expect(sys.split("BROWSER-DRAFT-UNSAVED").length - 1).toBe(1);
  });

  // 空的情形：全新租户，D1 没有存档，编辑框也没打字/没起草出东西——generate 仍要给出一份
  // 可用的首份文档，而不是报错或空转。
  it("既无存档也无编辑框内容时，仍正常生成——这就是从零起草的样子", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL BODY");
    const aiRun = vi.fn(async () => ({ response: "# fresh first document" }));

    const res = await callWithAi(
      "/api/marketing-context/generate",
      { method: "POST", body: JSON.stringify({ messages: [] }) },
      aiRun
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ document: "# fresh first document" });
    expect(aiRun).toHaveBeenCalled();
  });
});
