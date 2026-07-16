import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai";

describe("OpenAiProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the chat completions endpoint with the given key, prompt, and model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiProvider("sk-test");
    const text = await provider.generate("user prompt", "gpt-4o");

    expect(text).toBe("generated text");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new OpenAiProvider("sk-bad");
    await expect(provider.generate("u", "gpt-4o-mini")).rejects.toThrow("OpenAI generate failed: 401");
  });

  it("prepends a system message when skill content is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiProvider("sk-test");
    await provider.generate("user prompt", "gpt-4o", "Skill guidance here");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: "system", content: "Skill guidance here" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("omits the system message when skill content is blank", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "generated text" } }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiProvider("sk-test");
    await provider.generate("user prompt", "gpt-4o", "   ");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });
});
