import type { ImageProvider } from "./image-interface";
import { base64ToBytes, clampPrompt } from "./image-interface";

// OpenAI 两个族的提示词上限不同（gpt-image-1 32000、dall-e-3 4000），来自 OpenAI 文档，非实测。
const GPT_IMAGE_MAX_PROMPT_CHARS = 32000;
const DALL_E_MAX_PROMPT_CHARS = 4000;

export class OpenAiImageProvider implements ImageProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // OpenAI's image models split into two incompatible request/response contracts, and the
    // model id is the only signal we have for which one applies:
    //  - gpt-image-1 (and any future gpt-image-* family) does not accept response_format
    //    (400s "Unknown parameter") and always returns b64_json unconditionally. output_format
    //    defaults to "png", but TikTok's photo-post API rejects PNG (accepts only JPEG/WEBP) --
    //    request jpeg explicitly.
    //  - dall-e-2/3 (and everything else the settings page can surface, see
    //    OPENAI_STATIC_IMAGE_MODELS / IMAGE_ID_PATTERN in model-catalog.ts) rejects
    //    output_format outright and defaults response_format to "url" -- we need b64_json
    //    explicitly to keep returning bytes instead of a URL.
    const isGptImage = /^gpt-image/i.test(model);
    const clampedPrompt = clampPrompt(prompt, isGptImage ? GPT_IMAGE_MAX_PROMPT_CHARS : DALL_E_MAX_PROMPT_CHARS);
    const body: Record<string, unknown> = { model, prompt: clampedPrompt, size: "1024x1024" };
    if (isGptImage) {
      body.output_format = "jpeg";
    } else {
      body.response_format = "b64_json";
    }

    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`OpenAI image generate failed: ${res.status} ${await res.text()}`);
    }

    const resBody = (await res.json()) as { data: { b64_json: string }[] };
    // dall-e returns PNG bytes when response_format=b64_json (no way to request JPEG for it
    // the way gpt-image-1 lets us); gpt-image-1's jpeg request above matches the contentType.
    const contentType = isGptImage ? "image/jpeg" : "image/png";
    return { bytes: base64ToBytes(resBody.data[0].b64_json), contentType };
  }
}
