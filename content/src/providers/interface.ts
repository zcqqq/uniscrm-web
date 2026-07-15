export interface LlmProvider {
  generate(prompt: string, model: string): Promise<string>;
}
