import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { getSkillContent } from "./skill-content";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

const WORKERS_AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const OPENAI_IMAGE_MODEL = "gpt-image-1";

export interface GenerateImageParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai";
  skillId?: string;
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const skillContent = params.skillId && params.skillId !== "none"
    ? await getSkillContent(env, params.skillId)
    : null;
  const prompt = skillContent ? `${params.prompt}\n\n${skillContent}` : params.prompt;

  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(prompt, WORKERS_AI_IMAGE_MODEL);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }

  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(prompt, OPENAI_IMAGE_MODEL);
}
