export interface LlmProvider {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}
