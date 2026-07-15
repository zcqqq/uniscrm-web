import type { Env } from "../types";
import { getSkill } from "../skills";
import * as credentialsModule from "./llm-credentials";
import { WorkersAiProvider } from "../providers/workers-ai";
import { OpenAiProvider } from "../providers/openai";
import { AnthropicProvider } from "../providers/anthropic";
import type { LlmProvider } from "../providers/interface";
import type { Skill } from "../skills";

export interface GenerateParams {
  tenantId: number;
  skillId: string;
  material: { title?: string; content_text?: string; summary?: string };
  targetPlatform: "X" | "TIKTOK";
}

function buildSystemPrompt(skill: Skill): string {
  return `${skill.label}\n\n${skill.systemPrompt}`;
}

function buildUserPrompt(material: GenerateParams["material"], targetPlatform: string): string {
  const parts = [`Target platform: ${targetPlatform}`];
  if (material.title) parts.push(`Title: ${material.title}`);
  if (material.content_text) parts.push(`Content: ${material.content_text}`);
  if (material.summary) parts.push(`Summary: ${material.summary}`);
  return parts.join("\n");
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const skill = getSkill(params.skillId);
  if (!skill) throw new Error(`Unknown skill: ${params.skillId}`);

  const systemPrompt = buildSystemPrompt(skill);
  const userPrompt = buildUserPrompt(params.material, params.targetPlatform);

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId);
  if (credentials) {
    const provider: LlmProvider =
      credentials.provider === "openai"
        ? new OpenAiProvider(credentials.apiKey)
        : new AnthropicProvider(credentials.apiKey);
    try {
      return await provider.generate(systemPrompt, userPrompt);
    } catch (err) {
      console.error(JSON.stringify({ event: "byok_generate_failed_falling_back", tenantId: params.tenantId, provider: credentials.provider, error: String(err) }));
    }
  }

  const fallback = new WorkersAiProvider(env.AI);
  return fallback.generate(systemPrompt, userPrompt);
}
