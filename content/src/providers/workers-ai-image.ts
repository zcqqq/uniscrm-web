import type { ImageProvider } from "./image-interface";
import { base64ToBytes } from "./image-interface";

export class WorkersAiImageProvider implements ImageProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // flux-1-schnell's response shape is { image: string } (base64-encoded JPEG),
    // unlike the text models' { response: string } shape.
    const result = (await this.ai.run(model, { prompt, steps: 4 })) as { image: string };
    return { bytes: base64ToBytes(result.image), contentType: "image/jpeg" };
  }
}
