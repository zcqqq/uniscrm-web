import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImage } from "../src/services/generate-image";
import * as credentialsModule from "../src/services/llm-credentials";

describe("generateImage", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseParams = { tenantId: 1, prompt: "a cyberpunk lizard", provider: "default" as const };

  it("generates with the tenant's configured Workers AI image model", async () => {
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/bytedance/stable-diffusion-xl-lightning");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("png-bytes") });

    await generateImage({ AI: { run: aiRun } } as never, { tenantId: 1, prompt: "a lizard", provider: "default" });

    expect(aiRun).toHaveBeenCalledWith("@cf/bytedance/stable-diffusion-xl-lightning", { prompt: "a lizard", steps: 4 });
  });

  // 没有回退：BYOK provider 没配图片模型时必须报错，绝不悄悄换成免费的 Workers AI 模型出图。
  it("throws instead of falling back when the provider has no image model configured", async () => {
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue(null);
    await expect(
      generateImage({} as never, { tenantId: 1, prompt: "a lizard", provider: "openai" })
    ).rejects.toThrow(/No image model configured/);
  });

  it("uses Workers AI's configured model for provider: 'default'", async () => {
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
    const base64Jpeg = btoa("jpeg-bytes");
    const aiRun = vi.fn().mockResolvedValue({ image: base64Jpeg });

    const result = await generateImage({ AI: { run: aiRun } } as any, baseParams);

    expect(aiRun).toHaveBeenCalledWith("@cf/black-forest-labs/flux-1-schnell", { prompt: "a cyberpunk lizard", steps: 4 });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("uses the tenant's OpenAI BYOK credentials and configured image model for provider: 'openai'", async () => {
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("gpt-image-1");
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
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("gpt-image-1");
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateImage({} as any, { ...baseParams, provider: "openai" })).rejects.toThrow(/No openai credentials configured/);
  });
});
