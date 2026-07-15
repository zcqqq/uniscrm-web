import { describe, it, expect, vi, afterEach } from "vitest";
import { generateContent } from "../src/services/generate";
import * as credentialsModule from "../src/services/llm-credentials";

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
});
