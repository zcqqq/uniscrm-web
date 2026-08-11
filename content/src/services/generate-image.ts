import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { generateContent } from "./generate";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

export const IMAGE_PROMPT_SKILL_ID = "marketingskills-image";

export interface GenerateImageParams {
  tenantId: number;
  provider: "default" | "openai";
  sourceTitle?: string;
  sourceText?: string;
}

// stage 1 的执行契约。扩散模型要的是"一个仪表盘、冷色调、浅景深"，不是产品说明书 ——
// 这段话的全部作用就是把文本模型的输出压成可以直接送进扩散模型的一行。
export function buildImagePromptContract(): string {
  return (
    "Write one image prompt for a text-to-image diffusion model, for an illustration that will" +
    " accompany the content below on social media." +
    " Output only that prompt as a single plain-text line in English — no quotes, no commentary," +
    " no alternatives, no markdown." +
    " The image must contain no readable text."
  );
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  // 先确认出图模型存在，再花 stage 1 那次文本推理 —— 配置错了没必要先烧一次推理。
  const model = await credentialsModule.getImageModel(env, params.tenantId, params.provider);
  if (!model) {
    throw new Error(`No image model configured for provider ${params.provider}`);
  }

  // stage 1：文本模型读内容，写出视觉描述。技能与租户上下文都由 generateContent 注入。
  const source = [params.sourceTitle, params.sourceText].filter(Boolean).join("\n\n");
  const imagePrompt = await generateContent(env, {
    tenantId: params.tenantId,
    prompt: source,
    provider: "default",
    skillId: IMAGE_PROMPT_SKILL_ID,
    operationContext: buildImagePromptContract(),
  });

  console.log(JSON.stringify({
    event: "image_prompt_generated",
    tenantId: params.tenantId,
    sourceChars: source.length,
    promptChars: imagePrompt.length,
    prompt: imagePrompt,
  }));

  // stage 2。提示词长度保护住在适配器里（image-interface.ts 的 clampPrompt）。
  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(imagePrompt, model);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }
  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(imagePrompt, model);
}
