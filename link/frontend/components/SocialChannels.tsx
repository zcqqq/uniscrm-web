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
import { XIcon, YouTubeIcon } from "../../../shared/frontend/ui/icons";
import { api } from "../lib/api";
import type { Locale } from "../../../metadata/locale";
import { t } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { useTier } from "../../../shared/frontend/useTier";
import { canUseFeature } from "../../../shared/plans";
import { UpgradeIcon } from "../../../shared/frontend/UpgradeIcon";
import { URLS } from "../../../shared/frontend/urls";

// ─── Shared copy (dialog chrome reused across channel cards) ────────────────

const COMMON: Record<string, LocalizedString> = {
  cancel: { en: "Cancel", zh: "取消" },
  continue: { en: "Continue", zh: "继续" },
  connect: { en: "Connect", zh: "连接" },
  disconnect: { en: "Disconnect", zh: "断开连接" },
};

// ─── X (managed app) — bespoke: re-auth flow instead of plain disconnect ────

const X_STRINGS = {
  reconnectButton: { en: "Re-connect", zh: "重新连接" } as LocalizedString,
  reconnectTitle: { en: "Re-connect X", zh: "重新连接 X" } as LocalizedString,
  reconnectDescription: {
    en: "This will re-authorize this X channel. Continue to X OAuth?",
    zh: "即将重新授权此 X channel，继续跳转到 X OAuth？",
  } as LocalizedString,
  connectButton: { en: "Connect X", zh: "连接 X" } as LocalizedString,
  connectTitle: { en: "Connect X", zh: "连接 X" } as LocalizedString,
  connectDescription: {
    en: "You already have an X (BYOK) channel. Connecting the managed account will switch to UniSCRM's shared app credentials. Continue to X OAuth?",
    zh: "当前已有 X (BYOK) channel。连接托管账号后将使用 UniSCRM 共享应用凭证，继续跳转到 X OAuth？",
  } as LocalizedString,
};

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
        logo={<XIcon className="w-8 h-8" />}
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
              {t(X_STRINGS.reconnectButton, locale)}
            </Button>
          ) : !canConnectX ? (
            <div className="flex items-center gap-2 w-full">
              <Button className="flex-1 opacity-40 cursor-default" disabled>
                {t(X_STRINGS.connectButton, locale)}
              </Button>
              <UpgradeIcon webUrl={URLS.web} />
            </div>
          ) : (
            <Button className="w-full" onClick={handleConnectClick} disabled={loading}>
              {t(X_STRINGS.connectButton, locale)}
            </Button>
          )
        }
      />

      <AlertDialog open={reauthOpen} onOpenChange={setReauthOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(X_STRINGS.reconnectTitle, locale)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(X_STRINGS.reconnectDescription, locale)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(COMMON.cancel, locale)}</AlertDialogCancel>
            <AlertDialogAction onClick={connect}>{t(COMMON.continue, locale)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={connectOpen} onOpenChange={setConnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(X_STRINGS.connectTitle, locale)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(X_STRINGS.connectDescription, locale)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(COMMON.cancel, locale)}</AlertDialogCancel>
            <AlertDialogAction onClick={connect}>{t(COMMON.continue, locale)}</AlertDialogAction>
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

const BYOK_STRINGS = {
  addApp: { en: "Add App", zh: "添加应用" } as LocalizedString,
  authorize: { en: "Authorize", zh: "授权" } as LocalizedString,
  reauthorizeButton: { en: "Re-authorize", zh: "重新授权" } as LocalizedString,
  editCredentialsButton: { en: "Edit Credentials", zh: "编辑凭证" } as LocalizedString,
  reauthorizeTitle: { en: "Re-authorize X (BYOK)", zh: "重新授权 X (BYOK)" } as LocalizedString,
  reauthorizeDescription: {
    en: "Use this if the refresh token has expired (e.g. needs re-login). This will redirect to X OAuth using the saved app credentials. Continue?",
    zh: "适用于刷新令牌已失效（如需要重新登录）等情况。将使用已保存的 App 凭证重新跳转到 X OAuth，继续？",
  } as LocalizedString,
  dialogTitleEdit: { en: "X (BYOK) — Edit Credentials", zh: "X (BYOK) — 编辑凭证" } as LocalizedString,
  dialogTitleNew: { en: "X (BYOK) — New App", zh: "X (BYOK) — 新建应用" } as LocalizedString,
  dialogDescriptionEdit: {
    en: "Update this app's credentials (saved values can't be shown again — re-enter all four). You'll need to re-authorize after saving.",
    zh: "更新此 App 的凭证（无法回显已保存的旧值，需重新填写全部四项）。保存后需重新授权才能生效。",
  } as LocalizedString,
  dialogDescriptionNew: {
    en: "Enter your X Developer App credentials to connect your own app. If this X account is already connected another way (e.g. the managed app), authorizing will switch it to this BYOK connection.",
    zh: "输入你的 X Developer App 凭证以连接自己的应用。如果该 X 账号已通过其他方式连接（如托管应用），授权后会自动切换为此 BYOK 连接。",
  } as LocalizedString,
  step1: { en: "Step 1 — Copy these URLs into the X Developer Console", zh: "Step 1 — 复制以下 URL 到 X Developer Console" } as LocalizedString,
  step2: { en: "Step 2 — Enter your app credentials", zh: "Step 2 — 填写应用凭证" } as LocalizedString,
  failed: { en: "Failed", zh: "失败" } as LocalizedString,
  saveAndAuthorize: { en: "Save & Authorize", zh: "保存并授权" } as LocalizedString,
  saving: { en: "Saving…", zh: "保存中…" } as LocalizedString,
};

function XByokChannelCard({ locale }: { locale: Locale }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<ByokChannel[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [bearerToken, setBearerToken] = useState("");
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
        bearer_token: bearerToken,
      });
      window.location.href = `/api/auth/x/connect?channelId=${result.channel_id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : t(BYOK_STRINGS.failed, locale));
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
        logo={<XIcon className="w-8 h-8" />}
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
              {t(BYOK_STRINGS.addApp, locale)}
            </Button>
          ) : pendingChannel ? (
            <Button
              className="w-full"
              onClick={() => { window.location.href = `/api/auth/x/connect?channelId=${pendingChannel.id}`; }}
            >
              {t(BYOK_STRINGS.authorize, locale)}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 w-full">
              <Button variant="outline" className="w-full" onClick={() => setReauthOpen(true)}>
                {t(BYOK_STRINGS.reauthorizeButton, locale)}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => openEditDialog(connectedChannel!.id)}>
                {t(BYOK_STRINGS.editCredentialsButton, locale)}
              </Button>
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => handleDelete(connectedChannel!.id)}
              >
                {t(COMMON.disconnect, locale)}
              </Button>
            </div>
          )
        }
      />

      <AlertDialog open={reauthOpen} onOpenChange={setReauthOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(BYOK_STRINGS.reauthorizeTitle, locale)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(BYOK_STRINGS.reauthorizeDescription, locale)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(COMMON.cancel, locale)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { window.location.href = `/api/auth/x/connect?channelId=${connectedChannel!.id}`; }}
            >
              {t(COMMON.continue, locale)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XIcon className="w-8 h-8" />
              {t(editingChannelId ? BYOK_STRINGS.dialogTitleEdit : BYOK_STRINGS.dialogTitleNew, locale)}
            </DialogTitle>
            <DialogDescription>
              {t(editingChannelId ? BYOK_STRINGS.dialogDescriptionEdit : BYOK_STRINGS.dialogDescriptionNew, locale)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/30">
              <p className="text-xs font-medium text-muted-foreground">
                {t(BYOK_STRINGS.step1, locale)}
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
                {t(BYOK_STRINGS.step2, locale)}
              </p>
              {/* Same order as the X Developer Portal's "Keys and tokens" page, and each
                  placeholder names the section it is copied from — Consumer Secret and Client
                  Secret are easy to swap, and doing so fails much later (the webhook's CRC
                  challenge) with an error that says nothing about which field was wrong. */}
              <Input
                placeholder="App-Only Authentication Bearer Token"
                type="password"
                value={bearerToken}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBearerToken(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="Consumer Key Secret (not the Consumer Key)"
                type="password"
                value={consumerSecret}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConsumerSecret(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="OAuth 2.0 Client ID"
                value={clientId}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)}
                className="h-9 text-sm"
              />
              <Input
                placeholder="OAuth 2.0 Client Secret"
                type="password"
                value={clientSecret}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)}
                className="h-9 text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <Button variant="ghost" className="flex-none" onClick={() => setDialogOpen(false)}>
                {t(COMMON.cancel, locale)}
              </Button>
              <Button
                className="flex-1"
                onClick={handleSaveAndAuthorize}
                disabled={saving || !clientId || !clientSecret || !consumerSecret || !bearerToken}
              >
                {saving ? t(BYOK_STRINGS.saving, locale) : t(BYOK_STRINGS.saveAndAuthorize, locale)}
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
            {t(COMMON.disconnect, locale)}
          </Button>
        ) : (
          <Button
            className="w-full"
            onClick={() => { window.location.href = config.connectPath; }}
            disabled={loading}
          >
            {t(COMMON.connect, locale)} {config.name}
          </Button>
        )
      }
    />
  );
}

// ─── YouTube — bespoke: OAuth connect + subscription count ──

const YOUTUBE_STRINGS = {
  connectButton: { en: "Connect YouTube", zh: "连接 YouTube" } as LocalizedString,
  syncing: { en: "Syncing your subscriptions…", zh: "正在同步你的订阅…" } as LocalizedString,
  syncFailed: { en: "Failed to sync subscriptions — try reconnecting.", zh: "订阅同步失败，请尝试重新连接。" } as LocalizedString,
};

function YouTubeAccountCard({ locale }: { locale: Locale }) {
  const { connected, email, channelTitle, syncStatus, subscriptionCount, createdAt, connect, disconnect } = useYouTubeAccount();

  const status = !connected ? "disconnected" : syncStatus === "pending" ? "pending" : "connected";
  // channelTitle is the channel's own public name (fetched via channels.list at connect
  // time) — email is the Google login identity, which for a Brand Account is a synthetic
  // "xxx@pages.plusgoogle.com" placeholder rather than anything recognizable. Prefer the
  // title; fall back to email only for channels connected before this field existed
  // (they'll pick up channelTitle on their next reconnect).
  const displayLabel = channelTitle || email;

  return (
    <ChannelCard
      logo={<YouTubeIcon className="w-8 h-8" />}
      name="YouTube"
      tagline={{
        en: "Connect your YouTube account — pick which subscriptions to watch from a flow's trigger.",
        zh: "连接你的YouTube账号——在flow的trigger里选择要监控的订阅频道。",
      }}
      locale={locale}
      status={status}
      statusLabel={connected && displayLabel ? displayLabel : undefined}
      createdAt={connected ? createdAt : undefined}
      extra={
        !connected ? undefined : syncStatus === "pending" ? (
          <p className="text-xs text-muted-foreground">{t(YOUTUBE_STRINGS.syncing, locale)}</p>
        ) : syncStatus === "error" ? (
          <p className="text-xs text-destructive">{t(YOUTUBE_STRINGS.syncFailed, locale)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {locale === "zh"
              ? `${subscriptionCount} 个可用订阅`
              : `${subscriptionCount} subscription${subscriptionCount === 1 ? "" : "s"} available`}
          </p>
        )
      }
      actions={
        connected ? (
          <Button variant="destructive" className="w-full" onClick={disconnect}>
            {t(COMMON.disconnect, locale)}
          </Button>
        ) : (
          <Button className="w-full" onClick={connect}>
            {t(YOUTUBE_STRINGS.connectButton, locale)}
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
