import type { LlmProvider } from "./interface";

const MODEL = "claude-3-5-haiku-latest";

export class AnthropicProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { content: { type: string; text: string }[] };
    return body.content[0].text;
  }
}
