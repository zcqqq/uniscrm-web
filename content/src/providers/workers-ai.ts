import type { LlmProvider } from "./interface";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string, systemPrompt?: string): Promise<string> {
    const messages = systemPrompt?.trim()
      ? [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
      : [{ role: "user", content: prompt }];
    const result = (await this.ai.run(model, {
      messages,
      stream: false,
    })) as { response: string };
    return result.response;
  }
}
