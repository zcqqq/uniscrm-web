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
    // .body 把整个解析后的响应体也带上：像 /api/skills/import 的 409 那样，错误信息之外
    // 还带结构化数据（conflicts: [{ skillId, name }]），调用方需要它，不能只留一个字符串。
    const e = new Error((err as any).error || res.statusText) as Error & { status?: number; body?: unknown };
    e.status = res.status;
    e.body = err;
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
    // document 是编辑框当前的实时内容（可能从未保存过）——服务端拿它当"用户当前的文档"，
    // 镜像 generate() 下面同一条注释：不会再回头去读 D1 里可能不存在或已过期的存档版本。
    chat: (
      messages: { role: "user" | "assistant"; content: string }[],
      document: string
    ): Promise<{ reply: string }> =>
      request("/api/marketing-context/chat", { method: "POST", body: JSON.stringify({ messages, document }) }),
    // messages 允许为空数组——用户可能起草完/手改完编辑框就直接点"生成文档"，一句话没说。
    // document 是编辑框当前的实时内容（可能从未保存过）——服务端拿它当"用户当前的文档"，
    // 不会再回头去读 D1 里可能不存在或已过期的存档版本。
    generate: (
      messages: { role: "user" | "assistant"; content: string }[],
      document: string
    ): Promise<{ document: string }> =>
      request("/api/marketing-context/generate", { method: "POST", body: JSON.stringify({ messages, document }) }),
    save: (content: string, baseVersion?: number): Promise<{ version: number }> =>
      request("/api/marketing-context", { method: "PUT", body: JSON.stringify({ content, baseVersion }) }),
  },
  skills: {
    list: (): Promise<{ skills: { id: string; label: string; hasCachedContent: boolean; uploaded: boolean }[] }> =>
      request("/api/skills"),
    import: (skills: { name: string; source: string; overwrite?: boolean; files: { path: string; content: string }[] }[]) =>
      request<{ imported: number }>("/api/skills/import", { method: "POST", body: JSON.stringify({ skills }) }),
    remove: (skillId: string): Promise<{ ok: boolean }> =>
      request(`/api/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" }),
  },
};
