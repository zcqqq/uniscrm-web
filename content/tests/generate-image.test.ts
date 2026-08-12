import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImage } from "../src/services/generate-image";
import * as credentialsModule from "../src/services/llm-credentials";
import * as generateModule from "../src/services/generate";

describe("generateImage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stage 1 用 image 技能把触发内容写成视觉描述，stage 2 拿它出图", async () => {
    const gen = vi.spyOn(generateModule, "generateContent").mockResolvedValue("a futuristic dashboard, neon accents");
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("png") });

    await generateImage({ AI: { run: aiRun } } as never, {
      tenantId: 1, provider: "default", sourceTitle: "v2.10.0", sourceText: "attribution models and reconciliation",
    });

    const stage1 = gen.mock.calls[0][1];
    expect(stage1.skillId).toBe("marketingskills-image");
    expect(stage1.prompt).toContain("v2.10.0");
    expect(stage1.prompt).toContain("attribution models");
    expect(stage1.operationContext).toContain("no readable text");
    expect(aiRun.mock.calls[0][1].prompt).toBe("a futuristic dashboard, neon accents");
  });

  // stage 1 不设人为上限：压缩就是它的职责，长度保护住在适配器里（Task 8）。
  it("不对 stage 1 的输出做长度处理", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("b".repeat(900));
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("png") });

    await generateImage({ AI: { run: aiRun } } as never, { tenantId: 1, provider: "default", sourceTitle: "t" });

    expect(aiRun.mock.calls[0][1].prompt).toHaveLength(900);
  });

  it("stage 1 失败时整体抛错，交给调用方降级", async () => {
    vi.spyOn(generateModule, "generateContent").mockRejectedValue(new Error("model down"));
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("@cf/black-forest-labs/flux-1-schnell");
    await expect(
      generateImage({ AI: { run: vi.fn() } } as never, { tenantId: 1, provider: "default", sourceTitle: "t" })
    ).rejects.toThrow(/model down/);
  });

  // 没有图片模型仍然要在花掉一次文本推理之前就失败。
  it("没有图片模型时不跑 stage 1", async () => {
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue(null);
    const gen = vi.spyOn(generateModule, "generateContent");
    await expect(
      generateImage({} as never, { tenantId: 1, provider: "openai", sourceTitle: "t" })
    ).rejects.toThrow(/No image model configured/);
    expect(gen).not.toHaveBeenCalled();
  });

  it("uses the tenant's OpenAI BYOK credentials and configured image model for provider: 'openai'", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("a cyberpunk lizard");
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("gpt-image-1");
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const base64Jpeg = btoa("jpeg-bytes");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: base64Jpeg }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage({} as never, { tenantId: 1, provider: "openai", sourceTitle: "t" });

    expect(result.contentType).toBe("image/jpeg");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-image-1");
    expect(body.prompt).toBe("a cyberpunk lizard");
    vi.unstubAllGlobals();
  });

  it("throws clearly when provider: 'openai' has no configured credentials", async () => {
    vi.spyOn(generateModule, "generateContent").mockResolvedValue("a cyberpunk lizard");
    vi.spyOn(credentialsModule, "getImageModel").mockResolvedValue("gpt-image-1");
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(
      generateImage({} as never, { tenantId: 1, provider: "openai", sourceTitle: "t" })
    ).rejects.toThrow(/No openai credentials configured/);
  });
});
