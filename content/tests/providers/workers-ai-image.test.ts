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
});
