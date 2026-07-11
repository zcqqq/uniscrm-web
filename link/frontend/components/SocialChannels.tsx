import { useState, useEffect, useMemo } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../shared/frontend/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../shared/frontend/ui/dialog";
import { ChannelCard } from "./ChannelCard";
import { useXChannel } from "../hooks/useXChannel";
import { useSimpleChannel } from "../hooks/useSimpleChannel";
import { useLocale } from "../hooks/useLocale";
import { SIMPLE_CHANNELS, type SimpleChannelConfig } from "../lib/channelRegistry";
import { XLogo } from "../lib/channelLogos";
import { api } from "../lib/api";
import type { Locale } from "../../../metadata/locale";

// ─── X (managed app) — bespoke: re-auth flow instead of plain disconnect ────

function XChannelCard({ locale }: { locale: Locale }) {
  const { connected, username, createdAt, hasByok, loading, connect } = useXChannel();
  const [reauthOpen, setReauthOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const status = loading ? "loading" : connected ? "connected" : "disconnected";

  function handleConnectClick() {
    if (hasByok) {
      setConnectOpen(true);
    } else {
      connect();
    }
  }

  return (
    <>
      <ChannelCard
        logo={<XLogo />}
        name="X"
        tagline={{
          en: "Sync follower data and receive real-time events and DMs via UniSCRM's managed X app.",
          zh: "通过UniSCRM托管的X应用同步粉丝数据、接收实时事件和私信。",
        }}
        locale={locale}
        status={status}
        statusLabel={connected && username ? `@${username}` : undefined}
        createdAt={connected ? createdAt : undefined}
        actions={
          connected ? (
            <Button variant="destructive" className="w-full" onClick={() => setReauthOpen(true)}>
              Re-connect
            </Button>
          ) : (
            <Button className="w-full" onClick={handleConnectClick} disabled={loading}>
              Connect X
            </Button>
          )
        }
      />

      <AlertDialog open={reauthOpen} onOpenChange={setReauthOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-connect X</AlertDialogTitle>
            <AlertDialogDescription>
              即将重新授权此 X channel，继续跳转到 X OAuth？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={connect}>继续</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={connectOpen} onOpenChange={setConnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect X</AlertDialogTitle>
            <AlertDialogDescription>
              当前已有 X (BYOK) channel。连接托管账号后将使用 UniSCRM 共享应用凭证，继续跳转到 X OAuth？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={connect}>继续</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── X BYOK — bespoke: multi-app CRUD + credential form ─────────────────────

interface ByokChannel {
  id: string;
  username: string | null;
  x_user_id: string | null;
  authorized: boolean;
  created_at: string;
}

function XByokChannelCard({ locale }: { locale: Locale }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
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
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await api.channels.byokDelete(id);
    setChannels(channels.filter((c) => c.id !== id));
  }

  const connectedChannel = channels.find((c) => c.authorized);
  const pendingChannel = channels.find((c) => !c.authorized);
  const activeChannel = connectedChannel ?? pendingChannel;

  const cardStatus = connectedChannel ? "connected" as const
    : pendingChannel ? "pending" as const
    : "disconnected" as const;

  return (
    <>
      <ChannelCard
        logo={<XLogo />}
        name="X (BYOK)"
        tagline={{
          en: "Use your own X developer app (Bring Your Own Key) for full control and an independent webhook.",
          zh: "使用自己的 X 开发者应用（Bring Your Own Key）获得完整控制权和独立 Webhook。",
        }}
        locale={locale}
        status={cardStatus}
        statusLabel={connectedChannel?.username ? `@${connectedChannel.username}` : undefined}
        createdAt={activeChannel?.created_at}
        actions={
          !activeChannel ? (
            <Button className="w-full" variant="outline" onClick={() => setDialogOpen(true)}>
              Add App
            </Button>
          ) : pendingChannel ? (
            <Button
              className="w-full"
              onClick={() => { window.location.href = `/api/auth/x/connect?channelId=${pendingChannel.id}`; }}
            >
              Authorize
            </Button>
          ) : (
            <Button
              variant="destructive"
              className="w-full"
              onClick={() => handleDelete(connectedChannel!.id)}
            >
              Disconnect
            </Button>
          )
        }
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XLogo />
              X (BYOK) — New App
            </DialogTitle>
            <DialogDescription>
              输入你的 X Developer App 凭证以连接自己的应用。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground">
                Step 1 — 复制以下 URL 到 X Developer Console
              </p>
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">Webhook URL</label>
                <Input
                  value={webhookUrl}
                  readOnly
                  className="text-xs h-8 font-mono"
                  onClick={(e: React.MouseEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">Redirect URL (OAuth 2.0)</label>
                <Input
                  value={redirectUrl}
                  readOnly
                  className="text-xs h-8 font-mono"
                  onClick={(e: React.MouseEvent<HTMLInputElement>) => (e.target as HTMLInputElement).select()}
                />
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">
                Step 2 — 填写应用凭证
              </p>
              <Input
                placeholder="Client ID (OAuth 2.0)"
                value={clientId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="Client Secret"
                type="password"
                value={clientSecret}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="Consumer Secret (API Key Secret)"
                type="password"
                value={consumerSecret}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConsumerSecret(e.target.value)}
                className="h-9 text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" className="flex-none" onClick={() => setDialogOpen(false)}>
                取消
              </Button>
              <Button
                className="flex-1"
                onClick={handleSaveAndAuthorize}
                disabled={saving || !clientId || !clientSecret || !consumerSecret}
              >
                {saving ? "保存中…" : "Save & Authorize"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Generic simple channel — data-driven, one component for all future channels ──

function SimpleChannelCard({ config, locale }: { config: SimpleChannelConfig; locale: Locale }) {
  const { connected, displayName, createdAt, loading, disconnect } = useSimpleChannel(config.type, config.displayField);

  const status = loading ? "loading" as const : connected ? "connected" as const : "disconnected" as const;

  return (
    <ChannelCard
      logo={config.logo}
      name={config.name}
      tagline={config.tagline}
      locale={locale}
      status={status}
      statusLabel={connected && displayName ? displayName : undefined}
      createdAt={connected ? createdAt : undefined}
      actions={
        connected ? (
          <Button variant="destructive" className="w-full" onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={() => { window.location.href = config.connectPath; }}
            disabled={loading}
          >
            Connect {config.name}
          </Button>
        )
      }
    />
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function SocialChannels() {
  const { locale } = useLocale();
  return (
    <>
      <XChannelCard locale={locale} />
      <XByokChannelCard locale={locale} />
      {SIMPLE_CHANNELS.map((cfg) => (
        <SimpleChannelCard key={cfg.type} config={cfg} locale={locale} />
      ))}
    </>
  );
}
