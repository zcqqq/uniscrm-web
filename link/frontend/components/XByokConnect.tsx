import { useState, useEffect, useMemo } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Input } from "../../../shared/frontend/ui/input";
import { api } from "../lib/api";

function XIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

interface ByokChannel {
  id: string;
  username: string | null;
  x_user_id: string | null;
  authorized: boolean;
}

export function XByokConnect() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ByokChannel[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [error, setError] = useState("");

  const preChannelId = useMemo(() => crypto.randomUUID(), []);
  const webhookUrl = `${window.location.origin}/x/webhook/${preChannelId}`;
  const redirectUrl = `${window.location.origin}/api/auth/x/callback`;

  useEffect(() => { loadChannels(); }, []);

  async function loadChannels() {
    try {
      const list = await api.channels.byokList();
      setChannels(list);
    } catch { /* ignore */ }
  }

  async function handleSaveAndAuthorize() {
    setError("");
    setLoading(true);
    try {
      const result = await api.channels.byokCreate({
        channel_id: preChannelId,
        client_id: clientId,
        client_secret: clientSecret,
        consumer_secret: consumerSecret,
      });
      window.location.href = `/api/auth/x/connect?channelId=${result.channel_id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await api.channels.byokDelete(id);
    setChannels(channels.filter((c) => c.id !== id));
  }

  if (!expanded) {
    return (
      <Card className="border-dashed border-2 border-border">
        <CardContent className="p-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <XIcon />
            <span className="text-sm font-medium text-foreground">X (BYOK)</span>
          </div>
          <p className="text-muted-foreground text-xs mb-3">
            Use your own X Developer App
          </p>

          {channels.length > 0 && (
            <div className="space-y-2 mb-3 text-left">
              {channels.map((ch) => (
                <div key={ch.id} className="flex items-center justify-between text-sm border rounded p-2">
                  <span className="text-muted-foreground">
                    {ch.authorized ? `@${ch.username}` : "Pending auth"}
                  </span>
                  <div className="flex gap-1">
                    {!ch.authorized && (
                      <Button variant="outline" size="sm" onClick={() => {
                        window.location.href = `/api/auth/x/connect?channelId=${ch.id}`;
                      }}>
                        Authorize
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDelete(ch.id)}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
            Add App
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <XIcon />
          <span className="text-sm font-medium">X (BYOK) — New App</span>
        </div>

        <div className="space-y-3 rounded border p-3 bg-muted/30">
          <p className="text-xs font-medium text-muted-foreground">
            Step 1: Copy these URLs to your X Developer Console
          </p>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Webhook URL</label>
            <Input value={webhookUrl} readOnly className="text-xs h-8" onClick={(e: React.MouseEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()} />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Redirect URL (OAuth 2.0)</label>
            <Input value={redirectUrl} readOnly className="text-xs h-8" onClick={(e: React.MouseEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()} />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Step 2: Enter your app credentials
          </p>
          <Input
            placeholder="Client ID (OAuth 2.0)"
            value={clientId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
            className="h-8 text-sm"
          />
          <Input
            placeholder="Client Secret"
            type="password"
            value={clientSecret}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)}
            className="h-8 text-sm"
          />
          <Input
            placeholder="Consumer Secret (API Key Secret)"
            type="password"
            value={consumerSecret}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConsumerSecret(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={handleSaveAndAuthorize}
            disabled={loading || !clientId || !clientSecret || !consumerSecret}
          >
            {loading ? "Saving..." : "Save & Authorize"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
