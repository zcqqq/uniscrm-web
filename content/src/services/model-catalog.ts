import type { Env } from "../types";

// Curated fallback shown in the model dropdown before a BYOK key is entered (or when the
// live fetch fails) -- listing a provider's actual models requires a valid key, so without
// one this is the best we can offer. Update these IDs by hand as providers ship new models.
export const OPENAI_STATIC_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"];
export const ANTHROPIC_STATIC_MODELS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"];

// OpenAI's /v1/models returns an untyped superset of every model the account can see:
// chat models, embeddings, whisper, tts, dall-e, moderation, and deprecated snapshots,
// with no capability field to distinguish them. This is a best-effort prefix/keyword
// heuristic to approximate "chat-capable text models" -- it is not a verified contract
// with OpenAI and may need periodic revisiting as they ship new model families.
const NON_CHAT_KEYWORDS = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|davinci|babbage|search)/i;
const CHAT_ID_PREFIX = /^(gpt-|o[0-9]|chatgpt)/i;

async function fetchOpenAiModelIds(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

async function fetchAnthropicModelIds(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

export async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const ids = await fetchOpenAiModelIds(apiKey);
  return ids.filter((id) => CHAT_ID_PREFIX.test(id) && !NON_CHAT_KEYWORDS.test(id)).sort();
}

// Anthropic's /v1/models only lists chat models -- no filtering heuristic needed.
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const ids = await fetchAnthropicModelIds(apiKey);
  return ids.sort();
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

export const OPENAI_STATIC_IMAGE_MODELS = ["gpt-image-1", "dall-e-3"];
// 空数组不是"待补"，是结论：Anthropic 不提供图片模型，无 key 时的静态目录因此为空。
export const ANTHROPIC_STATIC_IMAGE_MODELS: string[] = [];

// 与 NON_CHAT_KEYWORDS 同性质的启发式：provider 的 /v1/models 不带能力字段，只能按 id 认。
// 认得出的都认，认不出的一律不认——宁可让用户在下拉里少看到一个模型，也不要把一个
// 对话模型送进出图接口。
const IMAGE_ID_PATTERN = /^(gpt-image|dall-e|imagen|stable-diffusion|flux)/i;

export function filterImageModels(ids: string[]): string[] {
  return ids.filter((id) => IMAGE_ID_PATTERN.test(id)).sort();
}

export async function listOpenAiImageModels(apiKey: string): Promise<string[]> {
  return filterImageModels(await fetchOpenAiModelIds(apiKey));
}

export async function listAnthropicImageModels(apiKey: string): Promise<string[]> {
  return filterImageModels(await fetchAnthropicModelIds(apiKey));
}

export async function listWorkersAiImageModels(env: Env): Promise<string[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?task=Text-to-Image`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!res.ok) {
    throw new Error(`Workers AI image models list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { name: string; task?: { name: string } | null }[] };
  return body.result
    .filter((m) => !m.task || /text-to-image/i.test(m.task.name))
    .map((m) => m.name)
    .sort();
}
