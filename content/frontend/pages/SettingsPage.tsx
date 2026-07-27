// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api, type ProviderCredentialInfo, type ProviderName } from "../lib/api";
import { OpenAiLogo, AnthropicLogo, WorkersAiLogo } from "../lib/providerLogos";

const PROVIDER_LABELS: Record<ProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  default: "Default (Cloudflare Workers AI)",
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
          <option value="">Unable to load models</option>
        </Select>
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="text-[11px] text-primary hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!options) {
    return (
      <Select disabled value="" className="w-full text-sm">
        <option value="">Loading models…</option>
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
          Showing common models — enter your API key to load models available to your account.
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
      toast({ title: `${PROVIDER_LABELS[provider]} ${requiresApiKey ? "key" : "model"} saved` });
      onSaved();
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {requiresApiKey && (
        <div>
          <Label className="text-xs block mb-1">API Key</Label>
          <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
        </div>
      )}
      <div>
        <Label className="text-xs block mb-1">Model</Label>
        <ModelPicker provider={provider} apiKey={apiKey} model={model} onChange={setModel} />
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || (requiresApiKey && !apiKey) || !model}>{saving ? "Saving..." : "Save"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
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
      toast({ title: `${PROVIDER_LABELS[provider]} disconnected` });
      reload();
    } catch {
      toast({ title: "Failed to disconnect", variant: "destructive" });
    }
  };

  const providerOrder: ProviderName[] = ["openai", "anthropic", "default"];

  return (
    <div className="px-8 py-10">
      <h1 className="text-xl font-semibold mb-8">AI Content Settings</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {providerOrder.map((provider) => {
          // "default" never appears in `providers` (BYOK-only, see this plan's Global
          // Constraints) -- its model comes from the separate `defaultModel` field.
          const configured = provider === "default" ? undefined : providers.find((p) => p.provider === provider);
          const requiresApiKey = provider !== "default";
          const currentModel = provider === "default" ? defaultModel : configured?.model;

          return (
            <ChannelCard
              key={provider}
              logo={PROVIDER_LOGOS[provider]}
              name={PROVIDER_LABELS[provider]}
              tagline={
                provider === "default"
                  ? `Model: ${defaultModel}`
                  : configured
                    ? `Model: ${configured.model}`
                    : "No key configured for this provider"
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
                      {provider === "default" ? "Change model" : configured ? "Edit" : "Connect"}
                    </Button>
                    {requiresApiKey && configured && (
                      <Button className="flex-1" variant="destructive" onClick={() => handleDisconnect(provider as "openai" | "anthropic")}>
                        Disconnect
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
        No key configured for OpenAI or Anthropic? Flow nodes can still use the free built-in model ("default") or post text with no AI at all ("none").
      </p>
    </div>
  );
}
