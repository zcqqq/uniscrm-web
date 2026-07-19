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
import { useYouTubeAccount } from "../hooks/useYouTubeAccount";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { SIMPLE_CHANNELS, type SimpleChannelConfig } from "../lib/channelRegistry";
import { XLogo } from "../lib/channelLogos";
import { api } from "../lib/api";
import type { Locale } from "../../../metadata/locale";
import { useTier } from "../../../shared/frontend/useTier";
import { canUseFeature } from "../../../shared/plans";
import { UpgradeIcon } from "../../../shared/frontend/UpgradeIcon";
import { URLS } from "../../../shared/frontend/urls";

// ─── X (managed app) — bespoke: re-auth flow instead of plain disconnect ────

function XChannelCard({ locale }: { locale: Locale }) {
  const { connected, username, createdAt, hasByok, loading, connect } = useXChannel();
  const [reauthOpen, setReauthOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const tier = useTier();
  const canConnectX = tier ? canUseFeature(tier, "link.x") : true;

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
        helpUrl="https://cobalt-fountain-6cf.notion.site/X-39a7ddccdac980fdb22ecba12c7b64bc"
        status={status}
        statusLabel={connected && username ? `@${username}` : undefined}
        createdAt={connected ? createdAt : undefined}
        actions={
          connected ? (
            <Button variant="destructive" className="w-full" onClick={() => setReauthOpen(true)}>
              Re-connect
            </Button>
          ) : !canConnectX ? (
            <div className="flex items-center gap-2 w-full">
              <Button className="flex-1 opacity-40 cursor-default" disabled>
                Connect X
              </Button>
              <UpgradeIcon webUrl={URLS.web} />
            </div>
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
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<ByokChannel[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [error, setError] = useState("");

  const preChannelId = useMemo(() => crypto.randomUUID(), []);
  const targetChannelId = editingChannelId ?? preChannelId;
  const webhookUrl = `${window.location.origin}/x/webhook/${targetChannelId}`;
  const redirectUrl = `${window.location.origin}/api/auth/x/callback`;

  useEffect(() => { loadChannels(); }, []);

  async function loadChannels() {
    try {
      const list = await api.channels.byokList();
      setChannels(list);
    } catch { /* ignore */ }
  }

  function openCreateDialog() {
    setEditingChannelId(null);
    setClientId("");
    setClientSecret("");
    setConsumerSecret("");
    setError("");
    setDialogOpen(true);
  }

  function openEditDialog(channelId: string) {
    setEditingChannelId(channelId);
    setClientId("");
    setClientSecret("");
    setConsumerSecret("");
    setError("");
    setDialogOpen(true);
  }

  async function handleSaveAndAuthorize() {
    setError("");
    setSaving(true);
    try {
      const result = await api.channels.byokCreate({
        channel_id: targetChannelId,
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
          en: "More features, cost of your own. Use your own X developer app (Bring Your Own Key).",
          zh: "使用自己的 X 开发者应用（Bring Your Own Key）获得完整控制权和独立 Webhook。",
        }}
        locale={locale}
        helpUrl="https://cobalt-fountain-6cf.notion.site/X-BYOK-39a7ddccdac98043be81e1dbf211c9b9"
        status={cardStatus}
        statusLabel={connectedChannel?.username ? `@${connectedChannel.username}` : undefined}
        createdAt={activeChannel?.created_at}
        actions={
          !activeChannel ? (
            <Button className="w-full" variant="outline" onClick={openCreateDialog}>
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
            <div className="flex flex-col gap-2 w-full">
              <Button variant="outline" className="w-full" onClick={() => setReauthOpen(true)}>
                重新授权
              </Button>
              <Button variant="outline" className="w-full" onClick={() => openEditDialog(connectedChannel!.id)}>
                编辑凭证
              </Button>
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => handleDelete(connectedChannel!.id)}
              >
                Disconnect
              </Button>
            </div>
          )
        }
      />

      <AlertDialog open={reauthOpen} onOpenChange={setReauthOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重新授权 X (BYOK)</AlertDialogTitle>
            <AlertDialogDescription>
              适用于刷新令牌已失效（如需要重新登录）等情况。将使用已保存的 App 凭证重新跳转到 X OAuth，继续？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { window.location.href = `/api/auth/x/connect?channelId=${connectedChannel!.id}`; }}
            >
              继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XLogo />
              {editingChannelId ? "X (BYOK) — 编辑凭证" : "X (BYOK) — New App"}
            </DialogTitle>
            <DialogDescription>
              {editingChannelId
                ? "更新此 App 的凭证（无法回显已保存的旧值，需重新填写全部三项）。保存后需重新授权才能生效。"
                : "输入你的 X Developer App 凭证以连接自己的应用。如果该 X 账号已通过其他方式连接（如托管应用），授权后会自动切换为此 BYOK 连接。"}
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
      helpUrl={config.helpUrl}
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

// ─── YouTube — bespoke: OAuth connect + subscription count ──

function YouTubeAccountCard({ locale }: { locale: Locale }) {
  const { connected, email, syncStatus, subscriptionCount, createdAt, connect, disconnect } = useYouTubeAccount();

  const status = !connected ? "disconnected" : syncStatus === "pending" ? "pending" : "connected";

  return (
    <ChannelCard
      logo={<span className="text-2xl leading-none">▶️</span>}
      name="YouTube"
      tagline={{
        en: "Connect your YouTube account — pick which subscriptions to watch from a flow's trigger.",
        zh: "连接你的YouTube账号——在flow的trigger里选择要监控的订阅频道。",
      }}
      locale={locale}
      status={status}
      statusLabel={connected && email ? email : undefined}
      createdAt={connected ? createdAt : undefined}
      extra={
        !connected ? undefined : syncStatus === "pending" ? (
          <p className="text-xs text-muted-foreground">Syncing your subscriptions…</p>
        ) : syncStatus === "error" ? (
          <p className="text-xs text-destructive">Failed to sync subscriptions — try reconnecting.</p>
        ) : (
          <p className="text-xs text-muted-foreground">{subscriptionCount} subscription{subscriptionCount === 1 ? "" : "s"} available</p>
        )
      }
      actions={
        connected ? (
          <Button variant="destructive" className="w-full" onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button className="w-full" onClick={connect}>
            Connect YouTube
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
      <YouTubeAccountCard locale={locale} />
      {SIMPLE_CHANNELS.map((cfg) => (
        <SimpleChannelCard key={cfg.type} config={cfg} locale={locale} />
      ))}
    </>
  );
}
