import type { ImageProvider } from "./image-interface";
import { base64ToBytes } from "./image-interface";

export class OpenAiImageProvider implements ImageProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // gpt-image-1 does not accept response_format (400s "Unknown parameter") -- unlike
    // dall-e-2/3, it always returns b64_json unconditionally. output_format defaults to
    // "png", but TikTok's photo-post API rejects PNG (accepts only JPEG/WEBP) -- request
    // jpeg explicitly.
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, prompt, size: "1024x1024", output_format: "jpeg" }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI image generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { data: { b64_json: string }[] };
    return { bytes: base64ToBytes(body.data[0].b64_json), contentType: "image/jpeg" };
  }
}
