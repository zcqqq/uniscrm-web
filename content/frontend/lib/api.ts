// content/frontend/lib/api.ts
import { authFetch } from "../../../shared/frontend/lib/auth-fetch";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error || res.statusText);
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
  createdAt: string;
}

export const api = {
  llmCredentials: {
    list: (): Promise<{ providers: ProviderCredentialInfo[]; defaultModel: string }> => request("/api/llm-credentials"),
    save: (provider: ProviderName, model: string, apiKey?: string): Promise<{ ok: boolean }> =>
      request("/api/llm-credentials", { method: "PUT", body: JSON.stringify({ provider, apiKey, model }) }),
    remove: (provider: "openai" | "anthropic"): Promise<{ ok: boolean }> =>
      request(`/api/llm-credentials/${provider}`, { method: "DELETE" }),
  },
  llmModels: {
    list: (provider: ProviderName, apiKey?: string): Promise<{ models: string[] }> =>
      request("/api/llm-models", { method: "POST", body: JSON.stringify({ provider, apiKey }) }),
  },
};
