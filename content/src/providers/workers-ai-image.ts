import type { ImageProvider } from "./image-interface";
import { base64ToBytes, clampPrompt } from "./image-interface";

// 实测边界：2048 字符通过，2049 返回 502。
const FLUX_MAX_PROMPT_CHARS = 2048;

export class WorkersAiImageProvider implements ImageProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // flux-1-schnell's response shape is { image: string } (base64-encoded JPEG),
    // unlike the text models' { response: string } shape.
    const result = (await this.ai.run(model, {
      prompt: clampPrompt(prompt, FLUX_MAX_PROMPT_CHARS),
      steps: 4,
    })) as { image: string };
    return { bytes: base64ToBytes(result.image), contentType: "image/jpeg" };
  }
}
