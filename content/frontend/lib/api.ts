// content/frontend/lib/api.ts
import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers }, // i18n-ok: HTTP header name, not user-facing text
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // .status 让调用方能区分具体错误码（比如保存时的 409 baseVersion 冲突）而不是一律
    // 提示"请求失败"——做法照抄 flow/frontend/lib/api.ts 的 request()。
    const e = new Error((err as any).error || res.statusText) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export type ProviderName = "openai" | "anthropic" | "default";

export interface ProviderCredentialInfo {
  // BYOK-only, matches listConfiguredProviders' contract (see this plan's Global
  // Constraints) -- "default" never appears in the `providers` array, it's carried
  // separately in `defaultModel` below.
  provider: "openai" | "anthropic";
  model: string;
  imageModel: string | null;
  createdAt: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[]; defaultModel: string; defaultImageModel: string }> =>
      request("/api/llm-credentials"),
    save: (provider: ProviderName, model: string, apiKey?: string, imageModel?: string | null): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model, imageModel }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
  llmModels: {
    list: (provider: ProviderName, apiKey?: string, kind?: "text" | "image"): Promise<{ models: string[]; source: "static" | "live" }> =>
      request("/api/llm-models", { method: "POST", body: JSON.stringify({ provider, apiKey, kind }) }),
  },
  marketingContext: {
    get: (): Promise<{ content: string | null; version: number | null; updatedAt: string | null }> =>
      request("/api/marketing-context"),
    draft: (): Promise<{ draft: string }> =>
      request("/api/marketing-context/draft", { method: "POST", body: "{}" }),
    chat: (messages: { role: "user" | "assistant"; content: string }[]): Promise<{ reply: string }> =>
      request("/api/marketing-context/chat", { method: "POST", body: JSON.stringify({ messages }) }),
    save: (content: string, baseVersion?: number): Promise<{ version: number }> =>
      request("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content, baseVersion }) }),
  },
};
