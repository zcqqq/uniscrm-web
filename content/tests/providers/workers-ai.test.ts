import { describe, it, expect, vi } from "vitest";
import { WorkersAiProvider } from "../../src/providers/workers-ai";

describe("WorkersAiProvider", () => {
  it("calls env.AI.run with the llama model, non-streaming, and returns the response text", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "generated text" });
    const provider = new WorkersAiProvider({ run: aiRun } as any);

    const text = await provider.generate("system prompt", "user prompt");

    expect(text).toBe("generated text");
    expect(aiRun).toHaveBeenCalledWith(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "user prompt" },
        ],
        stream: false,
      }
    );
  });
});
