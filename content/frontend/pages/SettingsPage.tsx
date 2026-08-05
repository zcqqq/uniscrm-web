// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { api, type ProviderCredentialInfo, type ProviderName } from "../lib/api";
import { OpenAiLogo, AnthropicLogo, WorkersAiLogo } from "../lib/providerLogos";

// i18n-ok: OpenAI/Anthropic are third-party brand names, never translated
const PROVIDER_LABELS: Record<ProviderName, LocalizedString> = {
  openai: { en: "OpenAI", zh: "OpenAI" },
  anthropic: { en: "Anthropic", zh: "Anthropic" },
  default: { en: "Default (Cloudflare Workers AI)", zh: "默认（Cloudflare Workers AI）" },
};

const PROVIDER_LOGOS: Record<ProviderName, React.ReactNode> = {
  openai: <OpenAiLogo />,
  anthropic: <AnthropicLogo />,
  default: <WorkersAiLogo />,
};

function ModelPicker({
  provider,
  apiKey,
  model,
  onChange,
}: {
  provider: ProviderName;
  apiKey: string;
  model: string;
  onChange: (model: string) => void;
}) {
  const T = useT();
  const [options, setOptions] = useState<string[] | null>(null);
  const [source, setSource] = useState<"static" | "live" | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setFetchFailed(false);
      api.llmModels.list(provider, apiKey || undefined)
        .then((res) => { if (!cancelled) { setOptions(res.models); setSource(res.source); } })
        .catch(() => { if (!cancelled) { setOptions(null); setFetchFailed(true); } });
    };

    // No key yet (or just cleared) -- fetch the static/no-key list immediately, no debounce
    // needed since it's a single lightweight call. Only debounce while actively typing a key.
    if (!apiKey) {
      load();
      return () => { cancelled = true; };
    }
    const timer = setTimeout(load, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [provider, apiKey, retryNonce]);

  if (fetchFailed) {
    return (
      <div className="space-y-1">
        <Select disabled value="" className="w-full text-sm">
          <option value="">{T({ en: "Unable to load models", zh: "无法加载模型" })}</option>
        </Select>
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="text-[11px] text-primary hover:underline"
        >
          {T(C.retry)}
        </button>
      </div>
    );
  }

  if (!options) {
    return (
      <Select disabled value="" className="w-full text-sm">
        <option value="">{T(C.loading)}</option>
      </Select>
    );
  }

  return (
    <div className="space-y-1">
      <Select value={model} onChange={(e: any) => onChange(e.target.value)} className="w-full text-sm">
        {!options.includes(model) && model && <option value={model}>{model}</option>}
        {options.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
      {source === "static" && (
        <p className="text-[11px] text-muted-foreground">
          {T({
            en: "Showing common models — enter your API key to load models available to your account.",
            zh: "当前展示常见模型——填写你的 API Key 后可加载你账号下可用的模型。",
          })}
        </p>
      )}
    </div>
  );
}

function ProviderForm({
  provider,
  initialModel,
  requiresApiKey,
  onSaved,
  onCancel,
}: {
  provider: ProviderName;
  initialModel?: string;
  requiresApiKey: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const T = useT();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel || "");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (requiresApiKey && !apiKey) return;
    if (!model) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, model, requiresApiKey ? apiKey : undefined);
      const label = PROVIDER_LABELS[provider];
      const savedMsg: LocalizedString = requiresApiKey
        ? { en: `${label.en} key saved`, zh: `${label.zh}密钥已保存` }
        : { en: `${label.en} model saved`, zh: `${label.zh}模型已保存` };
      toast({ title: T(savedMsg) });
      onSaved();
    } catch {
      toast({ title: T({ en: "Failed to save", zh: "保存失败" }), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {requiresApiKey && (
        <div>
          {/* i18n-ok: "API Key" kept in English per terminology list */}
          <Label className="text-xs block mb-1">API Key</Label>
          <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
        </div>
      )}
      <div>
        <Label className="text-xs block mb-1">{T({ en: "Model", zh: "模型" })}</Label>
        <ModelPicker provider={provider} apiKey={apiKey} model={model} onChange={setModel} />
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || (requiresApiKey && !apiKey) || !model}>{saving ? T({ en: "Saving...", zh: "保存中…" }) : T(C.save)}</Button>
        <Button variant="ghost" onClick={onCancel}>{T(C.cancel)}</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const T = useT();
  const [providers, setProviders] = useState<ProviderCredentialInfo[]>([]);
  const [defaultModel, setDefaultModelState] = useState<string>("");
  const [editing, setEditing] = useState<ProviderName | null>(null);
  const { toast } = useToast();

  const reload = () => {
    api.llmCredentials.list()
      .then((res) => { setProviders(res.providers); setDefaultModelState(res.defaultModel); })
      .catch(() => {});
  };

  useEffect(reload, []);

  const handleDisconnect = async (provider: "openai" | "anthropic") => {
    try {
      await api.llmCredentials.remove(provider);
      const label = PROVIDER_LABELS[provider];
      toast({ title: T({ en: `${label.en} disconnected`, zh: `${label.zh}已断开连接` }) });
      reload();
    } catch {
      toast({ title: T({ en: "Failed to disconnect", zh: "断开连接失败" }), variant: "destructive" });
    }
  };

  const providerOrder: ProviderName[] = ["openai", "anthropic", "default"];

  return (
    <div className="px-8 py-10">
      <h1 className="text-xl font-semibold mb-8">{T({ en: "AI Content Settings", zh: "AI 内容设置" })}</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {providerOrder.map((provider) => {
          // "default" never appears in `providers` (BYOK-only, see this plan's Global
          // Constraints) -- its model comes from the separate `defaultModel` field.
          const configured = provider === "default" ? undefined : providers.find((p) => p.provider === provider);
          const requiresApiKey = provider !== "default";
          const currentModel = provider === "default" ? defaultModel : configured?.model;
          const modelLabel = T({ en: "Model", zh: "模型" });

          return (
            <ChannelCard
              key={provider}
              logo={PROVIDER_LOGOS[provider]}
              name={T(PROVIDER_LABELS[provider])}
              tagline={
                provider === "default"
                  ? `${modelLabel}: ${defaultModel}`
                  : configured
                    ? `${modelLabel}: ${configured.model}`
                    : T({ en: "No key configured for this provider", zh: "该服务商尚未配置密钥" })
              }
              status={provider === "default" || configured ? "connected" : "disconnected"}
              createdAt={configured?.createdAt}
              extra={
                editing === provider ? (
                  <ProviderForm
                    provider={provider}
                    initialModel={currentModel}
                    requiresApiKey={requiresApiKey}
                    onSaved={() => { setEditing(null); reload(); }}
                    onCancel={() => setEditing(null)}
                  />
                ) : undefined
              }
              actions={
                editing === provider ? undefined : (
                  <div className="flex gap-2 w-full">
                    <Button className="flex-1" onClick={() => setEditing(provider)}>
                      {provider === "default"
                        ? T({ en: "Change model", zh: "更换模型" })
                        : configured
                          ? T(C.edit)
                          : T({ en: "Connect", zh: "连接" })}
                    </Button>
                    {requiresApiKey && configured && (
                      <Button className="flex-1" variant="destructive" onClick={() => handleDisconnect(provider as "openai" | "anthropic")}>
                        {T({ en: "Disconnect", zh: "断开连接" })}
                      </Button>
                    )}
                  </div>
                )
              }
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        {T({
          en: 'No key configured for OpenAI or Anthropic? Flow nodes can still use the free built-in model ("default") or post text with no AI at all ("none").',
          zh: '还没为 OpenAI 或 Anthropic 配置密钥？流程节点仍可使用免费的内置模型（"default"），或完全不经 AI 直接发布文本（"none"）。',
        })}
      </p>
    </div>
  );
}
