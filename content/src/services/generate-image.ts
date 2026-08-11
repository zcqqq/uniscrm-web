import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

export interface GenerateImageParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai";
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  // 模型只来自租户配置（Default 的常量是初始值，不是兜底）。拿不到就报错——把 OpenAI
  // 的出图请求悄悄换到免费模型上，用户看不出来，账单和画风却都对不上。
  const model = await credentialsModule.getImageModel(env, params.tenantId, params.provider);
  if (!model) {
    throw new Error(`No image model configured for provider ${params.provider}`);
  }

  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(params.prompt, model);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }

  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(params.prompt, model);
}
