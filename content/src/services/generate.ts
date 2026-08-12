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
  // 调用方已经知道"用户当前正看着的文档"时传这个（如 marketing-context 编辑框里可能还没
  // 保存的内容），取代下面默认按 skillId 对应 repo 从 D1 读的已保存版本——同一次生成里只能
  // 有一份"当前文档"，不能既读浏览器草稿又读 D1 存档，那样模型会看到两份互相矛盾的版本
  // （本分支已经因为双重注入出过一次 bug，见设计文档 §8）。传空字符串等同"当前没有文档"，
  // 不会退回去读 D1——调用方既然显式给出了"当前"，就不该再被数据库里的旧版本覆盖。
  currentDocument?: string;
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const useSkill = !!params.skillId && params.skillId !== "none";
  const skillContent = useSkill ? (await getSkillContent(env, params.skillId!)) ?? undefined : undefined;
  // 租户上下文按技能所属的包取：文档的 12 个小节是照着该包的消费方式写的，脱离该包单独注入
  // 未经验证；skillId 为 "none" 时没有"哪个包"可言，不查也不注入。
  const repo = useSkill ? getSkillDefinition(params.skillId!)?.repo : undefined;
  const tenantContext =
    params.currentDocument !== undefined
      ? params.currentDocument || undefined
      : repo
        ? (await getSkillContext(env, params.tenantId, repo)) ?? undefined
        : undefined;

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
