import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiImageProvider } from "../../src/providers/openai-image";

describe("OpenAiImageProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the images/generations endpoint requesting jpeg output (TikTok rejects PNG photos), never sending response_format", async () => {
    const base64Jpeg = btoa("fake-jpeg-bytes");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: base64Jpeg }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiImageProvider("sk-test");
    const result = await provider.generate("a cyberpunk lizard", "gpt-image-1");

    expect(result.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(result.bytes)).toBe("fake-jpeg-bytes");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ model: "gpt-image-1", prompt: "a cyberpunk lizard", size: "1024x1024", output_format: "jpeg" });
    expect(body.response_format).toBeUndefined();
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new OpenAiImageProvider("sk-bad");
    await expect(provider.generate("a lizard", "gpt-image-1")).rejects.toThrow("OpenAI image generate failed: 401");
  });
});
