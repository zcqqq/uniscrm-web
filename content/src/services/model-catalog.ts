import type { Env } from "../types";

// OpenAI's /v1/models returns an untyped superset of every model the account can see:
// chat models, embeddings, whisper, tts, dall-e, moderation, and deprecated snapshots,
// with no capability field to distinguish them. This is a best-effort prefix/keyword
// heuristic to approximate "chat-capable text models" -- it is not a verified contract
// with OpenAI and may need periodic revisiting as they ship new model families.
const NON_CHAT_KEYWORDS = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|davinci|babbage|search)/i;
const CHAT_ID_PREFIX = /^(gpt-|o[0-9]|chatgpt)/i;

export async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data
    .map((m) => m.id)
    .filter((id) => CHAT_ID_PREFIX.test(id) && !NON_CHAT_KEYWORDS.test(id))
    .sort();
}

// Anthropic's /v1/models only lists chat models -- no filtering heuristic needed.
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id).sort();
}

// Response shape verified against Cloudflare's own wrangler CLI source
// (packages/wrangler/src/ai/types.ts + its test fixtures in ai.test.ts, workers-sdk repo):
// each result item is `{ id: <catalog uuid>, source, task: { id, name, description } | null,
// tags, name: <callable "@cf/..." identifier>, description }`. `name` (not `id`) holds the
// callable model identifier; `task` can be `null` for non-task-tagged models.
export async function listWorkersAiModels(env: Env): Promise<string[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?task=Text%20Generation`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Workers AI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { name: string; task?: { name: string } | null }[] };
  return body.result
    .filter((m) => !m.task || /text generation/i.test(m.task.name))
    .map((m) => m.name)
    .sort();
}
