import { describe, it, expect, vi, afterEach } from "vitest";
import { generateContent } from "../src/services/generate";
import * as credentialsModule from "../src/services/llm-credentials";

describe("generateContent", () => {
  afterEach(() => vi.restoreAllMocks());

  const material = { title: "Big launch", content_text: "We shipped a thing today.", summary: undefined };
  const baseParams = { tenantId: 1, skillId: "punchy-social", material, targetPlatform: "X" as const };

  it("throws for an unknown skillId", async () => {
    await expect(
      generateContent({} as any, { ...baseParams, skillId: "nope" })
    ).rejects.toThrow("Unknown skill: nope");
  });

  it("uses the tenant's BYOK provider when credentials exist", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ provider: "openai", apiKey: "sk-test" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "byok text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const text = await generateContent({} as any, baseParams);

    expect(text).toBe("byok text");
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.anything());
    vi.unstubAllGlobals();
  });

  it("falls back to Workers AI when the tenant has no BYOK credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "fallback text" });

    const text = await generateContent({ AI: { run: aiRun } } as any, baseParams);

    expect(text).toBe("fallback text");
  });

  it("falls back to Workers AI when the BYOK call throws", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ provider: "openai", apiKey: "sk-bad" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const aiRun = vi.fn().mockResolvedValue({ response: "fallback text" });

    const text = await generateContent({ AI: { run: aiRun } } as any, baseParams);

    expect(text).toBe("fallback text");
    vi.unstubAllGlobals();
  });

  it("includes the skill's systemPrompt and the material as the user prompt", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: "text" });

    await generateContent({ AI: { run: aiRun } } as any, baseParams);

    const [, callArgs] = aiRun.mock.calls[0];
    expect(callArgs.messages[0].content).toContain("Punchy");
    expect(callArgs.messages[1].content).toContain("Big launch");
    expect(callArgs.messages[1].content).toContain("We shipped a thing today.");
  });
});
