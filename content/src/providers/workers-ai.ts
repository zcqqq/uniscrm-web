import type { LlmProvider } from "./interface";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string): Promise<string> {
    const result = (await this.ai.run(MODEL, {
      messages: [{ role: "user", content: prompt }],
      stream: false,
    })) as { response: string };
    return result.response;
  }
}
