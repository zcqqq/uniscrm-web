import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImage } from "../src/services/generate-image";
import * as credentialsModule from "../src/services/llm-credentials";
import * as skillContentModule from "../src/services/skill-content";

describe("generateImage", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseParams = { tenantId: 1, prompt: "a cyberpunk lizard", provider: "default" as const };

  it("uses Workers AI's flux-1-schnell for provider: 'default'", async () => {
    const base64Jpeg = btoa("jpeg-bytes");
    const aiRun = vi.fn().mockResolvedValue({ image: base64Jpeg });

    const result = await generateImage({ AI: { run: aiRun } } as any, baseParams);

    expect(aiRun).toHaveBeenCalledWith("@cf/black-forest-labs/flux-1-schnell", { prompt: "a cyberpunk lizard", steps: 4 });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("uses the tenant's OpenAI BYOK credentials for provider: 'openai', with the fixed gpt-image-1 model (not the tenant's configured text model)", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const base64Jpeg = btoa("jpeg-bytes");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: base64Jpeg }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage({} as any, { ...baseParams, provider: "openai" });

    expect(result.contentType).toBe("image/jpeg");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-image-1");
    vi.unstubAllGlobals();
  });

  it("throws clearly when provider: 'openai' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateImage({} as any, { ...baseParams, provider: "openai" })).rejects.toThrow(/No openai credentials configured/);
  });

  it("folds cached skill content into the prompt, uncapped, when skillId is set", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("Use warm, saturated colors.");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("jpeg-bytes") });

    await generateImage({ AI: { run: aiRun } } as any, { ...baseParams, skillId: "marketingskills-social" });

    expect(skillContentModule.getSkillContent).toHaveBeenCalledWith(expect.anything(), "marketingskills-social");
    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: "a cyberpunk lizard\n\nUse warm, saturated colors." })
    );
  });

  it("omits skill folding when skillId is 'none' or absent", async () => {
    const getSkillContentSpy = vi.spyOn(skillContentModule, "getSkillContent");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("jpeg-bytes") });

    await generateImage({ AI: { run: aiRun } } as any, { ...baseParams, skillId: "none" });

    expect(getSkillContentSpy).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt: "a cyberpunk lizard" }));
  });
});
