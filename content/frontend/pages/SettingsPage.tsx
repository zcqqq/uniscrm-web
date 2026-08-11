// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
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
  kind,
}: {
  provider: ProviderName;
  apiKey: string;
  model: string;
  onChange: (model: string) => void;
  kind: "text" | "image";
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
      api.llmModels.list(provider, apiKey || undefined, kind)
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
  }, [provider, apiKey, kind, retryNonce]);

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

function ImageModelField({
  provider, apiKey, model, onChange,
}: { provider: ProviderName; apiKey: string; model: string; onChange: (m: string) => void }) {
  const T = useT();
  const [imageModels, setImageModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.llmModels.list(provider, apiKey || undefined, "image")
        .then((res) => {
          if (cancelled) return;
          setImageModels(res.models);
          // 列表刚拿到、用户还没选过时预选首项：BYOK provider 的 image_model 为 NULL 意味着
          // 「flow 里选不到这个 provider 出图」，不该因为用户没注意到这个新选择器而发生。
          if (res.models.length > 0 && !model) onChange(res.models[0]);
        })
        .catch(() => { if (!cancelled) setImageModels([]); });
    };

    // 与相邻的 ModelPicker 一致：没有 key（含 Default 卡，永远没有 key）时立即拉一次
    // 静态列表；正在输入 key 时才防抖，避免逐字符敲键触发一次带着半截无效 key 的请求。
    if (!apiKey) {
      load();
      return () => { cancelled = true; };
    }
    const timer = setTimeout(load, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [provider, apiKey]);

  return imageModels.length > 0 && (
    <div>
      <Label className="text-xs block mb-1">{T({ en: "Image model", zh: "图片模型" })}</Label>
      <Select value={model} onChange={(e: any) => onChange(e.target.value)} className="w-full text-sm">
        {!imageModels.includes(model) && model && <option value={model}>{model}</option>}
        {imageModels.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
    </div>
  );
}

function ProviderForm({
  provider,
  initialModel,
  initialImageModel,
  requiresApiKey,
  onSaved,
  onCancel,
}: {
  provider: ProviderName;
  initialModel?: string;
  initialImageModel?: string | null;
  requiresApiKey: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const T = useT();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel || "");
  const [imageModel, setImageModel] = useState(initialImageModel || "");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (requiresApiKey && !apiKey) return;
    if (!model) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, model, requiresApiKey ? apiKey : undefined, imageModel || null);
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
        <ModelPicker provider={provider} apiKey={apiKey} model={model} onChange={setModel} kind="text" />
      </div>
      <ImageModelField provider={provider} apiKey={apiKey} model={imageModel} onChange={setImageModel} />
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || (requiresApiKey && !apiKey) || !model}>{saving ? T({ en: "Saving...", zh: "保存中…" }) : T(C.save)}</Button>
        <Button variant="ghost" onClick={onCancel}>{T(C.cancel)}</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const T = useT();
  const { locale } = useLocale();
  const [providers, setProviders] = useState<ProviderCredentialInfo[]>([]);
  const [defaultModel, setDefaultModelState] = useState<string>("");
  const [defaultImageModel, setDefaultImageModelState] = useState<string>("");
  const [editing, setEditing] = useState<ProviderName | null>(null);
  const { toast } = useToast();

  const reload = () => {
    api.llmCredentials.list()
      .then((res) => {
        setProviders(res.providers);
        setDefaultModelState(res.defaultModel);
        setDefaultImageModelState(res.defaultImageModel);
      })
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
          const currentImageModel = provider === "default" ? defaultImageModel : configured?.imageModel;
          const modelLabel = T({ en: "Model", zh: "模型" });

          // 有图片模型才追加一行——文本 tagline 不因为一个新字段而对没有图片模型的
          // provider（如 Anthropic）多出一段永远是空的说明。
          const baseTagline =
            provider === "default"
              ? `${modelLabel}: ${defaultModel}`
              : configured
                ? `${modelLabel}: ${configured.model}`
                : T({ en: "No key configured for this provider", zh: "该服务商尚未配置密钥" });
          const tagline = currentImageModel
            ? `${baseTagline} · ${T({ en: "Image", zh: "图片" })}: ${currentImageModel}`
            : baseTagline;

          return (
            <ChannelCard
              key={provider}
              logo={PROVIDER_LOGOS[provider]}
              name={T(PROVIDER_LABELS[provider])}
              tagline={tagline}
              status={provider === "default" || configured ? "connected" : "disconnected"}
              createdAt={configured?.createdAt}
              locale={locale}
              extra={
                editing === provider ? (
                  <ProviderForm
                    provider={provider}
                    initialModel={currentModel}
                    initialImageModel={provider === "default" ? defaultImageModel : configured?.imageModel}
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
