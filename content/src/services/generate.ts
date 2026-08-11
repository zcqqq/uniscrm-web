import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { getSkillContent } from "./skill-content";
import { getSkillContext } from "./skill-context";
import { getSkillDefinition } from "../skills/catalog";
import { WorkersAiProvider } from "../providers/workers-ai";
import { OpenAiProvider } from "../providers/openai";
import { AnthropicProvider } from "../providers/anthropic";
import type { LlmProvider } from "../providers/interface";

export interface GenerateParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai" | "anthropic";
  skillId?: string;
  operationContext?: string;
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const useSkill = !!params.skillId && params.skillId !== "none";
  const skillContent = useSkill ? (await getSkillContent(env, params.skillId!)) ?? undefined : undefined;
  // 租户上下文按技能所属的包取：文档的 12 个小节是照着该包的消费方式写的，脱离该包单独注入
  // 未经验证；skillId 为 "none" 时没有"哪个包"可言，不查也不注入。
  const repo = useSkill ? getSkillDefinition(params.skillId!)?.repo : undefined;
  const tenantContext = repo ? (await getSkillContext(env, params.tenantId, repo)) ?? undefined : undefined;

  // 技能 → 租户上下文 → operationContext，越具体越靠后，契约永远最后：LLMs weight the tail of
  // a long system prompt most heavily, and skill docs can be 60k+ chars — the execution
  // contract must not drown (2026-08-09 实测).
  const systemPrompt =
    [skillContent, tenantContext, params.operationContext].filter(Boolean).join("\n\n") || undefined;

  if (params.provider === "default") {
    const model = await credentialsModule.getDefaultModel(env, params.tenantId);
    return new WorkersAiProvider(env.AI).generate(params.prompt, model, systemPrompt);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, params.provider);
  if (!credentials) {
    throw new Error(`No ${params.provider} credentials configured for this tenant`);
  }

  const provider: LlmProvider =
    params.provider === "openai"
      ? new OpenAiProvider(credentials.apiKey)
      : new AnthropicProvider(credentials.apiKey);

  return provider.generate(params.prompt, credentials.model, systemPrompt);
}
