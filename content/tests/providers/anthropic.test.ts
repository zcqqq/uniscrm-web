import { describe, it, expect, vi, afterEach } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic";

describe("AnthropicProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the messages endpoint with the given key and prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "generated text" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new AnthropicProvider("sk-ant-test");
    const text = await provider.generate("user prompt");

    expect(text).toBe("generated text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    const body = JSON.parse(init.body);
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new AnthropicProvider("sk-ant-bad");
    await expect(provider.generate("u")).rejects.toThrow("Anthropic generate failed: 401");
  });
});
