import type { LlmProvider } from "./interface";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<string> {
    const result = (await this.ai.run(model, {
      messages: [{ role: "user", content: prompt }],
      stream: false,
    })) as { response: string };
    return result.response;
  }
}
