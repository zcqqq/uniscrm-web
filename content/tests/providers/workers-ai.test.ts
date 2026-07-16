import { describe, it, expect, vi } from "vitest";
import { WorkersAiProvider } from "../../src/providers/workers-ai";

describe("WorkersAiProvider", () => {
  it("calls env.AI.run with the given model, non-streaming, and returns the response text", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "generated text" });
    const provider = new WorkersAiProvider({ run: aiRun } as any);
    const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    const text = await provider.generate("user prompt", model);

    expect(text).toBe("generated text");
    expect(aiRun).toHaveBeenCalledWith(
      model,
      {
        messages: [{ role: "user", content: "user prompt" }],
        stream: false,
      }
    );
  });

  it("prepends a system message when skill content is given", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "generated text" });
    const provider = new WorkersAiProvider({ run: aiRun } as any);
    const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    await provider.generate("user prompt", model, "Skill guidance here");

    expect(aiRun).toHaveBeenCalledWith(model, {
      messages: [
        { role: "system", content: "Skill guidance here" },
        { role: "user", content: "user prompt" },
      ],
      stream: false,
    });
  });
});
