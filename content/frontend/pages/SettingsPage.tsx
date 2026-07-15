// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { ChannelCard } from "../../../link/frontend/components/ChannelCard";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api, type ProviderCredentialInfo } from "../lib/api";

const PROVIDER_MODELS: Record<"openai" | "anthropic", string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
};

const PROVIDER_LABELS: Record<"openai" | "anthropic", string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

function ProviderLogo({ provider }: { provider: "openai" | "anthropic" }) {
  return (
    <div className="w-full h-full flex items-center justify-center text-sm font-bold text-foreground/70">
      {provider === "openai" ? "AI" : "A"}
    </div>
  );
}

function ProviderForm({
  provider,
  initialModel,
  onSaved,
  onCancel,
}: {
  provider: "openai" | "anthropic";
  initialModel?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel || PROVIDER_MODELS[provider][0]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    if (!apiKey) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, apiKey, model);
      toast({ title: `${PROVIDER_LABELS[provider]} key saved` });
      onSaved();
    } catch {
      toast({ title: "Failed to save key", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs block mb-1">API Key</Label>
        <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
      </div>
      <div>
        <Label className="text-xs block mb-1">Model</Label>
        <Select value={model} onChange={(e: any) => setModel(e.target.value)} className="w-full text-sm">
          {PROVIDER_MODELS[provider].map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving || !apiKey}>{saving ? "Saving..." : "Save"}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [providers, setProviders] = useState<ProviderCredentialInfo[]>([]);
  const [editing, setEditing] = useState<"openai" | "anthropic" | null>(null);
  const { toast } = useToast();

  const reload = () => {
    api.llmCredentials.list().then((res) => setProviders(res.providers)).catch(() => {});
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

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Content Generation Settings</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(["openai", "anthropic"] as const).map((provider) => {
          const configured = providers.find((p) => p.provider === provider);
          return (
            <ChannelCard
              key={provider}
              logo={<ProviderLogo provider={provider} />}
              name={PROVIDER_LABELS[provider]}
              tagline={configured ? `Model: ${configured.model}` : "No key configured for this provider"}
              status={configured ? "connected" : "disconnected"}
              extra={
                editing === provider ? (
                  <ProviderForm
                    provider={provider}
                    initialModel={configured?.model}
                    onSaved={() => { setEditing(null); reload(); }}
                    onCancel={() => setEditing(null)}
                  />
                ) : undefined
              }
              actions={
                editing === provider ? undefined : (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setEditing(provider)}>{configured ? "Edit" : "Connect"}</Button>
                    {configured && <Button size="sm" variant="ghost" onClick={() => handleDisconnect(provider)}>Disconnect</Button>}
                  </div>
                )
              }
            />
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        No key configured for a provider? Flow nodes can still use the free built-in model ("default") or post text with no AI at all ("none").
      </p>
    </div>
  );
}
