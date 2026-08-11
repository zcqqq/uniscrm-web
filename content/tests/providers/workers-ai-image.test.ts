import { describe, it, expect, vi } from "vitest";
import { WorkersAiImageProvider } from "../../src/providers/workers-ai-image";

describe("WorkersAiImageProvider", () => {
  it("calls env.AI.run with the given model/prompt at 4 steps, decoding the base64 JPEG response into bytes", async () => {
    const base64Jpeg = btoa("fake-jpeg-bytes");
    const aiRun = vi.fn().mockResolvedValue({ image: base64Jpeg });
    const provider = new WorkersAiImageProvider({ run: aiRun } as any);

    const result = await provider.generate("a cyberpunk lizard", "@cf/black-forest-labs/flux-1-schnell");

    expect(aiRun).toHaveBeenCalledWith("@cf/black-forest-labs/flux-1-schnell", { prompt: "a cyberpunk lizard", steps: 4 });
    expect(result.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(result.bytes)).toBe("fake-jpeg-bytes");
  });

  // flux-1-schnell 的提示词上限实测为 2048 字符（含）：2048 通过，2049 返回 502。
  // 超限时静默丢图是本仓库真踩过的坑，所以保护放在这里 —— 适配器是唯一知道"自己这个
  // 模型能吃多长"的地方，放在这里所有调用方都受保护。
  it("把超出 flux 上限的提示词截到 2048 再发", async () => {
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("x") });
    await new WorkersAiImageProvider({ run: aiRun } as never)
      .generate("a".repeat(2100), "@cf/black-forest-labs/flux-1-schnell");
    expect(aiRun.mock.calls[0][1].prompt).toHaveLength(2048);
  });

  it("正好 2048 的提示词原样发出", async () => {
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("x") });
    await new WorkersAiImageProvider({ run: aiRun } as never)
      .generate("a".repeat(2048), "@cf/black-forest-labs/flux-1-schnell");
    expect(aiRun.mock.calls[0][1].prompt).toHaveLength(2048);
  });
});
