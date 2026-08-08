import type { LlmProvider } from "./interface";

export class WorkersAiProvider implements LlmProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string, systemPrompt?: string): Promise<string> {
    const messages = systemPrompt?.trim()
      ? [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
      : [{ role: "user", content: prompt }];
    // Workers AI defaults max_tokens to 256 when unset, which silently truncates long
    // outputs -- subtitle translation sends every cue in one numbered list, and the cues
    // past the cutoff fell back to their untranslated originals (half-English subtitles).
    const result = (await this.ai.run(model, {
      messages,
      stream: false,
      max_tokens: 4096,
    })) as { response: string };
    return result.response;
  }
}
