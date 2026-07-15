import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { WorkersAiProvider } from "../providers/workers-ai";
import { OpenAiProvider } from "../providers/openai";
import { AnthropicProvider } from "../providers/anthropic";
import type { LlmProvider } from "../providers/interface";

export interface GenerateParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai" | "anthropic";
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  if (params.provider === "default") {
    const model = await credentialsModule.getDefaultModel(env, params.tenantId);
    return new WorkersAiProvider(env.AI).generate(params.prompt, model);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, params.provider);
  if (!credentials) {
    throw new Error(`No ${params.provider} credentials configured for this tenant`);
  }

  const provider: LlmProvider =
    params.provider === "openai"
      ? new OpenAiProvider(credentials.apiKey)
      : new AnthropicProvider(credentials.apiKey);

  return provider.generate(params.prompt, credentials.model);
}
