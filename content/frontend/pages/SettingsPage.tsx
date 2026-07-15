// content/frontend/pages/SettingsPage.tsx
import { useEffect, useState } from "react";
import { Card } from "../../../shared/frontend/ui/card";
import { Label } from "../../../shared/frontend/ui/label";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { Select } from "../../../shared/frontend/ui/select";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { api } from "../lib/api";

export function SettingsPage() {
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [currentProvider, setCurrentProvider] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.llmCredentials.get().then((res) => setCurrentProvider(res.credentials?.provider ?? null)).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!apiKey) return;
    setSaving(true);
    try {
      await api.llmCredentials.save(provider, apiKey);
      setCurrentProvider(provider);
      setApiKey("");
      toast({ title: "BYOK key saved" });
    } catch (e) {
      toast({ title: "Failed to save key", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Content Generation Settings</h1>
      <Card className="p-6 space-y-4">
        <p className="text-sm text-muted-foreground">
          {currentProvider
            ? `Currently using your own ${currentProvider} key for generation.`
            : "No key configured — generation falls back to a free built-in model."}
        </p>
        <div>
          <Label className="text-xs block mb-1">Provider</Label>
          <Select value={provider} onChange={(e: any) => setProvider(e.target.value)} className="w-full text-sm">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">API Key</Label>
          <Input type="password" value={apiKey} onChange={(e: any) => setApiKey(e.target.value)} placeholder="sk-..." className="w-full text-sm" />
        </div>
        <Button onClick={handleSave} disabled={saving || !apiKey}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </Card>
    </div>
  );
}
