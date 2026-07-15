import { describe, it, expect, vi, afterEach } from "vitest";
import { listOpenAiModels, listAnthropicModels, listWorkersAiModels } from "../src/services/model-catalog";

describe("model-catalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("listOpenAiModels", () => {
    it("fetches with the given key and filters to chat-capable models, sorted", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          data: [
            { id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o1-mini" },
            { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "dall-e-3" },
            { id: "tts-1" }, { id: "text-moderation-latest" },
          ],
        }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listOpenAiModels("sk-test");

      expect(models).toEqual(["gpt-4o", "gpt-4o-mini", "o1-mini"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/models");
      expect(init.headers.Authorization).toBe("Bearer sk-test");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
      await expect(listOpenAiModels("sk-bad")).rejects.toThrow(/OpenAI models list failed: 401/);
    });
  });

  describe("listAnthropicModels", () => {
    it("fetches with the given key and returns sorted ids", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet-latest" }, { id: "claude-3-5-haiku-latest" }] }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listAnthropicModels("sk-ant-test");

      expect(models).toEqual(["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
      await expect(listAnthropicModels("sk-bad")).rejects.toThrow(/Anthropic models list failed: 401/);
    });
  });

  describe("listWorkersAiModels", () => {
    it("fetches the account's text-generation model catalog using CF_ACCOUNT_ID + CF_API_TOKEN", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          result: [
            { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", task: { name: "Text Generation" } },
            { name: "@cf/meta/llama-4-scout-17b-16e-instruct", task: { name: "Text Generation" } },
            { name: "@cf/openai/whisper", task: { name: "Automatic Speech Recognition" } },
          ],
        }), { status: 200 })
      );
      vi.stubGlobal("fetch", fetchMock);

      const models = await listWorkersAiModels({ CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token" } as any);

      expect(models).toEqual(["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/accounts/acct-1/ai/models/search");
      expect(init.headers.Authorization).toBe("Bearer cf-token");
    });

    it("throws on a non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })));
      await expect(listWorkersAiModels({ CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "bad" } as any)).rejects.toThrow(/Workers AI models list failed: 403/);
    });
  });
});
