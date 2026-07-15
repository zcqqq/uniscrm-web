import type { LlmProvider } from "./interface";

export class OpenAiProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0].message.content;
  }
}
