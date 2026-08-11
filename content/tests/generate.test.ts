import { describe, it, expect, vi, afterEach } from "vitest";
import { generateContent } from "../src/services/generate";
import * as credentialsModule from "../src/services/llm-credentials";
import * as skillContentModule from "../src/services/skill-content";
import * as skillContextModule from "../src/services/skill-context";

describe("generateContent", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseParams = { tenantId: 1, prompt: "Rewrite this in a punchy tone: We shipped a thing today.", provider: "default" as const };

  it("uses Workers AI for provider: 'default', falling back to the hardcoded model when the tenant never set one", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const text = await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, baseParams);
    expect(text).toBe("punchy text");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      expect.objectContaining({ messages: expect.arrayContaining([{ role: "user", content: baseParams.prompt }]) })
    );
  });

  it("uses the tenant's stored default-model choice for provider: 'default' when one is set", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => ({ model: "@cf/meta/llama-4-scout-17b-16e-instruct" }) }) }) };
    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, baseParams);
    expect(aiRun).toHaveBeenCalledWith("@cf/meta/llama-4-scout-17b-16e-instruct", expect.anything());
  });

  it("uses the tenant's OpenAI BYOK credentials for provider: 'openai'", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "openai text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, { ...baseParams, provider: "openai" });

    expect(text).toBe("openai text");
    expect(credentialsModule.getTenantLlmCredentials).toHaveBeenCalledWith(expect.anything(), 1, "openai");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-4o-mini");
    vi.unstubAllGlobals();
  });

  it("uses the tenant's Anthropic BYOK credentials for provider: 'anthropic'", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-ant-test", model: "claude-3-5-haiku-latest" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "anthropic text" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, { ...baseParams, provider: "anthropic" });

    expect(text).toBe("anthropic text");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("claude-3-5-haiku-latest");
    vi.unstubAllGlobals();
  });

  it("throws clearly (no silent fallback) when provider: 'openai' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateContent({} as any, { ...baseParams, provider: "openai" })).rejects.toThrow(/No openai credentials configured/);
  });

  it("throws clearly (no silent fallback) when provider: 'anthropic' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateContent({} as any, { ...baseParams, provider: "anthropic" })).rejects.toThrow(/No anthropic credentials configured/);
  });

  it("passes the cached skill content as a system prompt when skillId is set", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("Skill guidance here");
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, { ...baseParams, skillId: "marketingskills-social" });

    expect(skillContentModule.getSkillContent).toHaveBeenCalledWith(expect.anything(), "marketingskills-social");
    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([{ role: "system", content: "Skill guidance here" }]),
      })
    );
  });

  it("omits the system prompt when skillId is 'none' or absent, unchanged from before", async () => {
    const getSkillContentSpy = vi.spyOn(skillContentModule, "getSkillContent");
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, { ...baseParams, skillId: "none" });

    expect(getSkillContentSpy).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messages: [{ role: "user", content: baseParams.prompt }] })
    );
  });

  it("omits the system prompt when the skill was never fetched (getSkillContent returns null)", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, { ...baseParams, skillId: "marketingskills-social" });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messages: [{ role: "user", content: baseParams.prompt }] })
    );
  });

  it("passes operationContext as the system prompt when no skill is set", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams,
      operationContext: 'You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel',
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          { role: "system", content: 'You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel' },
          { role: "user", content: baseParams.prompt },
        ],
      })
    );
  });

  // Order matters: LLMs weight the end of a long system prompt most heavily, and the skill
  // document can be 60k+ chars of agent-manual prose — the operation's execution contract
  // must come LAST or it drowns (empirically verified against llama-4-scout, 2026-08-09).
  it("puts operationContext AFTER skill content when both are present", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("Skill guidance here");
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams,
      skillId: "marketingskills-social",
      operationContext: "op context line",
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "system", content: "Skill guidance here\n\nop context line" },
        ]),
      })
    );
  });

  // 顺序是承重的：技能是 60KB 通用文档，租户上下文是 2-4KB 具体信息，operationContext 是
  // 执行契约。越具体越靠后，契约永远最后 —— 2026-08-09 实测，契约放前面会被技能文档淹没。
  it("按「技能 → 租户上下文 → operationContext」拼接系统提示词", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
    vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue("TENANT-CTX");
    const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams, skillId: "marketingskills-social", operationContext: "OP-CTX",
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "system", content: "SKILL-DOC\n\nTENANT-CTX\n\nOP-CTX" },
        ]),
      })
    );
  });

  it("按技能所属的包取上下文", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
    const spy = vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams, tenantId: 42, skillId: "marketingskills-social",
    });

    expect(spy).toHaveBeenCalledWith(expect.anything(), 42, "coreyhaines31/marketingskills");
  });

  // 上下文是技能作用域的：没选技能就没有"哪个包"可言，不注入。
  it("skillId 为 none 时不查也不注入上下文", async () => {
    const spy = vi.spyOn(skillContextModule, "getSkillContext");
    const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, { ...baseParams, skillId: "none" });

    expect(spy).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messages: [{ role: "user", content: baseParams.prompt }] })
    );
  });

  it("上下文不存在时行为与今天完全一致", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("SKILL-DOC");
    vi.spyOn(skillContextModule, "getSkillContext").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "ok" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams, skillId: "marketingskills-social", operationContext: "OP-CTX",
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([{ role: "system", content: "SKILL-DOC\n\nOP-CTX" }]),
      })
    );
  });
});
