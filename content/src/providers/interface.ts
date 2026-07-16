export interface LlmProvider {
  generate(prompt: string, model: string, systemPrompt?: string): Promise<string>;
}
